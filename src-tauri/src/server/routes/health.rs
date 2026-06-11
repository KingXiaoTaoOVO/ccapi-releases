use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "service": "ccapi-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
