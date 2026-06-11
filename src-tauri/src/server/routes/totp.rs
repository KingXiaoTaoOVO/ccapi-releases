//! 用户级 TOTP 2FA（RFC 6238）。
//!
//! 路由：
//!   GET    /api/me/2fa/status               是否已绑定/启用
//!   POST   /api/me/2fa/setup                生成 secret + recovery codes（暂存，未启用）
//!   POST   /api/me/2fa/enable   {code}      验证一次 6 位码后正式启用
//!   POST   /api/me/2fa/disable  {code}      验证后解绑（也接受 recovery code）
//!   POST   /api/me/2fa/verify   {code}      纯校验入口（高危操作前用）
//!
//! 注意：当前实现**没有**把 TOTP 接进 login 流程，2FA 仅作为账号安全标识 +
//! 高危操作二次确认；后续要把 login 改成两步可在 routes/auth.rs 里读
//! user_totp.enabled 实现。

use axum::extract::{Extension, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::{Rng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use totp_rs::{Algorithm, Secret, TOTP};

use crate::server::crypto;
use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/2fa/status", get(status))
        .route("/api/me/2fa/setup", post(setup))
        .route("/api/me/2fa/enable", post(enable))
        .route("/api/me/2fa/disable", post(disable))
        .route("/api/me/2fa/verify", post(verify))
}

fn issuer_label(user_id: i64) -> (String, String) {
    ("CCAPI".to_string(), format!("user-{}", user_id))
}

fn build_totp(secret_b32: &str) -> Result<TOTP, ApiError> {
    let bytes = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|e| ApiError::Internal(format!("base32 decode: {e}")))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        bytes,
        Some("CCAPI".into()),
        "CCAPI".into(),
    )
    .map_err(|e| ApiError::Internal(format!("TOTP init: {e}")))
}

fn gen_recovery_codes() -> Vec<String> {
    let mut rng = rand::thread_rng();
    (0..10)
        .map(|_| {
            let n: u64 = rng.gen();
            format!("{:010X}", n & 0xFFFF_FFFF_FFFF)
        })
        .collect()
}

fn hash_code(code: &str) -> String {
    let mut h = Sha256::new();
    h.update(code.as_bytes());
    hex::encode(h.finalize())
}

async fn status(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let row: Option<(i8,)> =
        sqlx::query_as("SELECT enabled FROM user_totp WHERE user_id = ?")
            .bind(ctx.user_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(json!({
        "ok": true,
        "enabled": row.map(|(e,)| e != 0).unwrap_or(false),
    })))
}

async fn setup(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    // 已启用 → 拒绝（必须先 disable）
    let row: Option<(i8,)> =
        sqlx::query_as("SELECT enabled FROM user_totp WHERE user_id = ?")
            .bind(ctx.user_id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((1,)) = row {
        return Err(ApiError::Conflict(
            "已启用，请先 disable 再重新绑定".into(),
        ));
    }
    let mut raw = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut raw);
    let secret = Secret::Raw(raw.to_vec());
    let secret_b32 = secret
        .to_encoded()
        .to_string();
    let totp = build_totp(&secret_b32)?;
    let (issuer, account) = issuer_label(ctx.user_id);
    let provisioning_uri = format!(
        "otpauth://totp/{issuer}:{account}?secret={secret_b32}&issuer={issuer}&algorithm=SHA1&digits=6&period=30"
    );
    // QR Data URL（PNG base64）
    let qr_data_url = totp
        .get_qr_base64()
        .map(|b64| format!("data:image/png;base64,{}", b64))
        .unwrap_or_default();

    let recovery_codes = gen_recovery_codes();
    let recovery_hashes: Vec<String> = recovery_codes.iter().map(|c| hash_code(c)).collect();

    let enc = crypto::encrypt(&state.jwt_secret, &secret_b32)
        .map_err(|e| ApiError::Internal(format!("加密 TOTP secret 失败: {e}")))?;

    sqlx::query(
        "INSERT INTO user_totp (user_id, secret_encrypted, enabled, recovery_hashes) \
         VALUES (?, ?, 0, CAST(? AS JSON)) \
         ON DUPLICATE KEY UPDATE secret_encrypted = VALUES(secret_encrypted), \
         enabled = 0, recovery_hashes = VALUES(recovery_hashes), verified_at = NULL",
    )
    .bind(ctx.user_id)
    .bind(&enc)
    .bind(serde_json::to_string(&recovery_hashes).unwrap_or("[]".into()))
    .execute(&state.db)
    .await?;

    Ok(Json(json!({
        "ok": true,
        "secret": secret_b32,
        "provisioningUri": provisioning_uri,
        "qrDataUrl": qr_data_url,
        "recoveryCodes": recovery_codes,
    })))
}

#[derive(Deserialize)]
struct CodeBody {
    code: String,
}

async fn current_secret(state: &AppState, user_id: i64) -> ApiResult<String> {
    let row: Option<(String, i8)> = sqlx::query_as(
        "SELECT secret_encrypted, enabled FROM user_totp WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let (enc, _) = row.ok_or_else(|| ApiError::NotFound("尚未绑定 2FA".into()))?;
    Ok(crypto::decrypt_or_plain(&state.jwt_secret, &enc))
}

fn check_totp_or_recovery(
    secret_b32: &str,
    recovery_hashes: &mut Vec<String>,
    user_input: &str,
) -> bool {
    let input = user_input.trim().to_string();
    // 1) 普通 TOTP
    if let Ok(totp) = build_totp(secret_b32) {
        if let Ok(ok) = totp.check_current(&input) {
            if ok {
                return true;
            }
        }
    }
    // 2) recovery code
    let h = hash_code(&input.to_uppercase());
    if let Some(pos) = recovery_hashes.iter().position(|x| x == &h) {
        recovery_hashes.remove(pos);
        return true;
    }
    false
}

async fn enable(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let secret = current_secret(&state, ctx.user_id).await?;
    let totp = build_totp(&secret)?;
    let ok = totp
        .check_current(body.code.trim())
        .map_err(|e| ApiError::Internal(format!("TOTP 校验失败: {e}")))?;
    if !ok {
        return Err(ApiError::BadRequest("验证码错误".into()));
    }
    sqlx::query("UPDATE user_totp SET enabled = 1, verified_at = NOW() WHERE user_id = ?")
        .bind(ctx.user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn disable(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, sqlx::types::Json<Vec<String>>)> = sqlx::query_as(
        "SELECT secret_encrypted, recovery_hashes FROM user_totp WHERE user_id = ?",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;
    let (enc, sqlx::types::Json(mut hashes)) =
        row.ok_or_else(|| ApiError::NotFound("尚未绑定 2FA".into()))?;
    let secret = crypto::decrypt_or_plain(&state.jwt_secret, &enc);
    if !check_totp_or_recovery(&secret, &mut hashes, &body.code) {
        return Err(ApiError::BadRequest("验证码错误".into()));
    }
    sqlx::query("DELETE FROM user_totp WHERE user_id = ?")
        .bind(ctx.user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn verify(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, sqlx::types::Json<Vec<String>>, i8)> = sqlx::query_as(
        "SELECT secret_encrypted, recovery_hashes, enabled FROM user_totp WHERE user_id = ?",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;
    let (enc, sqlx::types::Json(mut hashes), enabled) =
        row.ok_or_else(|| ApiError::NotFound("尚未绑定 2FA".into()))?;
    if enabled == 0 {
        return Err(ApiError::BadRequest("2FA 未启用".into()));
    }
    let secret = crypto::decrypt_or_plain(&state.jwt_secret, &enc);
    let used_recovery = !check_totp_or_recovery(&secret, &mut hashes, &body.code);
    if used_recovery {
        // 校验失败
        return Err(ApiError::BadRequest("验证码错误".into()));
    }
    // 如果用了 recovery code → recovery_hashes 已被 splice，要落回 DB
    sqlx::query("UPDATE user_totp SET recovery_hashes = CAST(? AS JSON) WHERE user_id = ?")
        .bind(serde_json::to_string(&hashes).unwrap_or("[]".into()))
        .bind(ctx.user_id)
        .execute(&state.db)
        .await
        .ok();
    Ok(Json(json!({ "ok": true })))
}
