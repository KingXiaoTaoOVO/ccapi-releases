//! 用户订阅自助：购买 / 续费 / 退订 / 自动续费开关。
//!
//! 计费：从 `user_quota.base_remaining_usd` 扣 `tiers.price_usd`；不够则拒绝。
//! 自动续费仅记录开关，真正"到期自动扣费"需要外部 cron 调
//! `/api/admin/subscriptions/run-auto-renew`（本轮也提供，但需 admin 手动触发）。

use axum::extract::{Extension, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::{Duration, NaiveDateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/subscription/renew", post(renew))
        .route("/api/me/subscription/cancel", post(cancel))
        .route(
            "/api/me/subscription/auto-renew",
            get(get_auto_renew).post(set_auto_renew),
        )
        .route(
            "/api/admin/subscriptions/run-auto-renew",
            post(run_auto_renew),
        )
}

const RENEW_DAYS: i64 = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenewBody {
    tier_id: i64,
}

async fn renew(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<RenewBody>,
) -> ApiResult<Json<Value>> {
    do_charge_and_extend(&state, ctx.user_id, body.tier_id).await
}

async fn cancel(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    // 直接把活跃订阅的 expires_at 改成 NOW（不退余款），同时关掉自动续费
    let res = sqlx::query(
        "UPDATE user_subscriptions SET expires_at = NOW() \
         WHERE user_id = ? AND expires_at > NOW()",
    )
    .bind(ctx.user_id)
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE subscription_auto_renew SET enabled = 0 WHERE user_id = ?")
        .bind(ctx.user_id)
        .execute(&state.db)
        .await
        .ok();
    Ok(Json(json!({ "ok": true, "cancelled": res.rows_affected() })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoRenewBody {
    enabled: bool,
    /// 启用时必填
    tier_id: Option<i64>,
}

async fn get_auto_renew(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let row: Option<(i64, i8)> = sqlx::query_as(
        "SELECT tier_id, enabled FROM subscription_auto_renew WHERE user_id = ?",
    )
    .bind(ctx.user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(json!({
        "ok": true,
        "tierId": row.as_ref().map(|(t, _)| t),
        "enabled": row.map(|(_, e)| e != 0).unwrap_or(false),
    })))
}

async fn set_auto_renew(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<AutoRenewBody>,
) -> ApiResult<Json<Value>> {
    if body.enabled && body.tier_id.is_none() {
        return Err(ApiError::BadRequest(
            "启用自动续费必须指定 tierId".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO subscription_auto_renew (user_id, tier_id, enabled) \
         VALUES (?, ?, ?) \
         ON DUPLICATE KEY UPDATE tier_id = VALUES(tier_id), enabled = VALUES(enabled)",
    )
    .bind(ctx.user_id)
    .bind(body.tier_id.unwrap_or(0))
    .bind(if body.enabled { 1i8 } else { 0 })
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 实际扣费 + 延长订阅
// ============================================================================

async fn do_charge_and_extend(
    state: &AppState,
    user_id: i64,
    tier_id: i64,
) -> ApiResult<Json<Value>> {
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| ApiError::Database(e.to_string()))?;

    // 取 tier 价格
    let tier: Option<(BigDecimal, i8)> = sqlx::query_as(
        "SELECT price_usd, enabled FROM tiers WHERE id = ?",
    )
    .bind(tier_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (price, enabled) =
        tier.ok_or_else(|| ApiError::NotFound("订阅档位不存在".into()))?;
    if enabled == 0 {
        return Err(ApiError::BadRequest("该档位已停用".into()));
    }
    let price_f = price.to_f64().unwrap_or(0.0);

    // 扣 base_remaining_usd
    let bal: Option<(BigDecimal,)> = sqlx::query_as(
        "SELECT base_remaining_usd FROM user_quota WHERE user_id = ? FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let base = bal
        .map(|(b,)| b.to_f64().unwrap_or(0.0))
        .unwrap_or(0.0);
    if base < price_f {
        return Err(ApiError::QuotaExhausted(format!(
            "基础额度不足（需 ${:.2}，当前 ${:.2}）",
            price_f, base
        )));
    }
    let new_balance =
        BigDecimal::try_from(base - price_f).unwrap_or_default();
    sqlx::query(
        "INSERT INTO user_quota (user_id, bonus_remaining_usd, base_remaining_usd) \
         VALUES (?, 0, ?) \
         ON DUPLICATE KEY UPDATE base_remaining_usd = VALUES(base_remaining_usd)",
    )
    .bind(user_id)
    .bind(&new_balance)
    .execute(&mut *tx)
    .await?;

    // 当前活跃订阅 → 在其 expires_at 上 +30 天；否则从 NOW +30 天
    let current: Option<(NaiveDateTime,)> = sqlx::query_as(
        "SELECT expires_at FROM user_subscriptions \
         WHERE user_id = ? AND expires_at > NOW() \
         ORDER BY expires_at DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let base_time = current
        .map(|(t,)| t)
        .unwrap_or_else(|| Utc::now().naive_utc());
    let new_expires = base_time + Duration::days(RENEW_DAYS);

    sqlx::query(
        "INSERT INTO user_subscriptions \
         (user_id, tier_id, started_at, expires_at, source) \
         VALUES (?, ?, NOW(), ?, 'admin')",
    )
    .bind(user_id)
    .bind(tier_id)
    .bind(new_expires)
    .execute(&mut *tx)
    .await?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Database(e.to_string()))?;
    Ok(Json(json!({
        "ok": true,
        "expiresAt": new_expires.format("%Y-%m-%dT%H:%M:%S").to_string(),
        "balance": new_balance.to_string(),
    })))
}

// ============================================================================
// 管理员手动触发自动续费（cron 兜底）
// ============================================================================

async fn run_auto_renew(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let due: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT ar.user_id, ar.tier_id FROM subscription_auto_renew ar \
         LEFT JOIN ( \
             SELECT user_id, MAX(expires_at) AS exp FROM user_subscriptions GROUP BY user_id \
         ) s ON s.user_id = ar.user_id \
         WHERE ar.enabled = 1 AND (s.exp IS NULL OR s.exp < DATE_ADD(NOW(), INTERVAL 1 DAY))",
    )
    .fetch_all(&state.db)
    .await?;

    let mut renewed = 0usize;
    let mut failed = 0usize;
    for (uid, tid) in due {
        match do_charge_and_extend(&state, uid, tid).await {
            Ok(_) => renewed += 1,
            Err(_) => failed += 1,
        }
    }
    Ok(Json(json!({ "ok": true, "renewed": renewed, "failed": failed })))
}
