use axum::extract::{Extension, Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/codes", get(list).post(generate))
        .route("/api/admin/codes/{id}", axum::routing::delete(remove))
        .route("/api/admin/codes/export", get(export))
        .route("/api/user/redeem", post(redeem))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    #[serde(default)]
    code_type: Option<String>,
    #[serde(default)]
    batch_id: Option<String>,
    #[serde(default)]
    redeemed: Option<bool>,
    #[serde(default = "default_limit")]
    limit: u32,
}
fn default_limit() -> u32 {
    200
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct CodeRow {
    id: i64,
    code: String,
    code_type: String,
    payload: sqlx::types::Json<Value>,
    expires_at: Option<NaiveDateTime>,
    redeemed_by: Option<i64>,
    redeemed_at: Option<NaiveDateTime>,
    batch_id: Option<String>,
    created_at: Option<NaiveDateTime>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("code.read")?;
    let limit = q.limit.min(2000) as i64;
    let mut sql =
        "SELECT id, code, code_type, payload, expires_at, redeemed_by, redeemed_at, batch_id, created_at \
         FROM activation_codes WHERE 1=1"
            .to_string();
    if q.code_type.is_some() {
        sql.push_str(" AND code_type = ?");
    }
    if q.batch_id.is_some() {
        sql.push_str(" AND batch_id = ?");
    }
    if let Some(b) = q.redeemed {
        sql.push_str(if b {
            " AND redeemed_by IS NOT NULL"
        } else {
            " AND redeemed_by IS NULL"
        });
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");

    let mut qb = sqlx::query_as::<_, CodeRow>(&sql);
    if let Some(c) = &q.code_type {
        qb = qb.bind(c);
    }
    if let Some(b) = &q.batch_id {
        qb = qb.bind(b);
    }
    qb = qb.bind(limit);
    let rows = qb.fetch_all(&state.db).await?;
    Ok(Json(json!({ "ok": true, "codes": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateBody {
    count: u32,
    code_type: String,
    payload: Value,
    expires_at: Option<DateTime<Utc>>,
}

async fn generate(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<GenerateBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("code.create")?;
    if body.count == 0 || body.count > 10000 {
        return Err(ApiError::BadRequest("数量必须在 1-10000".into()));
    }
    if !matches!(body.code_type.as_str(), "role" | "quota_usd" | "quota_token") {
        return Err(ApiError::BadRequest("不支持的激活码类型".into()));
    }
    let batch_id = format!(
        "B{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S")
    );
    let payload_json = sqlx::types::Json(body.payload.clone());
    let expires = body.expires_at.map(|d| d.naive_utc());
    let mut codes = Vec::with_capacity(body.count as usize);
    for _ in 0..body.count {
        let code = generate_code();
        codes.push(code);
    }
    let mut tx = state.db.begin().await?;
    for code in &codes {
        sqlx::query(
            "INSERT INTO activation_codes (code, code_type, payload, expires_at, batch_id, created_by) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(code)
        .bind(&body.code_type)
        .bind(&payload_json)
        .bind(expires)
        .bind(&batch_id)
        .bind(ctx.user_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({
        "ok": true,
        "batchId": batch_id,
        "count": codes.len(),
        "codes": codes,
    })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("code.delete")?;
    sqlx::query("DELETE FROM activation_codes WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportQuery {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    batch_id: Option<String>,
}

async fn export(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<ExportQuery>,
) -> ApiResult<impl IntoResponse> {
    ctx.require("code.export")?;
    let format = q.format.unwrap_or_else(|| "txt".to_string());
    let mut sql =
        "SELECT code, code_type, payload, expires_at, batch_id, redeemed_by, redeemed_at FROM activation_codes".to_string();
    if q.batch_id.is_some() {
        sql.push_str(" WHERE batch_id = ?");
    }
    sql.push_str(" ORDER BY id");
    let mut qb = sqlx::query_as::<_, (String, String, sqlx::types::Json<Value>, Option<NaiveDateTime>, Option<String>, Option<i64>, Option<NaiveDateTime>)>(&sql);
    if let Some(b) = &q.batch_id {
        qb = qb.bind(b);
    }
    let rows = qb.fetch_all(&state.db).await?;
    let bytes = match format.as_str() {
        "xlsx" => super::super::export::codes_to_xlsx(&rows)?,
        "csv" => super::super::export::codes_to_csv(&rows)?,
        _ => super::super::export::codes_to_txt(&rows),
    };
    let (mime, filename) = match format.as_str() {
        "xlsx" => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ccapi-codes.xlsx",
        ),
        "csv" => ("text/csv; charset=utf-8", "ccapi-codes.csv"),
        _ => ("text/plain; charset=utf-8", "ccapi-codes.txt"),
    };
    let headers = [
        (header::CONTENT_TYPE, mime.to_string()),
        (
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        ),
    ];
    Ok((headers, bytes))
}

// ---------- redeem ----------
#[derive(Deserialize)]
struct RedeemBody {
    code: String,
}

async fn redeem(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<RedeemBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("code.redeem")?;
    let code = body.code.trim().to_uppercase();
    if code.is_empty() {
        return Err(ApiError::BadRequest("请输入激活码".into()));
    }
    let mut tx = state.db.begin().await?;
    let row: Option<(i64, String, sqlx::types::Json<Value>, Option<NaiveDateTime>, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, code_type, payload, expires_at, redeemed_by FROM activation_codes WHERE code = ? FOR UPDATE",
        )
        .bind(&code)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((id, code_type, payload, expires_at, redeemed_by)) = row else {
        return Err(ApiError::NotFound("激活码不存在".into()));
    };
    if redeemed_by.is_some() {
        return Err(ApiError::Conflict("激活码已被使用".into()));
    }
    if let Some(exp) = expires_at {
        if exp < Utc::now().naive_utc() {
            return Err(ApiError::BadRequest("激活码已过期".into()));
        }
    }

    let mut tier_applied: Option<String> = None;
    let mut bonus_added = BigDecimal::from(0);

    match code_type.as_str() {
        "role" => {
            let tier_code = payload
                .0
                .get("tierCode")
                .or_else(|| payload.0.get("tier_code"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| ApiError::BadRequest("payload 缺少 tierCode".into()))?;
            let days = payload
                .0
                .get("durationDays")
                .or_else(|| payload.0.get("duration_days"))
                .and_then(|v| v.as_i64())
                .unwrap_or(30);
            let tier: Option<(i64,)> = sqlx::query_as("SELECT id FROM tiers WHERE code = ?")
                .bind(tier_code)
                .fetch_optional(&mut *tx)
                .await?;
            let Some((tier_id,)) = tier else {
                return Err(ApiError::NotFound("档位不存在".into()));
            };
            let now = Utc::now().naive_utc();
            let expires = now + chrono::Duration::days(days);
            sqlx::query(
                "INSERT INTO user_subscriptions (user_id, tier_id, started_at, expires_at, source, code_id) \
                 VALUES (?, ?, ?, ?, 'code', ?)",
            )
            .bind(ctx.user_id)
            .bind(tier_id)
            .bind(now)
            .bind(expires)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            tier_applied = Some(tier_code.to_string());
        }
        "quota_usd" => {
            let amount = payload
                .0
                .get("amountUsd")
                .or_else(|| payload.0.get("amount_usd"))
                .and_then(|v| v.as_f64())
                .ok_or_else(|| ApiError::BadRequest("payload 缺少 amountUsd".into()))?;
            sqlx::query(
                "INSERT INTO user_quota (user_id, bonus_remaining_usd) VALUES (?, ?) \
                 ON DUPLICATE KEY UPDATE bonus_remaining_usd = bonus_remaining_usd + VALUES(bonus_remaining_usd)",
            )
            .bind(ctx.user_id)
            .bind(amount)
            .execute(&mut *tx)
            .await?;
            bonus_added = BigDecimal::try_from(amount).unwrap_or_default();
        }
        "quota_token" => {
            // 等价于 USD 等量（简化）：用 payload.equivUsd 或者按 ratio 转换
            let equiv = payload
                .0
                .get("equivUsd")
                .or_else(|| payload.0.get("equiv_usd"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if equiv > 0.0 {
                sqlx::query(
                    "INSERT INTO user_quota (user_id, bonus_remaining_usd) VALUES (?, ?) \
                     ON DUPLICATE KEY UPDATE bonus_remaining_usd = bonus_remaining_usd + VALUES(bonus_remaining_usd)",
                )
                .bind(ctx.user_id)
                .bind(equiv)
                .execute(&mut *tx)
                .await?;
                bonus_added = BigDecimal::try_from(equiv).unwrap_or_default();
            }
        }
        _ => return Err(ApiError::BadRequest("不支持的激活码类型".into())),
    }

    sqlx::query(
        "UPDATE activation_codes SET redeemed_by = ?, redeemed_at = NOW() WHERE id = ?",
    )
    .bind(ctx.user_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "ok": true,
        "codeType": code_type,
        "tierApplied": tier_applied,
        "bonusAdded": bonus_added.to_string(),
    })))
}

// ---------- helpers ----------

fn generate_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let part = |n: usize, rng: &mut rand::rngs::ThreadRng| {
        (0..n)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect::<String>()
    };
    format!(
        "CCAPI-{}-{}-{}-{}",
        part(4, &mut rng),
        part(4, &mut rng),
        part(4, &mut rng),
        part(4, &mut rng)
    )
}
