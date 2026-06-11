//! 每日签到送额度（对应 NewAPI checkin.go）。
//!
//! 规则：
//! - 每个用户每天最多签到一次（按服务端时区的 DATE 唯一）
//! - 连续签到 streak 累计；断签后从 1 重新算
//! - 奖励：base $0.10 + min(streak / 10, 1.0) bonus，最多 $0.50/天
//! - 直接加到 user_quota.bonus_remaining_usd
//!
//! 路由：
//!   GET   /api/me/checkin              查询今日是否已签 + streak 信息
//!   POST  /api/me/checkin              执行签到

use axum::extract::{Extension, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/me/checkin", get(status).post(checkin))
}

async fn status(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let today = Utc::now().date_naive();
    let row: Option<(NaiveDate, i32, f64)> = sqlx::query_as(
        "SELECT checked_on, streak, CAST(reward_usd AS DOUBLE) \
         FROM daily_checkins WHERE user_id = ? ORDER BY checked_on DESC LIMIT 1",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;
    let (checked_today, streak, last_reward) = match row {
        Some((d, s, r)) if d == today => (true, s, r),
        Some((_, s, r)) => (false, s, r),
        None => (false, 0, 0.0),
    };
    Ok(Json(json!({
        "ok": true,
        "checkedToday": checked_today,
        "streak": streak,
        "lastRewardUsd": last_reward,
    })))
}

async fn checkin(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let today = Utc::now().date_naive();
    let yesterday = today - Duration::days(1);

    let mut tx = state.db.begin().await?;

    // 今天已签
    let exists: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM daily_checkins WHERE user_id = ? AND checked_on = ?",
    )
    .bind(ctx.user_id)
    .bind(today)
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_some() {
        return Err(ApiError::Conflict("今天已经签过到啦".into()));
    }

    // 计算 streak：昨天是否签过
    let last: Option<(NaiveDate, i32)> = sqlx::query_as(
        "SELECT checked_on, streak FROM daily_checkins WHERE user_id = ? \
         ORDER BY checked_on DESC LIMIT 1",
    )
    .bind(ctx.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let streak = match last {
        Some((d, s)) if d == yesterday => s + 1,
        _ => 1,
    };

    // 奖励 = base 0.10 + min(streak / 10, 0.40)
    let base = 0.10f64;
    let bonus = ((streak as f64 / 10.0).min(0.40)).max(0.0);
    let reward = base + bonus;

    sqlx::query(
        "INSERT INTO daily_checkins (user_id, checked_on, reward_usd, streak) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(ctx.user_id)
    .bind(today)
    .bind(reward)
    .bind(streak)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO user_quota (user_id, bonus_remaining_usd, base_remaining_usd) \
         VALUES (?, ?, 0) \
         ON DUPLICATE KEY UPDATE bonus_remaining_usd = bonus_remaining_usd + VALUES(bonus_remaining_usd)",
    )
    .bind(ctx.user_id)
    .bind(reward)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "ok": true,
        "streak": streak,
        "rewardUsd": reward,
    })))
}
