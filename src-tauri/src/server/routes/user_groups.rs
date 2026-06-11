//! 用户分组 CRUD（差异化倍率 + 渠道隔离）。

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
        .route("/api/admin/user-groups", get(list).post(create))
        .route("/api/admin/user-groups/{id}", patch(update).delete(remove))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct GroupRow {
    id: i64,
    code: String,
    display_name: String,
    multiplier: BigDecimal,
    description: Option<String>,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertBody {
    code: Option<String>,
    display_name: String,
    multiplier: f64,
    description: Option<String>,
}

fn validate(body: &UpsertBody) -> ApiResult<()> {
    if body.display_name.trim().is_empty() {
        return Err(ApiError::BadRequest("名称不能为空".into()));
    }
    if body.multiplier <= 0.0 {
        return Err(ApiError::BadRequest("倍率必须大于 0".into()));
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("user_group.read")?;
    let rows: Vec<GroupRow> = sqlx::query_as(
        "SELECT id,code,display_name,multiplier,description,created_at,updated_at \
         FROM user_groups ORDER BY id ASC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "groups": rows })))
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("user_group.update")?;
    validate(&body)?;
    let code = body
        .code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::BadRequest("缺少 code".into()))?;
    let dup: Option<(i64,)> = sqlx::query_as("SELECT id FROM user_groups WHERE code = ?")
        .bind(code)
        .fetch_optional(&state.db)
        .await?;
    if dup.is_some() {
        return Err(ApiError::Conflict(format!("分组 {code} 已存在")));
    }
    let res = sqlx::query(
        "INSERT INTO user_groups (code, display_name, multiplier, description) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(code)
    .bind(body.display_name.trim())
    .bind(body.multiplier)
    .bind(body.description.as_deref())
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
    ctx.require("user_group.update")?;
    validate(&body)?;
    let res = sqlx::query(
        "UPDATE user_groups SET display_name=?, multiplier=?, description=? WHERE id=?",
    )
    .bind(body.display_name.trim())
    .bind(body.multiplier)
    .bind(body.description.as_deref())
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("分组不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("user_group.update")?;
    if id == 1 {
        return Err(ApiError::BadRequest("默认分组不可删除".into()));
    }
    let used: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE group_id = ?")
        .bind(id)
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));
    if used.0 > 0 {
        return Err(ApiError::Conflict(format!(
            "仍有 {} 个用户属于该分组",
            used.0
        )));
    }
    let res = sqlx::query("DELETE FROM user_groups WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("分组不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
