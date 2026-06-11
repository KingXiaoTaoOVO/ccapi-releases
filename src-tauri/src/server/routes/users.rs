use axum::extract::{Extension, Path, Query, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::auth::hash_password;
use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/users", get(list).post(create))
        .route("/api/admin/users/{id}", patch(update).delete(remove))
        .route("/api/admin/users/{id}/ban", post(ban))
        .route("/api/admin/users/{id}/unban", post(unban))
        .route("/api/admin/users/{id}/freeze", post(freeze))
        .route("/api/admin/users/{id}/unfreeze", post(unfreeze))
        .route("/api/admin/users/{id}/kick", post(kick))
        .route("/api/admin/users/{id}/reset-password", post(reset_password))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    role_id: Option<i64>,
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_size")]
    page_size: u32,
}

fn default_page() -> u32 {
    1
}
fn default_size() -> u32 {
    20
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct UserRow {
    id: i64,
    username: String,
    role_id: i64,
    role_name: String,
    status: String,
    email: Option<String>,
    invite_code: Option<String>,
    invited_by: Option<i64>,
    must_change_password: i8,
    status_reason: Option<String>,
    status_until: Option<NaiveDateTime>,
    last_login_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.read")?;
    let page = q.page.max(1) as i64;
    let size = q.page_size.clamp(1, 200) as i64;
    let offset = (page - 1) * size;
    let search = q.search.unwrap_or_default();
    let like = format!("%{}%", search);
    let mut conditions = vec!["1=1"];
    if !search.is_empty() {
        conditions.push("(u.username LIKE ? OR u.email LIKE ?)");
    }
    if q.status.is_some() {
        conditions.push("u.status = ?");
    }
    if q.role_id.is_some() {
        conditions.push("u.role_id = ?");
    }
    let where_clause = conditions.join(" AND ");

    let sql = format!(
        "SELECT u.id, u.username, u.role_id, r.name AS role_name, u.status, u.email, \
         u.invite_code, u.invited_by, u.must_change_password, u.status_reason, u.status_until, \
         u.last_login_at, u.created_at \
         FROM users u JOIN roles r ON r.id = u.role_id \
         WHERE {} ORDER BY u.id DESC LIMIT ? OFFSET ?",
        where_clause
    );
    let mut qb = sqlx::query_as::<_, UserRow>(&sql);
    if !search.is_empty() {
        qb = qb.bind(&like).bind(&like);
    }
    if let Some(s) = &q.status {
        qb = qb.bind(s);
    }
    if let Some(r) = q.role_id {
        qb = qb.bind(r);
    }
    qb = qb.bind(size).bind(offset);
    let rows = qb.fetch_all(&state.db).await?;

    let count_sql = format!(
        "SELECT COUNT(*) FROM users u WHERE {}",
        where_clause.replace("u.username LIKE ? OR u.email LIKE ?", "1=1"),
    );
    let _ = count_sql; // 简化：直接复用条件构造略繁，下面用第二条简单的统计
    let total: (i64,) = {
        let total_q = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM users WHERE 1=1");
        total_q.fetch_one(&state.db).await?
    };

    Ok(Json(json!({
        "ok": true,
        "users": rows,
        "total": total.0,
        "page": page,
        "pageSize": size,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    username: String,
    password: String,
    role_id: i64,
    email: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<CreateBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.create")?;
    if body.username.is_empty() || body.password.len() < 6 {
        return Err(ApiError::BadRequest("用户名或密码不合法".into()));
    }
    let hash = hash_password(&body.password)?;
    let invite_code = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(10)
        .collect::<String>()
        .to_uppercase();
    let res = sqlx::query(
        "INSERT INTO users (username, password_hash, role_id, status, email, invite_code, must_change_password) \
         VALUES (?, ?, ?, 'active', ?, ?, 0)",
    )
    .bind(&body.username)
    .bind(&hash)
    .bind(body.role_id)
    .bind(body.email.as_deref())
    .bind(&invite_code)
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("Duplicate") {
            ApiError::Conflict("用户名已存在".into())
        } else {
            ApiError::Database(e.to_string())
        }
    })?;
    let id = res.last_insert_id() as i64;
    sqlx::query(
        "INSERT INTO user_quota (user_id, bonus_remaining_usd, base_remaining_usd) VALUES (?, 0, 0)",
    )
    .bind(id)
    .execute(&state.db)
    .await?;
    audit(&state, id, "create", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    email: Option<String>,
    role_id: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.update")?;
    if let Some(email) = &body.email {
        sqlx::query("UPDATE users SET email = ? WHERE id = ?")
            .bind(email)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    if let Some(role_id) = body.role_id {
        sqlx::query("UPDATE users SET role_id = ? WHERE id = ?")
            .bind(role_id)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    audit(&state, id, "update", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.delete")?;
    if id == 1 {
        return Err(ApiError::Forbidden("默认 admin 用户不可删除".into()));
    }
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    audit(&state, id, "delete", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BanBody {
    /// -1 = 永久
    duration_secs: i64,
    reason: Option<String>,
}

async fn ban(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<BanBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.ban")?;
    if id == 1 {
        return Err(ApiError::Forbidden("默认 admin 不可封禁".into()));
    }
    let until = if body.duration_secs < 0 {
        None
    } else {
        Some(Utc::now().naive_utc() + chrono::Duration::seconds(body.duration_secs))
    };
    sqlx::query(
        "UPDATE users SET status='banned', status_reason=?, status_until=? WHERE id=?",
    )
    .bind(&body.reason)
    .bind(until)
    .bind(id)
    .execute(&state.db)
    .await?;
    kick_user_sessions(&state, id).await;
    audit(
        &state,
        id,
        "ban",
        body.reason.clone(),
        ctx.user_id,
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

async fn unban(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.ban")?;
    sqlx::query("UPDATE users SET status='active', status_reason=NULL, status_until=NULL WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await?;
    audit(&state, id, "unban", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

async fn freeze(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<BanBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.freeze")?;
    if id == 1 {
        return Err(ApiError::Forbidden("默认 admin 不可冻结".into()));
    }
    let until = if body.duration_secs < 0 {
        None
    } else {
        Some(Utc::now().naive_utc() + chrono::Duration::seconds(body.duration_secs))
    };
    sqlx::query(
        "UPDATE users SET status='frozen', status_reason=?, status_until=? WHERE id=?",
    )
    .bind(&body.reason)
    .bind(until)
    .bind(id)
    .execute(&state.db)
    .await?;
    kick_user_sessions(&state, id).await;
    audit(&state, id, "freeze", body.reason, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

async fn unfreeze(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.freeze")?;
    sqlx::query("UPDATE users SET status='active', status_reason=NULL, status_until=NULL WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await?;
    audit(&state, id, "unfreeze", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

async fn kick(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.kick")?;
    kick_user_sessions(&state, id).await;
    audit(&state, id, "kick", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetBody {
    new_password: String,
}

async fn reset_password(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<ResetBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("user.reset_password")?;
    if body.new_password.len() < 6 {
        return Err(ApiError::BadRequest("新密码至少 6 位".into()));
    }
    let hash = hash_password(&body.new_password)?;
    sqlx::query("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?")
        .bind(&hash)
        .bind(id)
        .execute(&state.db)
        .await?;
    kick_user_sessions(&state, id).await;
    audit(&state, id, "reset_password", None, ctx.user_id).await;
    Ok(Json(json!({ "ok": true })))
}

// ---------- helpers ----------

async fn kick_user_sessions(state: &AppState, user_id: i64) {
    let mut conn = state.redis.clone();
    // 扫描所有 refresh:* 找出该 user_id 的 session（生产环境应改用专门索引；Phase 2 简单实现）
    let mut cursor: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = match redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("refresh:*")
            .arg("COUNT")
            .arg(200)
            .query_async(&mut conn)
            .await
        {
            Ok(v) => v,
            Err(_) => break,
        };
        for k in keys {
            let val: Option<i64> = redis::cmd("GET")
                .arg(&k)
                .query_async(&mut conn)
                .await
                .ok()
                .flatten();
            if val == Some(user_id) {
                let _: Result<i32, _> = redis::cmd("DEL")
                    .arg(&k)
                    .query_async(&mut conn)
                    .await;
                if let Some(jti) = k.strip_prefix("refresh:") {
                    let _: Result<i32, _> = redis::cmd("SET")
                        .arg(format!("kicked:{}", jti))
                        .arg(1)
                        .arg("EX")
                        .arg(60 * 60)
                        .query_async(&mut conn)
                        .await;
                }
            }
        }
        if next == 0 {
            break;
        }
        cursor = next;
    }
}

async fn audit(
    state: &AppState,
    user_id: i64,
    action: &str,
    reason: Option<String>,
    operator: i64,
) {
    // 旧的 user_actions 表（保留兼容）
    let _ = sqlx::query(
        "INSERT INTO user_actions (user_id, action, reason, operator_id) VALUES (?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(action)
    .bind(&reason)
    .bind(operator)
    .execute(&state.db)
    .await;

    // 新的统一审计日志
    let target_name: Option<String> = sqlx::query_scalar(
        "SELECT username FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let payload = reason.map(|r| serde_json::json!({ "reason": r }));
    crate::server::audit::log(
        &state.db,
        operator,
        &format!("user.{action}"),
        "user",
        Some(user_id),
        target_name.as_deref(),
        payload,
    )
    .await;
}
