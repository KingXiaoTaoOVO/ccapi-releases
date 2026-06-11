//! 模型定价 CRUD。
//! 计费的单位：USD per 1M tokens。

use axum::extract::{Extension, Path, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/models", get(list).post(create))
        .route("/api/admin/models/{id}", patch(update).delete(remove))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct ModelRow {
    id: i64,
    name: String,
    display_name: Option<String>,
    family: Option<String>,
    prompt_price_per_million: BigDecimal,
    completion_price_per_million: BigDecimal,
    context_window: Option<i32>,
    enabled: i8,
    sort_order: i32,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertBody {
    name: Option<String>,
    display_name: Option<String>,
    family: Option<String>,
    prompt_price_per_million: f64,
    completion_price_per_million: f64,
    context_window: Option<i32>,
    enabled: Option<bool>,
    sort_order: Option<i32>,
}

fn validate(body: &UpsertBody) -> ApiResult<()> {
    if body.prompt_price_per_million < 0.0 || body.completion_price_per_million < 0.0 {
        return Err(ApiError::BadRequest("价格不可为负".into()));
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("model.read")?;
    let rows: Vec<ModelRow> = sqlx::query_as(
        "SELECT id,name,display_name,family,prompt_price_per_million,\
         completion_price_per_million,context_window,enabled,sort_order,\
         created_at,updated_at FROM models ORDER BY sort_order ASC, name ASC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "models": rows })))
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("model.update")?;
    validate(&body)?;
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::BadRequest("缺少 name".into()))?;
    let dup: Option<(i64,)> = sqlx::query_as("SELECT id FROM models WHERE name = ?")
        .bind(name)
        .fetch_optional(&state.db)
        .await?;
    if dup.is_some() {
        return Err(ApiError::Conflict(format!("模型 {name} 已存在")));
    }
    let res = sqlx::query(
        "INSERT INTO models (name, display_name, family, prompt_price_per_million, \
         completion_price_per_million, context_window, enabled, sort_order) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(name)
    .bind(body.display_name.as_deref())
    .bind(body.family.as_deref())
    .bind(body.prompt_price_per_million)
    .bind(body.completion_price_per_million)
    .bind(body.context_window)
    .bind(body.enabled.unwrap_or(true) as i8)
    .bind(body.sort_order.unwrap_or(100))
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::Database(e.to_string()))?;
    Ok(Json(json!({ "ok": true, "id": res.last_insert_id() })))
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("model.update")?;
    validate(&body)?;
    let res = sqlx::query(
        "UPDATE models SET display_name=?, family=?, prompt_price_per_million=?, \
         completion_price_per_million=?, context_window=?, enabled=?, sort_order=? \
         WHERE id=?",
    )
    .bind(body.display_name.as_deref())
    .bind(body.family.as_deref())
    .bind(body.prompt_price_per_million)
    .bind(body.completion_price_per_million)
    .bind(body.context_window)
    .bind(body.enabled.unwrap_or(true) as i8)
    .bind(body.sort_order.unwrap_or(100))
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("模型不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("model.delete")?;
    let res = sqlx::query("DELETE FROM models WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("模型不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
