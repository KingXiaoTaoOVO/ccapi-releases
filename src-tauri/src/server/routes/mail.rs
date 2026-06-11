//! 邮件相关 HTTP 接口：
//!   GET    /api/admin/smtp                 读取 SMTP 配置
//!   PATCH  /api/admin/smtp                 更新 SMTP 配置（password 留空 = 保留旧值）
//!   POST   /api/admin/smtp/test            发送测试邮件给某个地址
//!   POST   /api/email-code/send            **公开**端点：注册 / 找回密码用 → 发验证码

use axum::extract::{Extension, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::mail::{
    is_enabled, issue_email_code, load_smtp_config, render_template_email, send_email, site_name,
    verify_email_code, SmtpConfig,
};
use crate::server::AppState;

pub fn protected_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/smtp",
            get(get_smtp).patch(update_smtp),
        )
        .route("/api/admin/smtp/test", post(test_smtp))
}

pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/email-code/send", post(send_code))
        .route("/api/forgot-password/send", post(forgot_pw_send))
        .route("/api/forgot-password/reset", post(forgot_pw_reset))
}

async fn get_smtp(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let mut cfg = load_smtp_config(&state.db).await;
    // 不把密码原文返回给前端
    cfg.password = if cfg.password.is_empty() { "".into() } else { "********".into() };
    Ok(Json(json!({ "ok": true, "config": cfg })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSmtp {
    #[serde(flatten)]
    base: SmtpConfig,
    /// 若 `password` 字段值是 "********"（占位）或为空字符串，保留旧密码
    keep_password: Option<bool>,
}

async fn update_smtp(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpdateSmtp>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let mut next = body.base;
    let keep = body.keep_password.unwrap_or(false)
        || next.password == "********"
        || next.password.trim().is_empty();
    if keep {
        let old = load_smtp_config(&state.db).await;
        next.password = old.password;
    }
    sqlx::query(
        "INSERT INTO config_kv (k, v) VALUES ('smtp_config', CAST(? AS JSON)) \
         ON DUPLICATE KEY UPDATE v = VALUES(v)",
    )
    .bind(serde_json::to_string(&next).unwrap_or("{}".into()))
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestEmail {
    to: String,
}

async fn test_smtp(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<TestEmail>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let cfg = load_smtp_config(&state.db).await;
    if !is_enabled(&cfg) {
        return Err(ApiError::BadRequest(
            "SMTP 未启用或未配置完整".into(),
        ));
    }
    send_email(
        &cfg,
        &body.to,
        "CCAPI SMTP 测试",
        "<p>这是一封 CCAPI 测试邮件，收到代表 SMTP 配置正确。</p>",
    )
    .await
    .map_err(ApiError::Internal)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendCodeReq {
    email: String,
    /// "register" | "reset_pw" | "bind_email"
    #[serde(default = "default_purpose")]
    purpose: String,
}

fn default_purpose() -> String {
    "register".into()
}

async fn send_code(
    State(state): State<AppState>,
    Json(body): Json<SendCodeReq>,
) -> ApiResult<Json<Value>> {
    let cfg = load_smtp_config(&state.db).await;
    if !is_enabled(&cfg) {
        return Err(ApiError::ServiceUnavailable(
            "管理员未配置邮件服务，无法发送验证码".into(),
        ));
    }
    let email = body.email.trim().to_ascii_lowercase();
    if !email.contains('@') || email.len() > 128 {
        return Err(ApiError::BadRequest("邮箱地址无效".into()));
    }
    let purpose = body.purpose.as_str();
    if !matches!(purpose, "register" | "reset_pw" | "bind_email") {
        return Err(ApiError::BadRequest("未知 purpose".into()));
    }

    let mut redis = state.redis.clone();
    let code = issue_email_code(&mut redis, purpose, &email)
        .await
        .map_err(ApiError::BadRequest)?;
    let site = site_name(&state.db).await;
    let (subject, html) = render_template_email(&state.db, purpose, &site, &code, &email).await;
    send_email(&cfg, &email, &subject, &html)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 找回密码：发码 + 校码 + 改密
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForgotPwSend {
    email: String,
}

async fn forgot_pw_send(
    State(state): State<AppState>,
    Json(body): Json<ForgotPwSend>,
) -> ApiResult<Json<Value>> {
    let cfg = load_smtp_config(&state.db).await;
    if !is_enabled(&cfg) {
        return Err(ApiError::ServiceUnavailable(
            "管理员未配置邮件服务，无法发送找回密码邮件".into(),
        ));
    }
    let email = body.email.trim().to_ascii_lowercase();
    if !email.contains('@') {
        return Err(ApiError::BadRequest("邮箱地址无效".into()));
    }
    // 用户必须真的存在 —— 为防探测账号是否存在，无论存不存在都返回 ok：true，
    // 但只对存在的账号实际发信
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = ? AND status = 'active'")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_some() {
        let mut redis = state.redis.clone();
        let code = issue_email_code(&mut redis, "reset_pw", &email)
            .await
            .map_err(ApiError::BadRequest)?;
        let site = site_name(&state.db).await;
        let (subject, html) =
            render_template_email(&state.db, "reset_pw", &site, &code, &email).await;
        send_email(&cfg, &email, &subject, &html)
            .await
            .map_err(ApiError::Internal)?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForgotPwReset {
    email: String,
    code: String,
    new_password: String,
}

async fn forgot_pw_reset(
    State(state): State<AppState>,
    Json(body): Json<ForgotPwReset>,
) -> ApiResult<Json<Value>> {
    let email = body.email.trim().to_ascii_lowercase();
    if body.new_password.len() < 6 {
        return Err(ApiError::BadRequest("新密码至少 6 位".into()));
    }
    verify_email_code(
        &mut state.redis.clone(),
        "reset_pw",
        &email,
        body.code.trim(),
    )
    .await
    .map_err(ApiError::BadRequest)?;
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = ? AND status = 'active'")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    let user_id = row
        .map(|(id,)| id)
        .ok_or_else(|| ApiError::NotFound("该邮箱未注册".into()))?;
    let hash = crate::server::auth::hash_password(&body.new_password)?;
    sqlx::query(
        "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    )
    .bind(&hash)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}
