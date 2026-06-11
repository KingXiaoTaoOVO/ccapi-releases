use axum::extract::{Extension, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::{Duration, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::ApiResult;
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/user/me/quota", get(quota))
        .route("/api/user/me/subscription", get(subscription))
        .route("/api/user/me/usage", get(usage))
        .route("/api/user/me/invitations", get(my_invites))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    limit_usd: f64,
    used_usd: f64,
    remaining_usd: f64,
    used_pct: f64,
    reset_at: Option<NaiveDateTime>,
    reset_in_secs: i64,
}

async fn quota(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let row: Option<(BigDecimal, BigDecimal, BigDecimal)> = sqlx::query_as(
        "SELECT bonus_remaining_usd, base_remaining_usd, total_consumed_usd FROM user_quota WHERE user_id = ?",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;
    let (bonus, base, consumed) = row
        .map(|(a, b, c)| (a, b, c))
        .unwrap_or_else(|| (BigDecimal::from(0), BigDecimal::from(0), BigDecimal::from(0)));

    // 当前订阅
    let sub: Option<(BigDecimal, BigDecimal, String, NaiveDateTime)> = sqlx::query_as(
        "SELECT t.quota_5h_usd, t.quota_7d_usd, t.code, s.expires_at \
         FROM user_subscriptions s JOIN tiers t ON t.id = s.tier_id \
         WHERE s.user_id = ? AND s.expires_at > NOW() \
         ORDER BY s.expires_at DESC LIMIT 1",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;

    let (q5, q7, tier_code, expires) = match &sub {
        Some((a, b, c, d)) => (
            a.to_f64().unwrap_or(0.0),
            b.to_f64().unwrap_or(0.0),
            Some(c.clone()),
            Some(*d),
        ),
        None => (0.0, 0.0, None, None),
    };

    // Redis 滑动窗口聚合
    let mut conn = state.redis.clone();
    let now = Utc::now();
    let used_5h: f64 = sum_window(&mut conn, ctx.user_id, "5h", 5 * 3600).await;
    let used_7d: f64 = sum_window(&mut conn, ctx.user_id, "7d", 7 * 24 * 3600).await;

    let window_5h = WindowState {
        limit_usd: q5,
        used_usd: used_5h,
        remaining_usd: (q5 - used_5h).max(0.0),
        used_pct: if q5 > 0.0 { (used_5h / q5) * 100.0 } else { 0.0 },
        reset_at: Some((now + Duration::hours(5)).naive_utc()),
        reset_in_secs: 5 * 3600,
    };
    let window_7d = WindowState {
        limit_usd: q7,
        used_usd: used_7d,
        remaining_usd: (q7 - used_7d).max(0.0),
        used_pct: if q7 > 0.0 { (used_7d / q7) * 100.0 } else { 0.0 },
        reset_at: Some((now + Duration::days(7)).naive_utc()),
        reset_in_secs: 7 * 24 * 3600,
    };

    Ok(Json(json!({
        "ok": true,
        "bonusRemainingUsd": bonus.to_string(),
        "baseRemainingUsd": base.to_string(),
        "totalConsumedUsd": consumed.to_string(),
        "tier": tier_code,
        "tierExpiresAt": expires,
        "window5h": window_5h,
        "window7d": window_7d,
    })))
}

async fn sum_window(
    conn: &mut redis::aio::ConnectionManager,
    user_id: i64,
    window_label: &str,
    span_secs: i64,
) -> f64 {
    let now = Utc::now().timestamp();
    let bucket = if window_label == "5h" { 300 } else { 6 * 3600 };
    let buckets = span_secs / bucket;
    let mut total = 0.0;
    for i in 0..buckets {
        let ts = (now - i * bucket) / bucket * bucket;
        let key = format!("usage:{}:{}:{}", user_id, window_label, ts);
        let v: Option<f64> = redis::cmd("GET")
            .arg(&key)
            .query_async(conn)
            .await
            .ok()
            .flatten();
        total += v.unwrap_or(0.0);
    }
    total
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct SubscriptionRow {
    id: i64,
    tier_id: i64,
    started_at: NaiveDateTime,
    expires_at: NaiveDateTime,
    source: String,
}

async fn subscription(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<SubscriptionRow> = sqlx::query_as(
        "SELECT id, tier_id, started_at, expires_at, source FROM user_subscriptions WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "subscriptions": rows })))
}

#[derive(Deserialize)]
struct UsageQuery {
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct UsageLogRow {
    id: i64,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: BigDecimal,
    pool: String,
    request_id: Option<String>,
    created_at: Option<NaiveDateTime>,
}

async fn usage(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<UsageQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(200).min(2000) as i64;
    let rows: Vec<UsageLogRow> = sqlx::query_as(
        "SELECT id, model, input_tokens, output_tokens, cost_usd, pool, request_id, created_at \
         FROM usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(ctx.user_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "logs": rows })))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct InviteRow {
    id: i64,
    inviter_id: i64,
    invitee_id: i64,
    reward_inviter_usd: Option<BigDecimal>,
    reward_invitee_usd: Option<BigDecimal>,
    created_at: Option<NaiveDateTime>,
}

async fn my_invites(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<InviteRow> = sqlx::query_as(
        "SELECT id, inviter_id, invitee_id, reward_inviter_usd, reward_invitee_usd, created_at \
         FROM invitations WHERE inviter_id = ? ORDER BY id DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    let total_reward: f64 = rows
        .iter()
        .map(|r| {
            r.reward_inviter_usd
                .as_ref()
                .and_then(|d| d.to_f64())
                .unwrap_or(0.0)
        })
        .sum();
    let me: (Option<String>,) =
        sqlx::query_as("SELECT invite_code FROM users WHERE id = ?")
            .bind(ctx.user_id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(json!({
        "ok": true,
        "inviteCode": me.0,
        "invitations": rows,
        "totalRewardUsd": total_reward,
    })))
}
