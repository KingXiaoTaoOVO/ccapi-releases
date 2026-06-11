//! 通用数据导出（GDPR-like）。
//!
//! 用户：
//!   GET /api/me/export/usage.csv      下载自己的全部 usage_logs
//!   GET /api/me/export/account.json   下载自己账号的全部相关数据（usage + 订阅 + 邀请）
//!
//! 管理员：
//!   GET /api/admin/export/usage.csv?days=30&userId=...
//!   GET /api/admin/export/orders.csv?days=30
//!   GET /api/admin/export/users.csv

use axum::extract::{Extension, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::error::ApiResult;
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/export/usage.csv", get(my_usage_csv))
        .route("/api/me/export/account.json", get(my_account_json))
        .route("/api/admin/export/usage.csv", get(admin_usage_csv))
        .route("/api/admin/export/orders.csv", get(admin_orders_csv))
        .route("/api/admin/export/users.csv", get(admin_users_csv))
}

fn csv_response(filename: &str, body: Vec<u8>) -> Response {
    let mut h = HeaderMap::new();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or(HeaderValue::from_static("attachment")),
    );
    (StatusCode::OK, h, body).into_response()
}

// ============================================================================
// 我的数据
// ============================================================================

async fn my_usage_csv(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Response> {
    let rows: Vec<(
        i64,
        String,
        i64,
        i64,
        BigDecimal,
        String,
        Option<String>,
        Option<NaiveDateTime>,
    )> = sqlx::query_as(
        "SELECT id, model, input_tokens, output_tokens, cost_usd, COALESCE(source,'official'), \
                request_id, created_at \
         FROM usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100000",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;

    let mut buf = Vec::new();
    {
        let mut w = csv::Writer::from_writer(&mut buf);
        w.write_record(["id", "model", "input_tokens", "output_tokens", "cost_usd", "source", "request_id", "created_at"]).ok();
        for (id, m, i, o, c, s, rid, at) in rows {
            w.write_record([
                id.to_string(),
                m,
                i.to_string(),
                o.to_string(),
                c.to_string(),
                s,
                rid.unwrap_or_default(),
                at.map(|t| t.to_string()).unwrap_or_default(),
            ])
            .ok();
        }
        w.flush().ok();
    }
    Ok(csv_response("usage.csv", buf))
}

async fn my_account_json(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let user: (i64, String, Option<String>, Option<NaiveDateTime>) = sqlx::query_as(
        "SELECT id, username, email, created_at FROM users WHERE id = ?",
    )
    .bind(ctx.user_id)
    .fetch_one(&state.db)
    .await?;
    let usage: Vec<(String, i64, i64, BigDecimal, Option<NaiveDateTime>)> = sqlx::query_as(
        "SELECT model, input_tokens, output_tokens, cost_usd, created_at \
         FROM usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100000",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    let subs: Vec<(i64, NaiveDateTime, NaiveDateTime)> = sqlx::query_as(
        "SELECT tier_id, started_at, expires_at FROM user_subscriptions \
         WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    let invites: Vec<(i64, BigDecimal, BigDecimal, NaiveDateTime)> = sqlx::query_as(
        "SELECT invitee_id, reward_inviter_usd, reward_invitee_usd, created_at \
         FROM invitations WHERE inviter_id = ?",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({
        "ok": true,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "user": {
            "id": user.0, "username": user.1, "email": user.2, "createdAt": user.3,
        },
        "usage": usage.iter().map(|(m,i,o,c,t)| json!({
            "model": m, "inputTokens": i, "outputTokens": o,
            "costUsd": c.to_string(), "createdAt": t
        })).collect::<Vec<_>>(),
        "subscriptions": subs.iter().map(|(t,s,e)| json!({
            "tierId": t, "startedAt": s, "expiresAt": e
        })).collect::<Vec<_>>(),
        "invitations": invites.iter().map(|(iid,ri,rv,t)| json!({
            "inviteeId": iid, "rewardInviter": ri.to_string(),
            "rewardInvitee": rv.to_string(), "createdAt": t
        })).collect::<Vec<_>>(),
    })))
}

// ============================================================================
// 管理员
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsageQuery {
    days: Option<u32>,
    user_id: Option<i64>,
}

async fn admin_usage_csv(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<AdminUsageQuery>,
) -> ApiResult<Response> {
    ctx.require("usage.read.all")?;
    let days = q.days.unwrap_or(30).min(365) as i64;
    let rows: Vec<(
        i64,
        i64,
        String,
        i64,
        i64,
        BigDecimal,
        String,
        Option<NaiveDateTime>,
    )> = if let Some(uid) = q.user_id {
        sqlx::query_as(
            "SELECT id, user_id, model, input_tokens, output_tokens, cost_usd, \
                    COALESCE(source,'official'), created_at \
             FROM usage_logs WHERE user_id = ? AND \
             created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY id DESC LIMIT 500000",
        )
        .bind(uid)
        .bind(days)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, user_id, model, input_tokens, output_tokens, cost_usd, \
                    COALESCE(source,'official'), created_at \
             FROM usage_logs WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) \
             ORDER BY id DESC LIMIT 500000",
        )
        .bind(days)
        .fetch_all(&state.db)
        .await?
    };
    let mut buf = Vec::new();
    {
        let mut w = csv::Writer::from_writer(&mut buf);
        w.write_record(["id","user_id","model","input_tokens","output_tokens","cost_usd","source","created_at"]).ok();
        for (id, uid, m, i, o, c, s, t) in rows {
            w.write_record([
                id.to_string(),
                uid.to_string(),
                m,
                i.to_string(),
                o.to_string(),
                c.to_string(),
                s,
                t.map(|x| x.to_string()).unwrap_or_default(),
            ])
            .ok();
        }
        w.flush().ok();
    }
    Ok(csv_response("usage_admin.csv", buf))
}

async fn admin_orders_csv(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Response> {
    ctx.require("config.read")?;
    let rows: Vec<(
        i64,
        String,
        i64,
        String,
        BigDecimal,
        String,
        String,
        Option<NaiveDateTime>,
    )> = sqlx::query_as(
        "SELECT id, order_no, user_id, provider, amount_usd, currency, status, paid_at \
         FROM recharge_orders ORDER BY id DESC LIMIT 500000",
    )
    .fetch_all(&state.db)
    .await?;
    let mut buf = Vec::new();
    {
        let mut w = csv::Writer::from_writer(&mut buf);
        w.write_record(["id","order_no","user_id","provider","amount_usd","currency","status","paid_at"]).ok();
        for (id, no, uid, p, a, cur, st, t) in rows {
            w.write_record([
                id.to_string(),
                no,
                uid.to_string(),
                p,
                a.to_string(),
                cur,
                st,
                t.map(|x| x.to_string()).unwrap_or_default(),
            ])
            .ok();
        }
        w.flush().ok();
    }
    Ok(csv_response("recharge_orders.csv", buf))
}

async fn admin_users_csv(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Response> {
    ctx.require("user.read")?;
    let rows: Vec<(
        i64,
        String,
        Option<String>,
        String,
        Option<NaiveDateTime>,
    )> = sqlx::query_as(
        "SELECT id, username, email, status, created_at FROM users ORDER BY id",
    )
    .fetch_all(&state.db)
    .await?;
    let mut buf = Vec::new();
    {
        let mut w = csv::Writer::from_writer(&mut buf);
        w.write_record(["id", "username", "email", "status", "created_at"]).ok();
        for (id, u, e, s, t) in rows {
            w.write_record([
                id.to_string(),
                u,
                e.unwrap_or_default(),
                s,
                t.map(|x| x.to_string()).unwrap_or_default(),
            ])
            .ok();
        }
        w.flush().ok();
    }
    Ok(csv_response("users.csv", buf))
}
