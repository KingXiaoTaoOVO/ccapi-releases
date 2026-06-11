use axum::extract::{Extension, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::auth::{check_password, hash_password};
use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/login", post(login))
        .route("/api/refresh", post(refresh))
        .route("/api/register", post(register))
        .route("/api/2fa/login", post(login_2fa))
}

pub fn protected_router() -> Router<AppState> {
    Router::new()
        .route("/api/logout", post(logout))
        .route("/api/change-password", post(change_password))
        .route("/api/me", post(me))
        .route("/api/me/change-username", post(change_username))
        .route("/api/me/change-email", post(change_email))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    username: String,
    password: String,
    #[serde(default)]
    captcha_id: Option<String>,
    #[serde(default)]
    captcha_answer: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserBrief {
    id: i64,
    username: String,
    role: String,
    permissions: Vec<String>,
    must_change_password: bool,
    email: Option<String>,
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Json<Value>> {
    if body.username.is_empty() || body.password.is_empty() {
        return Err(ApiError::BadRequest("用户名和密码不能为空".into()));
    }

    // 校验 captcha（如果客户端有发送 captchaId + captchaAnswer 就强制校验）
    if let (Some(id), Some(ans)) = (body.captcha_id.as_ref(), body.captcha_answer.as_ref()) {
        if !id.is_empty() && !ans.is_empty() {
            crate::server::captcha::verify_captcha(&state, id, ans).await?;
        }
    }

    // 速率限制：登录每用户名 5 次/分钟
    let rate_key = format!("ratelimit:login:{}", body.username.to_lowercase());
    let mut conn = state.redis.clone();
    let count: i64 = redis::cmd("INCR")
        .arg(&rate_key)
        .query_async(&mut conn)
        .await
        .unwrap_or(0);
    if count == 1 {
        let _: Result<i32, _> = redis::cmd("EXPIRE")
            .arg(&rate_key)
            .arg(60)
            .query_async(&mut conn)
            .await;
    }
    if count > 5 {
        return Err(ApiError::TooManyRequests);
    }

    let row: Option<(i64, String, String, String, i8, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.username, u.password_hash, r.name, u.must_change_password, u.email \
         FROM users u JOIN roles r ON r.id = u.role_id \
         WHERE u.username = ? AND u.status = 'active'",
    )
    .bind(&body.username)
    .fetch_optional(&state.db)
    .await?;

    let Some((id, username, hash, role, must_change, email)) = row else {
        return Err(ApiError::Unauthorized);
    };
    if !check_password(&body.password, &hash) {
        return Err(ApiError::Unauthorized);
    }

    // 2FA 检查：若已启用 → 颁发临时 partial token 让前端跳到第二步
    let two_fa: Option<(i8,)> =
        sqlx::query_as("SELECT enabled FROM user_totp WHERE user_id = ?")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((1,)) = two_fa {
        let partial = uuid::Uuid::new_v4().simple().to_string();
        let key = format!("pre2fa:{partial}");
        let _: () = redis::cmd("SET")
            .arg(&key)
            .arg(id)
            .arg("EX")
            .arg(5 * 60)
            .query_async(&mut conn)
            .await?;
        return Ok(Json(json!({
            "ok": true,
            "requires2fa": true,
            "partialToken": partial,
            "user": { "id": id, "username": username },
        })));
    }

    let pair = state.jwt.issue_pair(id, &role)?;
    // 在 Redis 中记录有效 refresh token（用于刷新 + 踢出撤销）
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("refresh:{}", pair.jti))
        .arg(id)
        .arg("EX")
        .arg(pair.refresh_expires_in)
        .query_async(&mut conn)
        .await;

    // 取角色权限给前端
    let perms: Option<sqlx::types::Json<Vec<String>>> = sqlx::query_scalar(
        "SELECT permissions FROM roles WHERE name = ?",
    )
    .bind(&role)
    .fetch_optional(&state.db)
    .await?;
    let permissions = perms.map(|j| j.0).unwrap_or_default();

    sqlx::query("UPDATE users SET last_login_at = NOW() WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await
        .ok();

    Ok(Json(json!({
        "ok": true,
        "tokens": pair,
        "user": UserBrief {
            id,
            username,
            role,
            permissions,
            must_change_password: must_change != 0,
            email,
        },
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login2faBody {
    partial_token: String,
    code: String,
}

async fn login_2fa(
    State(state): State<AppState>,
    Json(body): Json<Login2faBody>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.redis.clone();
    let key = format!("pre2fa:{}", body.partial_token);
    let user_id: Option<i64> = redis::cmd("GETDEL").arg(&key).query_async(&mut conn).await?;
    let user_id = user_id.ok_or_else(|| {
        ApiError::Unauthorized
    })?;

    // 取 secret + recovery，与 totp.rs::verify 同逻辑
    let row: Option<(String, sqlx::types::Json<Vec<String>>, i8)> = sqlx::query_as(
        "SELECT secret_encrypted, recovery_hashes, enabled FROM user_totp WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let (enc, sqlx::types::Json(mut hashes), enabled) =
        row.ok_or_else(|| ApiError::BadRequest("2FA 未绑定".into()))?;
    if enabled == 0 {
        return Err(ApiError::BadRequest("2FA 未启用".into()));
    }
    let secret = crate::server::crypto::decrypt_or_plain(&state.jwt_secret, &enc);
    if !check_totp_or_recovery_str(&secret, &mut hashes, &body.code) {
        // 还原 partial token 一次（允许多试 1 次以减少误触）—— 不做了，直接失败
        return Err(ApiError::BadRequest("验证码错误".into()));
    }
    sqlx::query("UPDATE user_totp SET recovery_hashes = CAST(? AS JSON) WHERE user_id = ?")
        .bind(serde_json::to_string(&hashes).unwrap_or("[]".into()))
        .bind(user_id)
        .execute(&state.db)
        .await
        .ok();

    // 取 username + role 颁发真实 pair
    let row: Option<(String, String, i8, Option<String>)> = sqlx::query_as(
        "SELECT u.username, r.name, u.must_change_password, u.email \
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let (username, role, must_change, email) =
        row.ok_or_else(|| ApiError::NotFound("用户不存在".into()))?;
    let pair = state.jwt.issue_pair(user_id, &role)?;
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("refresh:{}", pair.jti))
        .arg(user_id)
        .arg("EX")
        .arg(pair.refresh_expires_in)
        .query_async(&mut conn)
        .await;
    let perms: Option<sqlx::types::Json<Vec<String>>> =
        sqlx::query_scalar("SELECT permissions FROM roles WHERE name = ?")
            .bind(&role)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(json!({
        "ok": true,
        "tokens": pair,
        "user": UserBrief {
            id: user_id,
            username,
            role,
            permissions: perms.map(|j| j.0).unwrap_or_default(),
            must_change_password: must_change != 0,
            email,
        },
    })))
}

/// 复刻 totp.rs 中的校验逻辑（同模块逻辑，但避开重复 import）。
fn check_totp_or_recovery_str(
    secret_b32: &str,
    recovery_hashes: &mut Vec<String>,
    user_input: &str,
) -> bool {
    use sha2::{Digest, Sha256};
    use totp_rs::{Algorithm, Secret, TOTP};
    let input = user_input.trim().to_string();
    if let Ok(bytes) = Secret::Encoded(secret_b32.to_string()).to_bytes() {
        if let Ok(totp) = TOTP::new(
            Algorithm::SHA1,
            6,
            1,
            30,
            bytes,
            Some("CCAPI".into()),
            "CCAPI".into(),
        ) {
            if let Ok(true) = totp.check_current(&input) {
                return true;
            }
        }
    }
    let mut h = Sha256::new();
    h.update(input.to_uppercase().as_bytes());
    let target = hex::encode(h.finalize());
    if let Some(pos) = recovery_hashes.iter().position(|x| x == &target) {
        recovery_hashes.remove(pos);
        return true;
    }
    false
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody {
    refresh_token: String,
}

async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshBody>,
) -> ApiResult<Json<Value>> {
    let claims = state.jwt.decode(&body.refresh_token)?;
    if claims.typ != "refresh" {
        return Err(ApiError::Unauthorized);
    }
    let mut conn = state.redis.clone();
    let exists: i32 = redis::cmd("EXISTS")
        .arg(format!("refresh:{}", claims.jti))
        .query_async(&mut conn)
        .await
        .unwrap_or(0);
    if exists == 0 {
        return Err(ApiError::Unauthorized);
    }
    let pair = state.jwt.issue_pair(claims.sub, &claims.role)?;
    let _: Result<i32, _> = redis::cmd("DEL")
        .arg(format!("refresh:{}", claims.jti))
        .query_async(&mut conn)
        .await;
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("refresh:{}", pair.jti))
        .arg(claims.sub)
        .arg("EX")
        .arg(pair.refresh_expires_in)
        .query_async(&mut conn)
        .await;
    Ok(Json(json!({ "ok": true, "tokens": pair })))
}

async fn logout(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.redis.clone();
    let _: Result<i32, _> = redis::cmd("DEL")
        .arg(format!("refresh:{}", ctx.jti))
        .query_async(&mut conn)
        .await;
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("kicked:{}", ctx.jti))
        .arg(1)
        .arg("EX")
        .arg(15 * 60)
        .query_async(&mut conn)
        .await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordBody {
    old_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<ChangePasswordBody>,
) -> ApiResult<Json<Value>> {
    if body.new_password.len() < 6 {
        return Err(ApiError::BadRequest("新密码至少 6 位".into()));
    }
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(ctx.user_id)
        .fetch_one(&state.db)
        .await?;
    if !check_password(&body.old_password, &hash) {
        return Err(ApiError::Forbidden("旧密码不正确".into()));
    }
    let new_hash = hash_password(&body.new_password)?;
    sqlx::query("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
        .bind(&new_hash)
        .bind(ctx.user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeUsernameBody {
    new_username: String,
    password: String,
}

async fn change_username(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<ChangeUsernameBody>,
) -> ApiResult<Json<Value>> {
    let u = body.new_username.trim();
    if u.len() < 3 || u.len() > 32 {
        return Err(ApiError::BadRequest("用户名 3-32 位".into()));
    }
    if !u
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ApiError::BadRequest(
            "用户名只允许字母数字下划线".into(),
        ));
    }
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(ctx.user_id)
        .fetch_one(&state.db)
        .await?;
    if !check_password(&body.password, &hash) {
        return Err(ApiError::Forbidden("密码错误".into()));
    }
    let r = sqlx::query("UPDATE users SET username = ? WHERE id = ?")
        .bind(u)
        .bind(ctx.user_id)
        .execute(&state.db)
        .await
        .map_err(|e| {
            if e.to_string().contains("Duplicate") {
                ApiError::Conflict("用户名已被占用".into())
            } else {
                ApiError::Database(e.to_string())
            }
        })?;
    if r.rows_affected() == 0 {
        return Err(ApiError::NotFound("用户不存在".into()));
    }
    Ok(Json(json!({ "ok": true, "username": u })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeEmailBody {
    new_email: String,
    /// 来自 /api/email-code/send (purpose=bind_email) 的 6 位代码
    email_code: String,
    password: String,
}

async fn change_email(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<ChangeEmailBody>,
) -> ApiResult<Json<Value>> {
    let email = body.new_email.trim().to_ascii_lowercase();
    if !email.contains('@') || email.len() > 128 {
        return Err(ApiError::BadRequest("邮箱格式不合法".into()));
    }
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(ctx.user_id)
        .fetch_one(&state.db)
        .await?;
    if !check_password(&body.password, &hash) {
        return Err(ApiError::Forbidden("密码错误".into()));
    }
    crate::server::mail::verify_email_code(
        &mut state.redis.clone(),
        "bind_email",
        &email,
        &body.email_code,
    )
    .await
    .map_err(ApiError::BadRequest)?;
    sqlx::query("UPDATE users SET email = ? WHERE id = ?")
        .bind(&email)
        .bind(ctx.user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true, "email": email })))
}

async fn me(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let row: Option<(i64, String, String, i8, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.username, r.name, u.must_change_password, u.email \
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, username, role, must_change, email)) = row else {
        return Err(ApiError::NotFound("用户不存在".into()));
    };
    Ok(Json(json!({
        "ok": true,
        "user": UserBrief {
            id,
            username,
            role,
            permissions: ctx.permissions.iter().cloned().collect(),
            must_change_password: must_change != 0,
            email,
        }
    })))
}

// ---------- 注册（Phase 4 + 邮箱验证码）----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    username: String,
    password: String,
    email: Option<String>,
    invite_code: Option<String>,
    captcha_id: String,
    captcha_answer: String,
    /// 当注册策略要求邮箱验证时必填
    #[serde(default)]
    email_code: Option<String>,
}

async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterBody>,
) -> ApiResult<Json<Value>> {
    // 1. 速率限制（IP 级别在 Phase 4 中间件中实现，这里加一道用户名级别）
    let rate_key = format!("ratelimit:register:{}", body.username.to_lowercase());
    let mut conn = state.redis.clone();
    let count: i64 = redis::cmd("INCR")
        .arg(&rate_key)
        .query_async(&mut conn)
        .await
        .unwrap_or(0);
    if count == 1 {
        let _: Result<i32, _> = redis::cmd("EXPIRE")
            .arg(&rate_key)
            .arg(120)
            .query_async(&mut conn)
            .await;
    }
    if count > 3 {
        return Err(ApiError::TooManyRequests);
    }

    // 2. CAPTCHA
    crate::server::captcha::verify_captcha(&state, &body.captcha_id, &body.captcha_answer).await?;

    // 2.5 读注册策略：关闭注册 / 强制邀请码 / 强制邮箱验证
    let policy: Option<(sqlx::types::Json<serde_json::Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'register_policy'")
            .fetch_optional(&state.db)
            .await?;
    if let Some((sqlx::types::Json(p),)) = &policy {
        let open = p.get("open").and_then(|v| v.as_bool()).unwrap_or(true);
        if !open {
            return Err(ApiError::Forbidden("注册功能已关闭".into()));
        }
        let need_invite = p
            .get("requireInviteCode")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if need_invite
            && body
                .invite_code
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
        {
            return Err(ApiError::BadRequest("注册需要邀请码".into()));
        }
        let need_email_verify = p
            .get("requireEmailVerify")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if need_email_verify {
            let email = body
                .email
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ApiError::BadRequest("注册需要邮箱".into()))?;
            let code = body
                .email_code
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ApiError::BadRequest("缺少邮箱验证码".into()))?;
            crate::server::mail::verify_email_code(
                &mut state.redis.clone(),
                "register",
                &email.to_ascii_lowercase(),
                code,
            )
            .await
            .map_err(ApiError::BadRequest)?;
        }
    }

    // 3. 字段校验
    if body.username.len() < 3 || body.username.len() > 32 {
        return Err(ApiError::BadRequest("用户名 3-32 位".into()));
    }
    // 邮箱必填（用于密码找回 + 通知）
    let email_input = body
        .email
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty() && s.contains('@') && s.len() <= 128);
    if email_input.is_none() {
        return Err(ApiError::BadRequest(
            "邮箱必填，且需为合法格式".into(),
        ));
    }
    if !body
        .username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ApiError::BadRequest("用户名只允许字母数字下划线".into()));
    }
    if body.password.len() < 6 {
        return Err(ApiError::BadRequest("密码至少 6 位".into()));
    }

    // 4. 读全局配置：注册奖励 + 邀请奖励
    let cfg_rows: Vec<(String, sqlx::types::Json<serde_json::Value>)> =
        sqlx::query_as("SELECT k, v FROM config_kv WHERE k IN (?, ?)")
            .bind("default_signup_bonus_usd")
            .bind("invite_reward_usd")
            .fetch_all(&state.db)
            .await?;
    let mut signup_bonus = 10f64;
    let mut invite_reward_inviter = 10f64;
    let mut invite_reward_invitee = 10f64;
    for (k, v) in cfg_rows {
        match k.as_str() {
            "default_signup_bonus_usd" => {
                signup_bonus = v
                    .0
                    .as_f64()
                    .or_else(|| v.0.as_str().and_then(|s| s.parse().ok()))
                    .unwrap_or(10.0);
            }
            "invite_reward_usd" => {
                invite_reward_inviter = v
                    .0
                    .get("inviter")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(10.0);
                invite_reward_invitee = v
                    .0
                    .get("invitee")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(10.0);
            }
            _ => {}
        }
    }

    // 5. 邀请码 -> inviter_id
    let inviter: Option<i64> = if let Some(code) = body.invite_code.as_deref() {
        if code.trim().is_empty() {
            None
        } else {
            let r: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM users WHERE invite_code = ?")
                    .bind(code.trim().to_uppercase())
                    .fetch_optional(&state.db)
                    .await?;
            r.map(|(id,)| id)
        }
    } else {
        None
    };

    // 6. 创建用户 + 写 quota
    let pw_hash = hash_password(&body.password)?;
    let invite_code = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(10)
        .collect::<String>()
        .to_uppercase();
    let mut tx = state.db.begin().await?;
    let user_role: (i64,) =
        sqlx::query_as("SELECT id FROM roles WHERE name = 'user'")
            .fetch_one(&mut *tx)
            .await?;
    let res = sqlx::query(
        "INSERT INTO users (username, password_hash, role_id, status, email, invite_code, invited_by, must_change_password) \
         VALUES (?, ?, ?, 'active', ?, ?, ?, 0)",
    )
    .bind(&body.username)
    .bind(&pw_hash)
    .bind(user_role.0)
    .bind(email_input.as_deref())
    .bind(&invite_code)
    .bind(inviter)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        if e.to_string().contains("Duplicate") {
            ApiError::Conflict("用户名已被使用".into())
        } else {
            ApiError::Database(e.to_string())
        }
    })?;
    let new_id = res.last_insert_id() as i64;

    // 注册奖励 + 邀请奖励
    let bonus = signup_bonus + if inviter.is_some() { invite_reward_invitee } else { 0.0 };
    sqlx::query(
        "INSERT INTO user_quota (user_id, bonus_remaining_usd) VALUES (?, ?) \
         ON DUPLICATE KEY UPDATE bonus_remaining_usd = bonus_remaining_usd + VALUES(bonus_remaining_usd)",
    )
    .bind(new_id)
    .bind(bonus)
    .execute(&mut *tx)
    .await?;

    if let Some(inv_id) = inviter {
        sqlx::query(
            "INSERT INTO user_quota (user_id, bonus_remaining_usd) VALUES (?, ?) \
             ON DUPLICATE KEY UPDATE bonus_remaining_usd = bonus_remaining_usd + VALUES(bonus_remaining_usd)",
        )
        .bind(inv_id)
        .bind(invite_reward_inviter)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO invitations (inviter_id, invitee_id, reward_inviter_usd, reward_invitee_usd) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(inv_id)
        .bind(new_id)
        .bind(invite_reward_inviter)
        .bind(invite_reward_invitee)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // 自动登录
    let pair = state.jwt.issue_pair(new_id, "user")?;
    let mut conn = state.redis.clone();
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("refresh:{}", pair.jti))
        .arg(new_id)
        .arg("EX")
        .arg(pair.refresh_expires_in)
        .query_async(&mut conn)
        .await;

    let perms: Option<sqlx::types::Json<Vec<String>>> =
        sqlx::query_scalar("SELECT permissions FROM roles WHERE name = 'user'")
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(json!({
        "ok": true,
        "tokens": pair,
        "user": UserBrief {
            id: new_id,
            username: body.username,
            role: "user".into(),
            permissions: perms.map(|j| j.0).unwrap_or_default(),
            must_change_password: false,
            email: body.email,
        },
        "bonusAwarded": bonus,
    })))
}
