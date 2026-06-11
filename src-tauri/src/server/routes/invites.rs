use axum::extract::{Extension, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::audit;
use crate::server::error::ApiResult;
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/invitations", get(list).delete(purge))
        .route("/api/admin/invitations/stats", get(stats))
}

// ----------------------------------------------------------------------------
// 一键清空邀请记录（与 usage 的语义保持一致）
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PurgeQuery {
    before: Option<String>,
    before_ts: Option<i64>,
    inviter_id: Option<i64>,
}

fn parse_before(q: &PurgeQuery) -> Option<NaiveDateTime> {
    if let Some(ts) = q.before_ts {
        return chrono::DateTime::from_timestamp(ts, 0).map(|d| d.naive_utc());
    }
    q.before.as_deref().and_then(|s| {
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
    ctx.require("invite.delete.all")?;
    let before = parse_before(&q);
    let affected = match (before, q.inviter_id) {
        (Some(t), Some(id)) => sqlx::query(
            "DELETE FROM invitations WHERE created_at < ? AND inviter_id = ?",
        )
        .bind(t)
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected(),
        (Some(t), None) => sqlx::query("DELETE FROM invitations WHERE created_at < ?")
            .bind(t)
            .execute(&state.db)
            .await?
            .rows_affected(),
        (None, Some(id)) => sqlx::query("DELETE FROM invitations WHERE inviter_id = ?")
            .bind(id)
            .execute(&state.db)
            .await?
            .rows_affected(),
        (None, None) => sqlx::query("DELETE FROM invitations")
            .execute(&state.db)
            .await?
            .rows_affected(),
    };
    audit::log(
        &state.db,
        ctx.user_id,
        "invitations.purge",
        "invitations",
        None,
        None,
        Some(json!({ "deleted": affected, "inviter_id": q.inviter_id })),
    )
    .await;
    Ok(Json(json!({ "ok": true, "deleted": affected })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    inviter_id: Option<i64>,
    limit: Option<u32>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct InviteRow {
    id: i64,
    inviter_id: i64,
    inviter_name: String,
    invitee_id: i64,
    invitee_name: String,
    reward_inviter_usd: Option<BigDecimal>,
    reward_invitee_usd: Option<BigDecimal>,
    created_at: Option<NaiveDateTime>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("invite.read.all")?;
    let limit = q.limit.unwrap_or(200).min(2000) as i64;
    let rows: Vec<InviteRow> = if let Some(id) = q.inviter_id {
        sqlx::query_as(
            "SELECT i.id, i.inviter_id, ur.username AS inviter_name, \
             i.invitee_id, ue.username AS invitee_name, \
             i.reward_inviter_usd, i.reward_invitee_usd, i.created_at \
             FROM invitations i \
             JOIN users ur ON ur.id = i.inviter_id \
             JOIN users ue ON ue.id = i.invitee_id \
             WHERE i.inviter_id = ? \
             ORDER BY i.id DESC LIMIT ?",
        )
        .bind(id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT i.id, i.inviter_id, ur.username AS inviter_name, \
             i.invitee_id, ue.username AS invitee_name, \
             i.reward_inviter_usd, i.reward_invitee_usd, i.created_at \
             FROM invitations i \
             JOIN users ur ON ur.id = i.inviter_id \
             JOIN users ue ON ue.id = i.invitee_id \
             ORDER BY i.id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(json!({ "ok": true, "invitations": rows })))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct LeaderRow {
    inviter_id: i64,
    inviter_name: String,
    invited_count: i64,
    total_reward_usd: Option<BigDecimal>,
}

async fn stats(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("invite.read.all")?;
    let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM invitations")
        .fetch_one(&state.db)
        .await?;
    let total_reward: (Option<BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(reward_inviter_usd) + SUM(reward_invitee_usd), 0) FROM invitations",
    )
    .fetch_one(&state.db)
    .await?;
    let leaderboard: Vec<LeaderRow> = sqlx::query_as(
        "SELECT i.inviter_id, u.username AS inviter_name, COUNT(*) AS invited_count, \
         SUM(i.reward_inviter_usd) AS total_reward_usd \
         FROM invitations i JOIN users u ON u.id = i.inviter_id \
         GROUP BY i.inviter_id, u.username \
         ORDER BY invited_count DESC LIMIT 20",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "ok": true,
        "totalInvites": total.0,
        "totalRewardUsd": total_reward.0.map(|d| d.to_string()).unwrap_or_else(|| "0".into()),
        "leaderboard": leaderboard,
    })))
}
