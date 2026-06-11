use axum::extract::{Extension, Query, State};
use axum::routing::{delete, get};
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use bigdecimal::ToPrimitive;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::audit;
use crate::server::error::ApiResult;
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/usage", get(list).delete(purge))
        .route("/api/admin/usage/summary", get(summary))
        // 调用日志清空（与 usage 共用表）
        .route("/api/admin/logs", delete(purge_logs))
}

// ----------------------------------------------------------------------------
// 一键清空（支持 ?before=YYYY-MM-DD 或 ?beforeTs=unix_secs）
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PurgeQuery {
    /// 仅清空 created_at < before 的记录；缺省 = 全部清空
    before: Option<String>,
    before_ts: Option<i64>,
    user_id: Option<i64>,
}

fn parse_before(q: &PurgeQuery) -> Option<NaiveDateTime> {
    if let Some(ts) = q.before_ts {
        return chrono::DateTime::from_timestamp(ts, 0).map(|d| d.naive_utc());
    }
    q.before.as_deref().and_then(|s| {
        // 支持 "2026-01-31" 或 "2026-01-31T12:34:56"
        if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            return Some(d.and_hms_opt(0, 0, 0)?);
        }
        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok()
    })
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<PurgeQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.delete.all")?;
    let before = parse_before(&q);
    let affected = match (before, q.user_id) {
        (Some(t), Some(uid)) => sqlx::query(
            "DELETE FROM usage_logs WHERE created_at < ? AND user_id = ?",
        )
        .bind(t)
        .bind(uid)
        .execute(&state.db)
        .await?
        .rows_affected(),
        (Some(t), None) => sqlx::query("DELETE FROM usage_logs WHERE created_at < ?")
            .bind(t)
            .execute(&state.db)
            .await?
            .rows_affected(),
        (None, Some(uid)) => sqlx::query("DELETE FROM usage_logs WHERE user_id = ?")
            .bind(uid)
            .execute(&state.db)
            .await?
            .rows_affected(),
        (None, None) => sqlx::query("DELETE FROM usage_logs")
            .execute(&state.db)
            .await?
            .rows_affected(),
    };
    audit::log(
        &state.db,
        ctx.user_id,
        "usage.purge",
        "usage_logs",
        None,
        None,
        Some(json!({ "deleted": affected, "user_id": q.user_id })),
    )
    .await;
    Ok(Json(json!({ "ok": true, "deleted": affected })))
}

async fn purge_logs(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<PurgeQuery>,
) -> ApiResult<Json<Value>> {
    // 暂时与 usage 共用底层表（usage_logs），但权限点独立
    ctx.require("log.delete.all")?;
    let before = parse_before(&q);
    let affected = match before {
        Some(t) => sqlx::query("DELETE FROM usage_logs WHERE created_at < ?")
            .bind(t)
            .execute(&state.db)
            .await?
            .rows_affected(),
        None => sqlx::query("DELETE FROM usage_logs")
            .execute(&state.db)
            .await?
            .rows_affected(),
    };
    audit::log(
        &state.db,
        ctx.user_id,
        "logs.purge",
        "usage_logs",
        None,
        None,
        Some(json!({ "deleted": affected })),
    )
    .await;
    Ok(Json(json!({ "ok": true, "deleted": affected })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    user_id: Option<i64>,
    model: Option<String>,
    limit: Option<u32>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct UsageRow {
    id: i64,
    user_id: i64,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: BigDecimal,
    pool: String,
    request_id: Option<String>,
    created_at: Option<NaiveDateTime>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let limit = q.limit.unwrap_or(200).min(1000) as i64;
    let rows: Vec<UsageRow> = if let Some(uid) = q.user_id {
        if let Some(m) = q.model {
            sqlx::query_as(
                "SELECT id,user_id,model,input_tokens,output_tokens,cost_usd,pool,request_id,created_at \
                 FROM usage_logs WHERE user_id=? AND model=? ORDER BY id DESC LIMIT ?",
            )
            .bind(uid)
            .bind(m)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as(
                "SELECT id,user_id,model,input_tokens,output_tokens,cost_usd,pool,request_id,created_at \
                 FROM usage_logs WHERE user_id=? ORDER BY id DESC LIMIT ?",
            )
            .bind(uid)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        }
    } else {
        sqlx::query_as(
            "SELECT id,user_id,model,input_tokens,output_tokens,cost_usd,pool,request_id,created_at \
             FROM usage_logs ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(json!({ "ok": true, "logs": rows })))
}

async fn summary(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let rows: Vec<(String, Option<BigDecimal>, Option<BigDecimal>, Option<BigDecimal>)> = if let Some(uid) = q.user_id {
        sqlx::query_as(
            "SELECT model, SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) \
             FROM usage_logs WHERE user_id = ? GROUP BY model",
        )
        .bind(uid)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT model, SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) \
             FROM usage_logs GROUP BY model",
        )
        .fetch_all(&state.db)
        .await?
    };
    let by_model: Vec<Value> = rows
        .into_iter()
        .map(|(model, input, output, cost)| {
            json!({
                "model": model,
                "inputTokens": input.and_then(|d| d.to_i64()).unwrap_or(0),
                "outputTokens": output.and_then(|d| d.to_i64()).unwrap_or(0),
                "costUsd": cost.map(|d| d.to_string()).unwrap_or_else(|| "0".into()),
            })
        })
        .collect();
    Ok(Json(json!({ "ok": true, "byModel": by_model })))
}
