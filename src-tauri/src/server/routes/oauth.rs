//! OAuth2 通用登录 / 绑定。
//!
//! 管理员（config.write）：
//!   GET/POST/PATCH/DELETE /api/admin/oauth/providers   provider CRUD
//!
//! 公开 / 已登录：
//!   GET   /api/oauth/{code}/start            返回 authorize URL（前端跳转）
//!   GET   /api/oauth/{code}/callback         OAuth provider 回调，交换 token + 拉 userinfo
//!                                             - 已绑定 → 用对应用户颁发 JWT
//!                                             - 未绑定 + 已登录 → 绑定到当前用户
//!                                             - 未绑定 + 未登录 → 自动注册新用户
//!   GET   /api/me/oauth/links                我已绑定的 provider
//!   DELETE /api/me/oauth/links/{id}          解绑
//!
//! 安全：state 在 Redis 5 min TTL，单次消费；client_secret 加密存储。

use axum::extract::{Extension, Path, Query, State};
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::NaiveDateTime;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::auth::JwtIssuer;
use crate::server::crypto;
use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn protected_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/oauth/providers",
            get(list_providers).post(create_provider),
        )
        .route(
            "/api/admin/oauth/providers/{id}",
            axum::routing::patch(update_provider).delete(delete_provider),
        )
        .route("/api/oauth/providers", get(list_enabled_providers))
        .route("/api/me/oauth/links", get(list_my_links))
        .route("/api/me/oauth/links/{id}", delete(delete_my_link))
}

pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/oauth/{code}/start", get(oauth_start))
        .route("/api/oauth/{code}/callback", get(oauth_callback))
}

// ============================================================================
// Provider CRUD（管理员）
// ============================================================================

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct ProviderRow {
    id: i64,
    code: String,
    display_name: String,
    client_id: String,
    authorize_url: String,
    token_url: String,
    userinfo_url: String,
    scopes: String,
    enabled: i8,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

async fn list_providers(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let rows: Vec<ProviderRow> = sqlx::query_as(
        "SELECT id, code, display_name, client_id, authorize_url, token_url, \
                userinfo_url, scopes, enabled, created_at, updated_at \
         FROM oauth_providers ORDER BY id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "providers": rows })))
}

/// 已登录用户均可调用：仅返回启用的 provider 的公开字段（id/code/displayName）。
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct ProviderPublicRow {
    id: i64,
    code: String,
    display_name: String,
    enabled: i8,
}

async fn list_enabled_providers(
    State(state): State<AppState>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<ProviderPublicRow> = sqlx::query_as(
        "SELECT id, code, display_name, enabled FROM oauth_providers \
         WHERE enabled = 1 ORDER BY id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "providers": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderBody {
    code: String,
    display_name: String,
    client_id: String,
    /// 明文；写入时加密。编辑时为空 = 保留旧值
    client_secret: Option<String>,
    authorize_url: String,
    token_url: String,
    userinfo_url: String,
    #[serde(default)]
    scopes: String,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

async fn create_provider(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let secret = body
        .client_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::BadRequest("新建必须填 client_secret".into()))?;
    let enc = crypto::encrypt(&state.jwt_secret, secret)
        .map_err(|e| ApiError::Internal(format!("加密失败: {e}")))?;
    let res = sqlx::query(
        "INSERT INTO oauth_providers \
         (code, display_name, client_id, client_secret_encrypted, authorize_url, token_url, \
          userinfo_url, scopes, enabled) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(body.code.trim())
    .bind(body.display_name.trim())
    .bind(body.client_id.trim())
    .bind(&enc)
    .bind(&body.authorize_url)
    .bind(&body.token_url)
    .bind(&body.userinfo_url)
    .bind(&body.scopes)
    .bind(if body.enabled { 1i8 } else { 0 })
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "id": res.last_insert_id() })))
}

async fn update_provider(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    if let Some(secret) = body
        .client_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "********")
    {
        let enc = crypto::encrypt(&state.jwt_secret, secret)
            .map_err(|e| ApiError::Internal(format!("加密失败: {e}")))?;
        sqlx::query(
            "UPDATE oauth_providers SET code=?, display_name=?, client_id=?, \
             client_secret_encrypted=?, authorize_url=?, token_url=?, userinfo_url=?, \
             scopes=?, enabled=? WHERE id=?",
        )
        .bind(body.code.trim())
        .bind(body.display_name.trim())
        .bind(body.client_id.trim())
        .bind(&enc)
        .bind(&body.authorize_url)
        .bind(&body.token_url)
        .bind(&body.userinfo_url)
        .bind(&body.scopes)
        .bind(if body.enabled { 1i8 } else { 0 })
        .bind(id)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query(
            "UPDATE oauth_providers SET code=?, display_name=?, client_id=?, \
             authorize_url=?, token_url=?, userinfo_url=?, scopes=?, enabled=? WHERE id=?",
        )
        .bind(body.code.trim())
        .bind(body.display_name.trim())
        .bind(body.client_id.trim())
        .bind(&body.authorize_url)
        .bind(&body.token_url)
        .bind(&body.userinfo_url)
        .bind(&body.scopes)
        .bind(if body.enabled { 1i8 } else { 0 })
        .bind(id)
        .execute(&state.db)
        .await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_provider(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    sqlx::query("DELETE FROM oauth_providers WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 我的绑定
// ============================================================================

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct LinkRow {
    id: i64,
    provider_code: String,
    external_id: String,
    external_name: Option<String>,
    created_at: Option<NaiveDateTime>,
}

async fn list_my_links(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<LinkRow> = sqlx::query_as(
        "SELECT id, provider_code, external_id, external_name, created_at \
         FROM user_oauth_links WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "links": rows })))
}

async fn delete_my_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let res = sqlx::query("DELETE FROM user_oauth_links WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(ctx.user_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("绑定不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// OAuth dance（公开）
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartQuery {
    /// 回调到该地址完成交换；建议是 CCAPI 服务端的 /api/oauth/<code>/callback
    redirect_uri: String,
    /// 可选：客户端期望成功后跳回的前端地址
    return_to: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ProviderFull {
    code: String,
    client_id: String,
    client_secret_encrypted: String,
    authorize_url: String,
    token_url: String,
    userinfo_url: String,
    scopes: String,
    enabled: i8,
}

async fn provider_by_code(state: &AppState, code: &str) -> ApiResult<ProviderFull> {
    let row: Option<ProviderFull> = sqlx::query_as(
        "SELECT code, client_id, client_secret_encrypted, authorize_url, token_url, \
                userinfo_url, scopes, enabled FROM oauth_providers WHERE code = ?",
    )
    .bind(code)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound(format!("OAuth provider '{code}' 不存在")))?;
    if row.enabled == 0 {
        return Err(ApiError::ServiceUnavailable("该 OAuth provider 已禁用".into()));
    }
    Ok(row)
}

fn random_state() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

async fn oauth_start(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(q): Query<StartQuery>,
) -> ApiResult<Json<Value>> {
    let p = provider_by_code(&state, &code).await?;
    let state_token = random_state();
    let mut redis = state.redis.clone();
    let key = format!("oauth_state:{}", state_token);
    let payload = json!({
        "providerCode": p.code,
        "redirectUri": q.redirect_uri,
        "returnTo": q.return_to,
    });
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(payload.to_string())
        .arg("EX")
        .arg(5 * 60)
        .query_async(&mut redis)
        .await?;

    let mut url = url::Url::parse(&p.authorize_url)
        .map_err(|e| ApiError::Internal(format!("authorize_url 无效: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", &p.client_id)
        .append_pair("redirect_uri", &q.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &p.scopes)
        .append_pair("state", &state_token);
    Ok(Json(json!({
        "ok": true,
        "authorizeUrl": url.to_string(),
        "state": state_token,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallbackQuery {
    code: String,
    state: String,
}

async fn oauth_callback(
    State(state): State<AppState>,
    Path(provider_code): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> ApiResult<Json<Value>> {
    let p = provider_by_code(&state, &provider_code).await?;

    // 校验 + 消费 state
    let mut redis = state.redis.clone();
    let key = format!("oauth_state:{}", q.state);
    let raw: Option<String> = redis::cmd("GETDEL").arg(&key).query_async(&mut redis).await?;
    let raw = raw.ok_or_else(|| ApiError::BadRequest("state 已过期或无效".into()))?;
    let saved: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let redirect_uri = saved
        .get("redirectUri")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadRequest("state 损坏".into()))?;

    // code → token
    let secret = crypto::decrypt_or_plain(&state.jwt_secret, &p.client_secret_encrypted);
    let token_resp: Value = reqwest::Client::new()
        .post(&p.token_url)
        .form(&[
            ("client_id", p.client_id.as_str()),
            ("client_secret", secret.as_str()),
            ("code", q.code.as_str()),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("token 交换失败: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::Internal(format!("token 响应解析失败: {e}")))?;

    let access_token = token_resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ApiError::Internal(format!(
                "上游未返回 access_token：{}",
                token_resp
            ))
        })?
        .to_string();

    // 拉 userinfo
    let userinfo: Value = reqwest::Client::new()
        .get(&p.userinfo_url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Accept", "application/json")
        .header("User-Agent", "CCAPI/1.0")
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("userinfo 失败: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::Internal(format!("userinfo 解析失败: {e}")))?;

    let external_id = first_str(
        &userinfo,
        &["id", "sub", "user_id"],
    )
    .ok_or_else(|| ApiError::Internal("无法从 userinfo 解析 external id".into()))?;
    let external_name = first_str(&userinfo, &["login", "username", "name", "email"]);

    // 查绑定
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT user_id FROM user_oauth_links \
         WHERE provider_code = ? AND external_id = ?",
    )
    .bind(&provider_code)
    .bind(&external_id)
    .fetch_optional(&state.db)
    .await?;

    let user_id = if let Some((uid,)) = row {
        uid
    } else {
        // 创建新用户（用 oauth_{provider}_{external_id} 当唯一 username）
        let username = format!(
            "oauth_{}_{}",
            provider_code,
            sanitize_id(&external_id)
        );
        // 容错：如已经有同名 → 加随机后缀
        let username = ensure_unique_username(&state, &username).await?;
        let pw_hash = crate::server::auth::hash_password(&random_state())
            .map_err(|e| ApiError::Internal(format!("密码哈希失败: {e}")))?;
        let res = sqlx::query(
            "INSERT INTO users (username, password_hash, role_id, status, must_change_password) \
             VALUES (?, ?, 2, 'active', 0)",
        )
        .bind(&username)
        .bind(&pw_hash)
        .execute(&state.db)
        .await?;
        let new_uid = res.last_insert_id() as i64;
        // 给新用户默认额度
        let _ = sqlx::query(
            "INSERT IGNORE INTO user_quota (user_id, bonus_remaining_usd, base_remaining_usd) \
             VALUES (?, 10, 0)",
        )
        .bind(new_uid)
        .execute(&state.db)
        .await;
        sqlx::query(
            "INSERT INTO user_oauth_links (user_id, provider_code, external_id, external_name) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(new_uid)
        .bind(&provider_code)
        .bind(&external_id)
        .bind(external_name.as_deref())
        .execute(&state.db)
        .await?;
        new_uid
    };

    // 颁发 JWT —— 复用 JwtIssuer.issue_pair
    let issuer: &JwtIssuer = &state.jwt;
    let row: (String, String) = sqlx::query_as(
        "SELECT u.username, r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let pair = issuer.issue_pair(user_id, &row.1)?;
    Ok(Json(json!({
        "ok": true,
        "user": { "id": user_id, "username": row.0, "role": row.1 },
        "tokens": pair,
        "returnTo": saved.get("returnTo"),
    })))
}

fn first_str(obj: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(s) = v.as_str() {
                return Some(s.to_string());
            }
            if let Some(n) = v.as_i64() {
                return Some(n.to_string());
            }
        }
    }
    None
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .chars()
        .take(32)
        .collect()
}

async fn ensure_unique_username(state: &AppState, base: &str) -> ApiResult<String> {
    let mut candidate = base.to_string();
    for _ in 0..5 {
        let exists: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM users WHERE username = ?")
                .bind(&candidate)
                .fetch_optional(&state.db)
                .await?;
        if exists.is_none() {
            return Ok(candidate);
        }
        let mut bytes = [0u8; 3];
        rand::thread_rng().fill_bytes(&mut bytes);
        candidate = format!("{}_{}", base, hex::encode(bytes));
    }
    Err(ApiError::Conflict("无法生成唯一用户名".into()))
}
