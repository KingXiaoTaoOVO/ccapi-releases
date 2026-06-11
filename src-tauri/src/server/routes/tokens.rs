//! 用户自管 API 令牌（粘贴到 OpenAI / Anthropic 兼容客户端用）。
//!
//! 创建时生成 `sk-ccapi-<32 hex>`，明文**仅一次**返回；后续只能看 preview。
//! 撤销 = 软删（revoked = 1），保留历史 usage 记录。

use axum::extract::{Extension, Path, Query, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::NaiveDateTime;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::server::audit;
use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/tokens", get(list).post(create))
        .route("/api/me/tokens/{id}", patch(update).delete(remove))
        // 管理员视角
        .route("/api/admin/tokens", get(admin_list))
        .route("/api/admin/tokens/{id}", axum::routing::delete(admin_revoke))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct AdminTokenRow {
    id: i64,
    user_id: i64,
    username: String,
    name: String,
    key_preview: String,
    quota_usd: Option<BigDecimal>,
    used_usd: BigDecimal,
    expires_at: Option<NaiveDateTime>,
    revoked: i8,
    last_used_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminListQuery {
    user_id: Option<i64>,
    /// "all" | "active" | "revoked"
    state: Option<String>,
    limit: Option<u32>,
}

async fn admin_list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<AdminListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("token.read.all")?;
    let limit = q.limit.unwrap_or(200).min(1000) as i64;
    let state_filter = q.state.as_deref().unwrap_or("all");

    let mut where_clauses: Vec<String> = Vec::new();
    if q.user_id.is_some() {
        where_clauses.push("t.user_id = ?".into());
    }
    match state_filter {
        "active" => where_clauses.push("t.revoked = 0".into()),
        "revoked" => where_clauses.push("t.revoked = 1".into()),
        _ => {}
    }
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT t.id, t.user_id, u.username, t.name, t.key_preview, t.quota_usd, \
         t.used_usd, t.expires_at, t.revoked, t.last_used_at, t.created_at \
         FROM api_tokens t JOIN users u ON u.id = t.user_id{} \
         ORDER BY t.id DESC LIMIT ?",
        where_sql
    );
    let mut q_builder = sqlx::query_as::<_, AdminTokenRow>(&sql);
    if let Some(uid) = q.user_id {
        q_builder = q_builder.bind(uid);
    }
    q_builder = q_builder.bind(limit);
    let rows = q_builder.fetch_all(&state.db).await?;
    Ok(Json(json!({ "ok": true, "tokens": rows })))
}

async fn admin_revoke(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("token.delete.all")?;
    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT t.user_id, u.username, t.name FROM api_tokens t \
         JOIN users u ON u.id = t.user_id WHERE t.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (target_user, target_username, token_name) =
        row.ok_or_else(|| ApiError::NotFound("令牌不存在".into()))?;

    let res = sqlx::query("UPDATE api_tokens SET revoked = 1 WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("令牌不存在".into()));
    }

    audit::log(
        &state.db,
        ctx.user_id,
        "token.revoke",
        "api_token",
        Some(id),
        Some(&format!("{} ({})", token_name, target_username)),
        Some(json!({ "target_user_id": target_user })),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct TokenRow {
    id: i64,
    user_id: i64,
    name: String,
    key_preview: String,
    quota_usd: Option<BigDecimal>,
    used_usd: BigDecimal,
    models_allowed: Option<sqlx::types::Json<Value>>,
    ip_whitelist: Option<sqlx::types::Json<Value>>,
    expires_at: Option<NaiveDateTime>,
    revoked: i8,
    last_used_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertBody {
    name: String,
    /// null = 不限
    quota_usd: Option<f64>,
    /// null / [] = 不限
    models_allowed: Option<Value>,
    ip_whitelist: Option<Value>,
    expires_at: Option<NaiveDateTime>,
}

fn validate(body: &UpsertBody) -> ApiResult<()> {
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("令牌名不能为空".into()));
    }
    if let Some(q) = body.quota_usd {
        if q < 0.0 {
            return Err(ApiError::BadRequest("配额不可为负".into()));
        }
    }
    Ok(())
}

fn gen_token() -> (String, String, String) {
    let mut buf = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut buf);
    let body = hex::encode(buf); // 48 hex chars
    let full = format!("sk-ccapi-{}", body);
    let hash = Sha256::digest(full.as_bytes());
    let hash_hex = hex::encode(hash);
    let preview = format!("sk-ccapi-{}...{}", &body[..6], &body[body.len() - 4..]);
    (full, hash_hex, preview)
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("token.read")?;
    let rows: Vec<TokenRow> = sqlx::query_as(
        "SELECT id,user_id,name,key_preview,quota_usd,used_usd,models_allowed,\
         ip_whitelist,expires_at,revoked,last_used_at,created_at \
         FROM api_tokens WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "tokens": rows })))
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("token.create")?;
    validate(&body)?;
    let (full, hash, preview) = gen_token();
    let res = sqlx::query(
        "INSERT INTO api_tokens (user_id, name, key_hash, key_preview, \
         quota_usd, models_allowed, ip_whitelist, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ctx.user_id)
    .bind(body.name.trim())
    .bind(&hash)
    .bind(&preview)
    .bind(body.quota_usd)
    .bind(body.models_allowed.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.ip_whitelist.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.expires_at)
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::Database(e.to_string()))?;
    Ok(Json(json!({
        "ok": true,
        "id": res.last_insert_id(),
        "token": full,   // 仅创建时返回明文
        "preview": preview,
    })))
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("token.update")?;
    validate(&body)?;
    let res = sqlx::query(
        "UPDATE api_tokens SET name=?, quota_usd=?, models_allowed=?, \
         ip_whitelist=?, expires_at=? WHERE id=? AND user_id=?",
    )
    .bind(body.name.trim())
    .bind(body.quota_usd)
    .bind(body.models_allowed.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.ip_whitelist.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.expires_at)
    .bind(id)
    .bind(ctx.user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("令牌不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

/// 撤销 = 软删（保留历史）
async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("token.delete")?;
    let res = sqlx::query(
        "UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(ctx.user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("令牌不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
