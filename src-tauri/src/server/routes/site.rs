//! 站点信息 + 注册策略 + 敏感词 + 三级速率限制配置（全部走 config_kv）
//!
//! 公开（不需要 JWT）：
//!   GET  /api/site/info             —— 给登录/注册页用的站点 meta（不暴露敏感配置）
//!
//! 需要管理员（config.write）：
//!   GET/PATCH   /api/admin/site
//!   GET/PATCH   /api/admin/register-policy
//!   GET/PATCH   /api/admin/sensitive-words
//!   GET/PATCH   /api/admin/rate-limits

use axum::extract::{Extension, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn public_router() -> Router<AppState> {
    Router::new().route("/api/site/info", get(public_site_info))
}

pub fn protected_router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/site", get(get_site).patch(update_site))
        .route(
            "/api/admin/register-policy",
            get(get_reg_policy).patch(update_reg_policy),
        )
        .route(
            "/api/admin/sensitive-words",
            get(get_words).patch(update_words),
        )
        .route(
            "/api/admin/rate-limits",
            get(get_rate_limits).patch(update_rate_limits),
        )
}

// ============================================================================
// 工具：读 / 写 一个 KV
// ============================================================================

async fn read_kv(state: &AppState, key: &str) -> ApiResult<Value> {
    let row: Option<(sqlx::types::Json<Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = ?")
            .bind(key)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map(|(j,)| j.0).unwrap_or(Value::Null))
}

async fn write_kv(state: &AppState, key: &str, value: &Value) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO config_kv (k, v) VALUES (?, CAST(? AS JSON)) \
         ON DUPLICATE KEY UPDATE v = VALUES(v)",
    )
    .bind(key)
    .bind(value.to_string())
    .execute(&state.db)
    .await?;
    Ok(())
}

// ============================================================================
// 公开
// ============================================================================

async fn public_site_info(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let site = read_kv(&state, "site_info").await?;
    let reg = read_kv(&state, "register_policy").await?;
    let sys_adv = read_kv(&state, "system_advanced").await?;

    // SMTP 启用状态（让客户端知道能不能用"忘记密码"/"邮箱验证"等功能）
    let smtp = read_kv(&state, "smtp_config").await?;
    let mail_enabled = smtp
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && !smtp
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty();

    // OAuth 已启用的 provider 列表（客户端登录页据此显示按钮）
    let oauth_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT code, display_name FROM oauth_providers WHERE enabled = 1 ORDER BY id",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let oauth_providers: Vec<Value> = oauth_rows
        .into_iter()
        .map(|(code, name)| json!({ "code": code, "displayName": name }))
        .collect();

    Ok(Json(json!({
        "ok": true,
        "site": site,
        "registerPolicy": reg,
        "systemAdvanced": sys_adv,
        "mailEnabled": mail_enabled,
        "oauthProviders": oauth_providers,
        // 仅返回元数据，方便客户端做版本对照/兼容性判断
        "api": {
            "version": env!("CARGO_PKG_VERSION"),
        },
    })))
}

// ============================================================================
// 站点
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SiteInfo {
    name: String,
    logo_url: String,
    icp_record: String,
    footer: String,
    announcement: String,
    /// 软件更新检查的 GitHub repo："owner/repo"。客户端通过 /api/site/info 拉到后用于检查更新
    update_repo: String,
}

async fn get_site(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let v = read_kv(&state, "site_info").await?;
    Ok(Json(json!({ "ok": true, "site": v })))
}

async fn update_site(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<SiteInfo>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let v = serde_json::to_value(&body)?;
    write_kv(&state, "site_info", &v).await?;
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 注册策略
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RegisterPolicy {
    open: bool,
    require_invite_code: bool,
    require_email_verify: bool,
    /// "off" / "easy" / "normal" / "strong"
    captcha_strength: String,
}

async fn get_reg_policy(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let v = read_kv(&state, "register_policy").await?;
    Ok(Json(json!({ "ok": true, "policy": v })))
}

async fn update_reg_policy(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<RegisterPolicy>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    if !["off", "easy", "normal", "strong"].contains(&body.captcha_strength.as_str()) {
        return Err(ApiError::BadRequest(
            "captchaStrength 必须是 off/easy/normal/strong".into(),
        ));
    }
    let v = serde_json::to_value(&body)?;
    write_kv(&state, "register_policy", &v).await?;
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 敏感词
// ============================================================================

async fn get_words(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let v = read_kv(&state, "sensitive_words").await?;
    Ok(Json(json!({ "ok": true, "words": v })))
}

#[derive(Deserialize)]
struct WordsBody {
    words: Vec<String>,
}

async fn update_words(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<WordsBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let cleaned: Vec<String> = body
        .words
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(2000)
        .collect();
    write_kv(&state, "sensitive_words", &json!(cleaned)).await?;
    Ok(Json(json!({ "ok": true, "count": cleaned.len() })))
}

// ============================================================================
// 速率限制（全局 / 单接口 / 单用户 三级）
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RateLimits {
    api_rate_per_minute: Option<i64>,
    login_rate_per_minute: Option<i64>,
    rate_limit_per_user_per_minute: Option<i64>,
    rate_limit_per_group_per_minute: Option<serde_json::Map<String, Value>>,
}

async fn get_rate_limits(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let keys = [
        "api_rate_per_minute",
        "login_rate_per_minute",
        "rate_limit_per_user_per_minute",
        "rate_limit_per_group_per_minute",
    ];
    let mut out = serde_json::Map::new();
    for k in keys {
        out.insert(k.into(), read_kv(&state, k).await?);
    }
    Ok(Json(json!({ "ok": true, "limits": Value::Object(out) })))
}

async fn update_rate_limits(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<RateLimits>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    if let Some(v) = body.api_rate_per_minute {
        write_kv(&state, "api_rate_per_minute", &json!(v)).await?;
    }
    if let Some(v) = body.login_rate_per_minute {
        write_kv(&state, "login_rate_per_minute", &json!(v)).await?;
    }
    if let Some(v) = body.rate_limit_per_user_per_minute {
        write_kv(&state, "rate_limit_per_user_per_minute", &json!(v)).await?;
    }
    if let Some(m) = body.rate_limit_per_group_per_minute {
        write_kv(
            &state,
            "rate_limit_per_group_per_minute",
            &Value::Object(m),
        )
        .await?;
    }
    Ok(Json(json!({ "ok": true })))
}
