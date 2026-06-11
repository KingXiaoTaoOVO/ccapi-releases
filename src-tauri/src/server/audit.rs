//! 审计日志（独立于 usage_logs，不会被"一键清空调用日志"误清）。
//!
//! 写入风格：fire-and-forget——失败只 eprintln，不抛错给业务路径。
//! 查询：管理员 GET /api/admin/audit-logs，DELETE 是单独的清空接口。

use axum::extract::{Extension, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::MySqlPool;

use crate::server::error::ApiResult;
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/admin/audit-logs", get(list).delete(purge))
}

/// 写一条审计日志。`actor_id` 是操作发起人。失败只打日志，不抛给业务。
pub async fn log(
    db: &MySqlPool,
    actor_id: i64,
    action: &str,
    target_type: &str,
    target_id: Option<i64>,
    target_name: Option<&str>,
    payload: Option<Value>,
) {
    let actor_name: Option<String> = sqlx::query_scalar(
        "SELECT username FROM users WHERE id = ?",
    )
    .bind(actor_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    let payload_json = payload.map(sqlx::types::Json);
    let res = sqlx::query(
        "INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, target_name, payload) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(actor_id)
    .bind(actor_name.as_deref())
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(target_name)
    .bind(payload_json)
    .execute(db)
    .await;
    if let Err(e) = res {
        eprintln!("[audit] write failed: {e}");
    }
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct AuditRow {
    id: i64,
    actor_id: i64,
    actor_name: Option<String>,
    action: String,
    target_type: Option<String>,
    target_id: Option<i64>,
    target_name: Option<String>,
    payload: Option<sqlx::types::Json<Value>>,
    created_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    limit: Option<u32>,
    actor_id: Option<i64>,
    action: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("audit.read")?;
    let limit = q.limit.unwrap_or(200).min(2000) as i64;

    let mut wh: Vec<&str> = Vec::new();
    if q.actor_id.is_some() {
        wh.push("actor_id = ?");
    }
    if q.action.is_some() {
        wh.push("action = ?");
    }
    let where_sql = if wh.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", wh.join(" AND "))
    };
    let sql = format!(
        "SELECT id, actor_id, actor_name, action, target_type, target_id, \
         target_name, payload, created_at FROM audit_logs{} \
         ORDER BY id DESC LIMIT ?",
        where_sql
    );
    let mut qb = sqlx::query_as::<_, AuditRow>(&sql);
    if let Some(a) = q.actor_id {
        qb = qb.bind(a);
    }
    if let Some(a) = q.action {
        qb = qb.bind(a);
    }
    qb = qb.bind(limit);
    let rows = qb.fetch_all(&state.db).await?;
    Ok(Json(json!({ "ok": true, "logs": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PurgeQuery {
    before: Option<String>,
    before_ts: Option<i64>,
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<PurgeQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("audit.delete")?;
    let before = q.before_ts.and_then(|ts| {
        chrono::DateTime::from_timestamp(ts, 0).map(|d| d.naive_utc())
    }).or_else(|| {
        q.before.as_deref().and_then(|s| {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
        })
    });

    let affected = match before {
        Some(t) => sqlx::query("DELETE FROM audit_logs WHERE created_at < ?")
            .bind(t)
            .execute(&state.db)
            .await?
            .rows_affected(),
        None => sqlx::query("DELETE FROM audit_logs")
            .execute(&state.db)
            .await?
            .rows_affected(),
    };

    // 这条"清空审计日志"本身也要留痕——但放在删完之后写
    log(
        &state.db,
        ctx.user_id,
        "audit.purge",
        "audit_logs",
        None,
        None,
        Some(json!({ "deleted": affected })),
    )
    .await;

    Ok(Json(json!({ "ok": true, "deleted": affected })))
}
