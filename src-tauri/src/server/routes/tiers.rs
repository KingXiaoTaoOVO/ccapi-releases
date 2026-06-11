use axum::extract::{Extension, Path, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/tiers", get(list).post(create))
        .route("/api/admin/tiers/{id}", patch(update).delete(remove))
        .route("/api/tiers", get(public_list))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct TierRow {
    id: i64,
    code: String,
    display_name: String,
    price_usd: BigDecimal,
    quota_5h_usd: BigDecimal,
    quota_7d_usd: BigDecimal,
    multiplier: BigDecimal,
    features: Option<sqlx::types::Json<Value>>,
    enabled: i8,
    sort_order: i32,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("tier.read")?;
    let rows: Vec<TierRow> = sqlx::query_as(
        "SELECT id, code, display_name, price_usd, quota_5h_usd, quota_7d_usd, multiplier, \
         features, enabled, sort_order FROM tiers ORDER BY sort_order",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "tiers": rows })))
}

/// 公开档位列表（已登录的用户也能看，用来展示订阅档位）
async fn public_list(
    State(state): State<AppState>,
    Extension(_ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<TierRow> = sqlx::query_as(
        "SELECT id, code, display_name, price_usd, quota_5h_usd, quota_7d_usd, multiplier, \
         features, enabled, sort_order FROM tiers WHERE enabled = 1 ORDER BY sort_order",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "tiers": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertBody {
    code: Option<String>,
    display_name: String,
    price_usd: f64,
    quota_5h_usd: f64,
    quota_7d_usd: f64,
    multiplier: f64,
    enabled: Option<bool>,
    sort_order: Option<i32>,
    features: Option<Value>,
}

fn validate_tier_body(body: &UpsertBody) -> ApiResult<()> {
    if body.display_name.trim().is_empty() {
        return Err(ApiError::BadRequest("展示名称不能为空".into()));
    }
    if body.price_usd < 0.0
        || body.quota_5h_usd < 0.0
        || body.quota_7d_usd < 0.0
        || body.multiplier <= 0.0
    {
        return Err(ApiError::BadRequest(
            "价格/配额不可为负，倍率必须大于 0".into(),
        ));
    }
    Ok(())
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("tier.update")?;
    validate_tier_body(&body)?;
    let code = body
        .code
        .as_ref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::BadRequest("缺少 code".into()))?;
    if !code
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ApiError::BadRequest(
            "code 只允许字母/数字/下划线/连字符".into(),
        ));
    }
    let dup: Option<(i64,)> = sqlx::query_as("SELECT id FROM tiers WHERE code = ?")
        .bind(&code)
        .fetch_optional(&state.db)
        .await?;
    if dup.is_some() {
        return Err(ApiError::Conflict(format!("档位 code `{code}` 已存在")));
    }
    let res = sqlx::query(
        "INSERT INTO tiers (code, display_name, price_usd, quota_5h_usd, quota_7d_usd, multiplier, enabled, sort_order, features) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&code)
    .bind(&body.display_name)
    .bind(body.price_usd)
    .bind(body.quota_5h_usd)
    .bind(body.quota_7d_usd)
    .bind(body.multiplier)
    .bind(body.enabled.unwrap_or(true) as i8)
    .bind(body.sort_order.unwrap_or(100))
    .bind(body.features.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::Database(e.to_string()))?;
    Ok(Json(json!({ "ok": true, "id": res.last_insert_id() })))
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("tier.update")?;
    validate_tier_body(&body)?;
    let res = sqlx::query(
        "UPDATE tiers SET display_name=?, price_usd=?, quota_5h_usd=?, quota_7d_usd=?, multiplier=?, enabled=?, sort_order=?, features=? WHERE id=?",
    )
    .bind(&body.display_name)
    .bind(body.price_usd)
    .bind(body.quota_5h_usd)
    .bind(body.quota_7d_usd)
    .bind(body.multiplier)
    .bind(body.enabled.unwrap_or(true) as i8)
    .bind(body.sort_order.unwrap_or(100))
    .bind(body.features.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("档位不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("tier.update")?;
    // 不允许删除仍在活跃订阅中的档位（防止用户订阅指向无效档位）
    let active: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM user_subscriptions WHERE tier_id = ? AND expires_at > NOW()",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    if active.0 > 0 {
        return Err(ApiError::Conflict(format!(
            "仍有 {} 个活跃订阅在使用此档位，无法删除",
            active.0
        )));
    }
    let res = sqlx::query("DELETE FROM tiers WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("档位不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
