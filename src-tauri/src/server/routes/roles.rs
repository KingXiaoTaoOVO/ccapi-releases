use axum::extract::{Extension, Path, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::permissions::ALL_PERMISSIONS;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/roles", get(list).post(create))
        .route("/api/admin/roles/{id}", patch(update).delete(remove))
        .route("/api/admin/permissions", get(catalog))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct RoleRow {
    id: i64,
    name: String,
    description: Option<String>,
    is_system: i8,
    permissions: sqlx::types::Json<Vec<String>>,
    created_at: Option<NaiveDateTime>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("role.read")?;
    let rows: Vec<RoleRow> = sqlx::query_as(
        "SELECT id, name, description, is_system, permissions, created_at FROM roles ORDER BY id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "roles": rows })))
}

#[derive(Deserialize)]
struct UpsertBody {
    name: String,
    description: Option<String>,
    permissions: Vec<String>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("role.create")?;
    let perms = sqlx::types::Json(body.permissions);
    let res = sqlx::query(
        "INSERT INTO roles (name, description, is_system, permissions) VALUES (?, ?, 0, ?)",
    )
    .bind(&body.name)
    .bind(&body.description)
    .bind(&perms)
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("Duplicate") {
            ApiError::Conflict("角色名已存在".into())
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
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("role.update")?;
    let row: Option<(i8,)> = sqlx::query_as("SELECT is_system FROM roles WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some((is_system,)) = row else {
        return Err(ApiError::NotFound("角色不存在".into()));
    };
    if is_system != 0 && body.permissions.is_empty() {
        return Err(ApiError::BadRequest("系统角色权限不能为空".into()));
    }
    let perms = sqlx::types::Json(body.permissions);
    sqlx::query("UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?")
        .bind(&body.name)
        .bind(&body.description)
        .bind(&perms)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("role.delete")?;
    let row: Option<(i8, String)> =
        sqlx::query_as("SELECT is_system, name FROM roles WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some((is_system, _)) = row else {
        return Err(ApiError::NotFound("角色不存在".into()));
    };
    if is_system != 0 {
        return Err(ApiError::Forbidden("系统内建角色不可删除".into()));
    }
    let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE role_id = ?")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if cnt.0 > 0 {
        return Err(ApiError::Conflict(format!(
            "尚有 {} 个用户使用该角色，请先迁移",
            cnt.0
        )));
    }
    sqlx::query("DELETE FROM roles WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn catalog(
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("role.read")?;
    let list: Vec<Value> = ALL_PERMISSIONS
        .iter()
        .map(|(k, d)| {
            json!({
                "key": k,
                "description": d,
                "group": k.split('.').next().unwrap_or("misc"),
            })
        })
        .collect();
    Ok(Json(json!({ "ok": true, "permissions": list })))
}
