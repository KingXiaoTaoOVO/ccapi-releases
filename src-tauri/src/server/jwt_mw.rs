use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header;
use axum::middleware::Next;
use axum::response::Response;
use chrono::Utc;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

use super::auth::Claims;
use super::error::{ApiError, ApiResult};
use super::AppState;

pub const API_TOKEN_PREFIX: &str = "sk-ccapi-";

#[derive(Clone)]
pub struct UserContext {
    pub user_id: i64,
    #[allow(dead_code)]
    pub role: String,
    pub permissions: HashSet<String>,
    pub jti: String,
    /// 若本次请求是用 api_tokens 表里的令牌鉴权的，记录 token.id 给 relay 做扣费。
    #[allow(dead_code)]
    pub token_id: Option<i64>,
    /// token 上挂的模型白名单（如果配置了），relay 在路由前用这个二次校验。
    #[allow(dead_code)]
    pub token_models_allowed: Option<Vec<String>>,
}

impl UserContext {
    pub fn has(&self, perm: &str) -> bool {
        self.permissions.contains("*") || self.permissions.contains(perm)
    }

    pub fn require(&self, perm: &str) -> ApiResult<()> {
        if self.has(perm) {
            Ok(())
        } else {
            Err(ApiError::Forbidden(format!("缺少权限: {perm}")))
        }
    }
}

/// axum 中间件：从 Authorization: Bearer <jwt | sk-ccapi-...> 解析 → 注入 UserContext。
/// 同时检查 Redis 中的踢出黑名单（如果 jti 在黑名单则拒绝）。
pub async fn jwt_layer(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let raw = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        // 还接受 x-api-key（OpenAI/Anthropic 客户端常用）
        .or_else(|| {
            req.headers()
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim())
        })
        .ok_or(ApiError::Unauthorized)?
        .to_string();
    let token = raw
        .strip_prefix("Bearer ")
        .unwrap_or(&raw)
        .trim()
        .to_string();

    let peer = peer_ip(&req);
    let ctx = if token.starts_with(API_TOKEN_PREFIX) {
        verify_api_token(&state, &token, peer).await?
    } else {
        verify_jwt(&state, &token).await?
    };

    // 三级速率限制
    check_rate_limits(&state, &ctx).await?;

    req.extensions_mut().insert(ctx);
    Ok(next.run(req).await)
}

// ---------------------------------------------------------------------------
// 三级速率限制：全局 / 单用户 / 单分组
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct RateLimitConfig {
    global_per_min: i64,
    per_user_per_min: i64,
    /// group_id (string) → 每分钟上限
    per_group: std::collections::HashMap<String, i64>,
}

static RATE_LIMIT_CACHE: Lazy<Mutex<Option<(RateLimitConfig, Instant)>>> =
    Lazy::new(|| Mutex::new(None));

async fn load_rate_limits(state: &AppState) -> RateLimitConfig {
    async fn read_i64(state: &AppState, key: &str, default: i64) -> i64 {
        let row: Option<(sqlx::types::Json<serde_json::Value>,)> =
            sqlx::query_as("SELECT v FROM config_kv WHERE k = ?")
                .bind(key)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
        row.and_then(|(j,)| j.0.as_i64()).unwrap_or(default)
    }
    let global = read_i64(state, "api_rate_per_minute", 0).await;
    let per_user = read_i64(state, "rate_limit_per_user_per_minute", 0).await;
    let group_row: Option<(sqlx::types::Json<serde_json::Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'rate_limit_per_group_per_minute'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let mut per_group = std::collections::HashMap::new();
    if let Some((sqlx::types::Json(serde_json::Value::Object(obj)),)) = group_row {
        for (k, v) in obj {
            if let Some(n) = v.as_i64() {
                per_group.insert(k, n);
            }
        }
    }
    RateLimitConfig {
        global_per_min: global,
        per_user_per_min: per_user,
        per_group,
    }
}

async fn rate_limit_config(state: &AppState) -> RateLimitConfig {
    {
        let g = RATE_LIMIT_CACHE.lock().ok();
        if let Some(g) = g {
            if let Some((cfg, until)) = &*g {
                if Instant::now() < *until {
                    return cfg.clone();
                }
            }
        }
    }
    let cfg = load_rate_limits(state).await;
    if let Ok(mut g) = RATE_LIMIT_CACHE.lock() {
        *g = Some((cfg.clone(), Instant::now() + Duration::from_secs(10)));
    }
    cfg
}

async fn check_rate_limits(state: &AppState, ctx: &UserContext) -> Result<(), ApiError> {
    let cfg = rate_limit_config(state).await;
    let bucket = Utc::now().timestamp() / 60;
    let mut conn = state.redis.clone();

    async fn check_one(
        conn: &mut redis::aio::ConnectionManager,
        key: &str,
        limit: i64,
    ) -> Result<(), ApiError> {
        if limit <= 0 {
            return Ok(());
        }
        let count: i64 = redis::cmd("INCR").arg(key).query_async(conn).await?;
        if count == 1 {
            let _: i64 = redis::cmd("EXPIRE").arg(key).arg(70).query_async(conn).await?;
        }
        if count > limit {
            return Err(ApiError::TooManyRequests);
        }
        Ok(())
    }

    if cfg.global_per_min > 0 {
        check_one(&mut conn, &format!("rl:global:{bucket}"), cfg.global_per_min).await?;
    }
    if cfg.per_user_per_min > 0 {
        check_one(
            &mut conn,
            &format!("rl:user:{}:{}", ctx.user_id, bucket),
            cfg.per_user_per_min,
        )
        .await?;
    }
    if !cfg.per_group.is_empty() {
        // 查用户分组
        let group_id: Option<i64> = sqlx::query_as::<_, (Option<i64>,)>(
            "SELECT group_id FROM users WHERE id = ?",
        )
        .bind(ctx.user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|(g,)| g);
        if let Some(gid) = group_id {
            if let Some(limit) = cfg.per_group.get(&gid.to_string()).copied() {
                check_one(
                    &mut conn,
                    &format!("rl:group:{}:{}", gid, bucket),
                    limit,
                )
                .await?;
            }
        }
    }
    Ok(())
}

async fn verify_jwt(state: &AppState, token: &str) -> Result<UserContext, ApiError> {
    let claims: Claims = state.jwt.decode(token)?;
    if claims.typ != "access" {
        return Err(ApiError::Unauthorized);
    }

    // 黑名单 / 踢出检查
    let mut conn = state.redis.clone();
    let kicked: Option<i32> = redis::cmd("EXISTS")
        .arg(format!("kicked:{}", claims.jti))
        .query_async(&mut conn)
        .await
        .ok();
    if kicked.unwrap_or(0) > 0 {
        return Err(ApiError::Unauthorized);
    }

    let perms_json: Option<sqlx::types::Json<Vec<String>>> = sqlx::query_scalar(
        "SELECT permissions FROM roles WHERE name = ?",
    )
    .bind(&claims.role)
    .fetch_optional(&state.db)
    .await?;
    let permissions: HashSet<String> = perms_json
        .map(|j| j.0.into_iter().collect())
        .unwrap_or_default();

    Ok(UserContext {
        user_id: claims.sub,
        role: claims.role.clone(),
        permissions,
        jti: claims.jti.clone(),
        token_id: None,
        token_models_allowed: None,
    })
}

#[derive(sqlx::FromRow)]
struct TokenAuthRow {
    id: i64,
    user_id: i64,
    role: String,
    quota_usd: Option<bigdecimal::BigDecimal>,
    used_usd: bigdecimal::BigDecimal,
    models_allowed: Option<sqlx::types::Json<serde_json::Value>>,
    ip_whitelist: Option<sqlx::types::Json<serde_json::Value>>,
    expires_at: Option<chrono::NaiveDateTime>,
    revoked: i8,
}

async fn verify_api_token(
    state: &AppState,
    token: &str,
    peer: Option<IpAddr>,
) -> Result<UserContext, ApiError> {
    use bigdecimal::ToPrimitive;
    let hash = sha256_hex(token);

    let row: Option<TokenAuthRow> = sqlx::query_as(
        "SELECT t.id, t.user_id, r.name AS role, t.quota_usd, t.used_usd, \
         t.models_allowed, t.ip_whitelist, t.expires_at, t.revoked \
         FROM api_tokens t \
         JOIN users u ON u.id = t.user_id \
         JOIN roles r ON r.id = u.role_id \
         WHERE t.key_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::Unauthorized)?;

    if row.revoked != 0 {
        return Err(ApiError::Forbidden("令牌已被撤销".into()));
    }
    if let Some(exp) = row.expires_at {
        if exp < chrono::Utc::now().naive_utc() {
            return Err(ApiError::Forbidden("令牌已过期".into()));
        }
    }
    let used_f = row.used_usd.to_f64().unwrap_or(0.0);
    if let Some(q) = row.quota_usd.as_ref() {
        let limit = q.to_f64().unwrap_or(0.0);
        if limit > 0.0 && used_f >= limit {
            return Err(ApiError::QuotaExhausted(format!(
                "令牌额度已用完 ${used_f:.4} / ${limit:.4}"
            )));
        }
    }

    // IP 白名单 — 把 sqlx Json 解构后立刻丢，避免 future 跨越 await 持有引用
    let allow_ips: Vec<String> = match row.ip_whitelist.as_ref().map(|j| &j.0) {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    if !allow_ips.is_empty() {
        let ok = peer
            .as_ref()
            .map(|ip| ip_match_any(ip, &allow_ips))
            .unwrap_or(false);
        if !ok {
            return Err(ApiError::Forbidden(format!(
                "调用 IP {} 不在白名单",
                peer.map(|x| x.to_string()).unwrap_or_else(|| "?".into())
            )));
        }
    }

    let perms_json: Option<sqlx::types::Json<Vec<String>>> = sqlx::query_scalar(
        "SELECT permissions FROM roles WHERE name = ?",
    )
    .bind(&row.role)
    .fetch_optional(&state.db)
    .await?;
    let permissions: HashSet<String> = perms_json
        .map(|j| j.0.into_iter().collect())
        .unwrap_or_default();

    let models_allowed: Option<Vec<String>> = match row.models_allowed {
        Some(sqlx::types::Json(serde_json::Value::Array(arr))) => Some(
            arr.into_iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    };

    Ok(UserContext {
        user_id: row.user_id,
        role: row.role,
        permissions,
        jti: format!("token:{}", row.id),
        token_id: Some(row.id),
        token_models_allowed: models_allowed,
    })
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    hex::encode(out)
}

fn peer_ip(req: &Request) -> Option<IpAddr> {
    // X-Forwarded-For 优先（用户可能挂在反代后面）
    if let Some(xff) = req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            if let Ok(ip) = first.trim().parse() {
                return Some(ip);
            }
        }
    }
    // 否则取 axum 的 ConnectInfo（需要 .into_make_service_with_connect_info<SocketAddr>()）
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
}

fn ip_match_any(ip: &IpAddr, list: &[String]) -> bool {
    for entry in list {
        let e = entry.trim();
        if e.is_empty() {
            continue;
        }
        if let Some((net, prefix)) = e.split_once('/') {
            // 简单 CIDR：支持 IPv4 / IPv6
            if let (Ok(net_ip), Ok(pre)) = (net.parse::<IpAddr>(), prefix.parse::<u8>()) {
                if cidr_contains(&net_ip, pre, ip) {
                    return true;
                }
            }
        } else if let Ok(exact) = e.parse::<IpAddr>() {
            if &exact == ip {
                return true;
            }
        }
    }
    false
}

fn cidr_contains(net: &IpAddr, prefix: u8, target: &IpAddr) -> bool {
    match (net, target) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            if prefix > 32 {
                return false;
            }
            let mask: u32 = if prefix == 0 { 0 } else { (!0u32) << (32 - prefix) };
            (u32::from(*a) & mask) == (u32::from(*b) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => {
            if prefix > 128 {
                return false;
            }
            let ab = a.octets();
            let bb = b.octets();
            let mut bits_left = prefix as usize;
            for (x, y) in ab.iter().zip(bb.iter()) {
                if bits_left >= 8 {
                    if x != y {
                        return false;
                    }
                    bits_left -= 8;
                } else if bits_left == 0 {
                    return true;
                } else {
                    let mask = (!0u8) << (8 - bits_left);
                    return (x & mask) == (y & mask);
                }
            }
            true
        }
        _ => false,
    }
}

