use axum::extract::{Extension, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/config", get(list).patch(update))
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let rows: Vec<(String, sqlx::types::Json<Value>)> =
        sqlx::query_as("SELECT k, v FROM config_kv")
            .fetch_all(&state.db)
            .await?;
    let mut map = Map::new();
    for (k, v) in rows {
        map.insert(k, v.0);
    }
    Ok(Json(json!({ "ok": true, "config": map })))
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let Value::Object(map) = body else {
        return Err(ApiError::BadRequest("body 必须是对象".into()));
    };
    for (k, v) in map {
        let payload = sqlx::types::Json(v);
        sqlx::query(
            "INSERT INTO config_kv (k, v) VALUES (?, ?) \
             ON DUPLICATE KEY UPDATE v = VALUES(v)",
        )
        .bind(&k)
        .bind(&payload)
        .execute(&state.db)
        .await?;
    }
    Ok(Json(json!({ "ok": true })))
}
