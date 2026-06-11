//! Prefill prompt 模板（管理员预设 + 用户在 Playground 调用）。
//!
//! 路由：
//!   公开（已登录用户）：
//!     GET  /api/prefill-groups            列出所有 enabled 的预设
//!   管理员（model.read / model.write 维度上叫 prefill.* 但本轮复用 config 权限）：
//!     POST /api/admin/prefill-groups
//!     PATCH/DELETE /api/admin/prefill-groups/{id}

use axum::extract::{Extension, Path, State};
use axum::routing::get;
use axum::routing::post;
use axum::{Json, Router};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/prefill-groups", get(list_public))
        .route("/api/admin/prefill-groups", post(create))
        .route(
            "/api/admin/prefill-groups/{id}",
            axum::routing::patch(update).delete(remove),
        )
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: i64,
    code: String,
    display_name: String,
    description: Option<String>,
    prompts: sqlx::types::Json<Value>,
    enabled: i8,
    sort_order: i32,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

async fn list_public(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, code, display_name, description, prompts, enabled, sort_order, \
                created_at, updated_at FROM prefill_groups \
         WHERE enabled = 1 ORDER BY sort_order, id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "groups": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upsert {
    code: String,
    display_name: String,
    description: Option<String>,
    prompts: Value,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    sort_order: i32,
}

fn default_true() -> bool {
    true
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<Upsert>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    if body.code.trim().is_empty() {
        return Err(ApiError::BadRequest("code 不能为空".into()));
    }
    if !body.prompts.is_array() {
        return Err(ApiError::BadRequest("prompts 必须是数组".into()));
    }
    let res = sqlx::query(
        "INSERT INTO prefill_groups (code, display_name, description, prompts, enabled, sort_order) \
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)",
    )
    .bind(body.code.trim())
    .bind(body.display_name.trim())
    .bind(body.description.as_deref())
    .bind(body.prompts.to_string())
    .bind(if body.enabled { 1i8 } else { 0 })
    .bind(body.sort_order)
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("Duplicate") {
            ApiError::Conflict("code 已被占用".into())
        } else {
            ApiError::Database(e.to_string())
        }
    })?;
    Ok(Json(json!({ "ok": true, "id": res.last_insert_id() })))
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<Upsert>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let res = sqlx::query(
        "UPDATE prefill_groups SET code=?, display_name=?, description=?, prompts=CAST(? AS JSON), \
         enabled=?, sort_order=? WHERE id=?",
    )
    .bind(body.code.trim())
    .bind(body.display_name.trim())
    .bind(body.description.as_deref())
    .bind(body.prompts.to_string())
    .bind(if body.enabled { 1i8 } else { 0 })
    .bind(body.sort_order)
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("prefill 不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let res = sqlx::query("DELETE FROM prefill_groups WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("prefill 不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
