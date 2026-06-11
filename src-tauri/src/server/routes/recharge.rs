//! 充值：EPay（易支付）+ Stripe，统一订单表 `recharge_orders`。
//!
//! **声明**：未在真实商户/Stripe 帐号下测试过。生产前请：
//!   - EPay：确认 `gateway` URL 是你商户后台给的实际地址，签名（MD5）规则正确
//!   - Stripe：把 `secretKey` / `webhookSecret` 配置到 payment_config 后台
//!
//! 路由：
//!   POST /api/me/recharge/create        {provider, amountUsd}  → 返回支付链接 / client_secret
//!   GET  /api/me/recharge/orders        我的订单
//!   POST /api/me/recharge/orders/{id}/cancel
//!   GET  /api/admin/recharge/orders     全站订单
//!   POST /api/recharge/epay/notify      EPay 异步回调（公开）
//!   POST /api/recharge/stripe/webhook   Stripe webhook（公开）

use axum::extract::{Extension, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use bigdecimal::BigDecimal;
use chrono::{NaiveDateTime, Utc};
use hmac::{Hmac, Mac};
use md5::{Digest as Md5Digest, Md5};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn protected_router() -> Router<AppState> {
    Router::new()
        .route("/api/me/recharge/create", post(create_order))
        .route("/api/me/recharge/orders", get(my_orders))
        .route(
            "/api/me/recharge/orders/{id}/cancel",
            post(cancel_my_order),
        )
        .route("/api/admin/recharge/orders", get(admin_orders))
}

pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/recharge/epay/notify", post(epay_notify))
        .route("/api/recharge/stripe/webhook", post(stripe_webhook))
}

// ============================================================================
// 配置
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct EpayCfg {
    enabled: bool,
    merchant_id: String,
    key: String,
    gateway: String,
    notify_url: String,
    return_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct StripeCfg {
    enabled: bool,
    publishable_key: String,
    secret_key: String,
    webhook_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct PaymentCfg {
    epay: EpayCfg,
    stripe: StripeCfg,
}

async fn load_payment_cfg(state: &AppState) -> ApiResult<PaymentCfg> {
    let row: Option<(sqlx::types::Json<Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'payment_config'")
            .fetch_optional(&state.db)
            .await?;
    Ok(row
        .and_then(|(j,)| serde_json::from_value(j.0).ok())
        .unwrap_or_default())
}

// ============================================================================
// 订单查询
// ============================================================================

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct OrderRow {
    id: i64,
    order_no: String,
    user_id: i64,
    provider: String,
    amount_usd: BigDecimal,
    currency: String,
    status: String,
    external_id: Option<String>,
    paid_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

async fn my_orders(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<OrderRow> = sqlx::query_as(
        "SELECT id, order_no, user_id, provider, amount_usd, currency, status, \
                external_id, paid_at, created_at \
         FROM recharge_orders WHERE user_id = ? ORDER BY id DESC LIMIT 200",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "ok": true,
        "orders": rows.iter().map(serialize_order).collect::<Vec<_>>()
    })))
}

#[derive(Deserialize)]
struct AdminListQuery {
    limit: Option<u32>,
    status: Option<String>,
}

async fn admin_orders(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<AdminListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let limit = q.limit.unwrap_or(200).min(2000) as i64;
    let rows: Vec<OrderRow> = if let Some(s) = q.status {
        sqlx::query_as(
            "SELECT id, order_no, user_id, provider, amount_usd, currency, status, \
                    external_id, paid_at, created_at \
             FROM recharge_orders WHERE status = ? ORDER BY id DESC LIMIT ?",
        )
        .bind(&s)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, order_no, user_id, provider, amount_usd, currency, status, \
                    external_id, paid_at, created_at \
             FROM recharge_orders ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(json!({
        "ok": true,
        "orders": rows.iter().map(serialize_order).collect::<Vec<_>>()
    })))
}

fn serialize_order(o: &OrderRow) -> Value {
    json!({
        "id": o.id,
        "orderNo": o.order_no,
        "userId": o.user_id,
        "provider": o.provider,
        "amountUsd": o.amount_usd.to_string(),
        "currency": o.currency,
        "status": o.status,
        "externalId": o.external_id,
        "paidAt": o.paid_at,
        "createdAt": o.created_at,
    })
}

// ============================================================================
// 创建订单
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrderBody {
    /// "epay" | "stripe"
    provider: String,
    amount_usd: f64,
}

fn gen_order_no() -> String {
    let ts = Utc::now().timestamp();
    let suffix: u32 = rand::thread_rng().gen();
    format!("CC{}{:08X}", ts, suffix)
}

async fn create_order(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<CreateOrderBody>,
) -> ApiResult<Json<Value>> {
    if body.amount_usd <= 0.0 || body.amount_usd > 10_000.0 {
        return Err(ApiError::BadRequest(
            "金额必须在 0.01 ~ 10000 USD 之间".into(),
        ));
    }
    let cfg = load_payment_cfg(&state).await?;
    let order_no = gen_order_no();
    sqlx::query(
        "INSERT INTO recharge_orders (order_no, user_id, provider, amount_usd, status) \
         VALUES (?, ?, ?, ?, 'pending')",
    )
    .bind(&order_no)
    .bind(ctx.user_id)
    .bind(&body.provider)
    .bind(body.amount_usd)
    .execute(&state.db)
    .await?;

    match body.provider.as_str() {
        "epay" => epay_create(&cfg.epay, &order_no, body.amount_usd, ctx.user_id),
        "stripe" => stripe_create(&state, &cfg.stripe, &order_no, body.amount_usd).await,
        _ => Err(ApiError::BadRequest("provider 必须是 epay / stripe".into())),
    }
}

async fn cancel_my_order(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let res = sqlx::query(
        "UPDATE recharge_orders SET status = 'cancelled' \
         WHERE id = ? AND user_id = ? AND status = 'pending'",
    )
    .bind(id)
    .bind(ctx.user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound(
            "订单不存在或非 pending 状态".into(),
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// EPay 实现
// ============================================================================

fn epay_create(
    cfg: &EpayCfg,
    order_no: &str,
    amount: f64,
    user_id: i64,
) -> ApiResult<Json<Value>> {
    if !cfg.enabled {
        return Err(ApiError::ServiceUnavailable("EPay 未启用".into()));
    }
    if cfg.gateway.is_empty() || cfg.merchant_id.is_empty() || cfg.key.is_empty() {
        return Err(ApiError::ServiceUnavailable("EPay 未配置完整".into()));
    }
    let mut params: Vec<(&str, String)> = vec![
        ("pid", cfg.merchant_id.clone()),
        ("type", "alipay".into()),
        ("out_trade_no", order_no.into()),
        ("notify_url", cfg.notify_url.clone()),
        ("return_url", cfg.return_url.clone()),
        ("name", format!("CCAPI 充值-{}", user_id)),
        ("money", format!("{:.2}", amount)),
        ("sign_type", "MD5".into()),
    ];
    let sign = epay_sign(&params, &cfg.key);
    params.push(("sign", sign));
    let mut url = url::Url::parse(&cfg.gateway).map_err(|e| ApiError::Internal(e.to_string()))?;
    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in &params {
            qp.append_pair(k, v);
        }
    }
    Ok(Json(json!({
        "ok": true,
        "provider": "epay",
        "orderNo": order_no,
        "redirectUrl": url.to_string(),
    })))
}

/// EPay 签名规则：字典序排序非空非 sign/sign_type 字段，拼成 key=value& 串，
/// 末尾追加商户 key（不加 &），MD5 大写或小写均可（这里按官方文档用小写）。
fn epay_sign(params: &[(&str, String)], merchant_key: &str) -> String {
    let mut filtered: Vec<(&str, &str)> = params
        .iter()
        .filter(|(k, v)| !v.is_empty() && *k != "sign" && *k != "sign_type")
        .map(|(k, v)| (*k, v.as_str()))
        .collect();
    filtered.sort_by(|a, b| a.0.cmp(b.0));
    let raw = filtered
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");
    let mut hasher = Md5::new();
    hasher.update(raw.as_bytes());
    hasher.update(merchant_key.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Deserialize)]
struct EpayNotify {
    pid: String,
    trade_no: String,
    out_trade_no: String,
    money: String,
    name: Option<String>,
    trade_status: String,
    sign: String,
    #[allow(dead_code)]
    sign_type: Option<String>,
    #[serde(rename = "type")]
    pay_type: Option<String>,
}

async fn epay_notify(
    State(state): State<AppState>,
    Json(notify): Json<EpayNotify>,
) -> ApiResult<String> {
    let cfg = load_payment_cfg(&state).await?.epay;
    if !cfg.enabled || cfg.key.is_empty() {
        return Err(ApiError::ServiceUnavailable("EPay 未启用".into()));
    }
    let params: Vec<(&str, String)> = vec![
        ("pid", notify.pid.clone()),
        ("trade_no", notify.trade_no.clone()),
        ("out_trade_no", notify.out_trade_no.clone()),
        ("money", notify.money.clone()),
        ("name", notify.name.clone().unwrap_or_default()),
        ("type", notify.pay_type.clone().unwrap_or_default()),
        ("trade_status", notify.trade_status.clone()),
    ];
    let expected = epay_sign(&params, &cfg.key);
    if expected != notify.sign.to_ascii_lowercase() {
        return Err(ApiError::BadRequest("签名校验失败".into()));
    }
    if notify.trade_status != "TRADE_SUCCESS" {
        return Ok("fail".into());
    }
    mark_order_paid(&state, &notify.out_trade_no, &notify.trade_no, "epay").await?;
    Ok("success".into())
}

// ============================================================================
// Stripe 实现
// ============================================================================

async fn stripe_create(
    state: &AppState,
    cfg: &StripeCfg,
    order_no: &str,
    amount_usd: f64,
) -> ApiResult<Json<Value>> {
    if !cfg.enabled {
        return Err(ApiError::ServiceUnavailable("Stripe 未启用".into()));
    }
    if cfg.secret_key.is_empty() {
        return Err(ApiError::ServiceUnavailable("Stripe secretKey 未配置".into()));
    }
    // Stripe 金额按"美分"计
    let amount_cents = (amount_usd * 100.0).round() as i64;
    let resp = reqwest::Client::new()
        .post("https://api.stripe.com/v1/payment_intents")
        .basic_auth(&cfg.secret_key, Some(""))
        .form(&[
            ("amount", amount_cents.to_string()),
            ("currency", "usd".into()),
            ("metadata[order_no]", order_no.to_string()),
            ("automatic_payment_methods[enabled]", "true".into()),
        ])
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("Stripe 调用失败: {e}")))?;
    let json_resp: Value = resp
        .json()
        .await
        .map_err(|e| ApiError::Internal(format!("Stripe 响应解析失败: {e}")))?;
    let intent_id = json_resp
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ApiError::Internal(format!("Stripe 未返回 PaymentIntent id: {}", json_resp))
        })?;
    let client_secret = json_resp
        .get("client_secret")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::Internal("Stripe 未返回 client_secret".into()))?;

    sqlx::query("UPDATE recharge_orders SET external_id = ? WHERE order_no = ?")
        .bind(intent_id)
        .bind(order_no)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({
        "ok": true,
        "provider": "stripe",
        "orderNo": order_no,
        "clientSecret": client_secret,
        "publishableKey": cfg.publishable_key,
    })))
}

async fn stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<String> {
    let cfg = load_payment_cfg(&state).await?.stripe;
    if !cfg.enabled {
        return Err(ApiError::ServiceUnavailable("Stripe 未启用".into()));
    }

    // 验签：Stripe-Signature: t=<ts>,v1=<hex hmac-sha256(t.body, secret)>
    if !cfg.webhook_secret.is_empty() {
        let sig_header = headers
            .get("stripe-signature")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::BadRequest("缺少 Stripe-Signature".into()))?;
        if !verify_stripe_sig(sig_header, &body, &cfg.webhook_secret) {
            return Err(ApiError::BadRequest("Stripe 签名校验失败".into()));
        }
    }

    let evt: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let event_type = evt
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if event_type != "payment_intent.succeeded" {
        return Ok("ignored".into());
    }
    let intent_id = evt
        .pointer("/data/object/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadRequest("payload 缺少 payment_intent.id".into()))?;
    let order_no = evt
        .pointer("/data/object/metadata/order_no")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadRequest("payload 缺少 metadata.order_no".into()))?;
    mark_order_paid(&state, order_no, intent_id, "stripe").await?;
    Ok("ok".into())
}

fn verify_stripe_sig(header: &str, body: &[u8], secret: &str) -> bool {
    let mut ts = None;
    let mut v1 = None;
    for part in header.split(',') {
        let (k, v) = match part.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        if k == "t" {
            ts = Some(v);
        } else if k == "v1" {
            v1 = Some(v);
        }
    }
    let (Some(t), Some(sig_hex)) = (ts, v1) else {
        return false;
    };
    let mut signed = Vec::with_capacity(t.len() + 1 + body.len());
    signed.extend_from_slice(t.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(body);
    let mut mac = match <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(&signed);
    let expected = hex::encode(mac.finalize().into_bytes());
    expected == sig_hex
}

// ============================================================================
// 公共：订单标记已付 + 给用户加额度
// ============================================================================

async fn mark_order_paid(
    state: &AppState,
    order_no: &str,
    external_id: &str,
    provider: &str,
) -> ApiResult<()> {
    let mut tx = state.db.begin().await.map_err(|e| ApiError::Database(e.to_string()))?;
    let row: Option<(i64, i64, BigDecimal, String)> = sqlx::query_as(
        "SELECT id, user_id, amount_usd, status FROM recharge_orders \
         WHERE order_no = ? FOR UPDATE",
    )
    .bind(order_no)
    .fetch_optional(&mut *tx)
    .await?;
    let (order_id, user_id, amount, status) =
        row.ok_or_else(|| ApiError::NotFound(format!("订单 {order_no} 不存在")))?;
    if status == "paid" {
        // 幂等：已处理过
        return Ok(());
    }
    sqlx::query(
        "UPDATE recharge_orders SET status='paid', external_id=?, paid_at=NOW() WHERE id = ?",
    )
    .bind(external_id)
    .bind(order_id)
    .execute(&mut *tx)
    .await?;
    // 加 base_remaining_usd（充值进基础额度，不进 bonus）
    sqlx::query(
        "INSERT INTO user_quota (user_id, bonus_remaining_usd, base_remaining_usd) \
         VALUES (?, 0, ?) \
         ON DUPLICATE KEY UPDATE base_remaining_usd = base_remaining_usd + VALUES(base_remaining_usd)",
    )
    .bind(user_id)
    .bind(&amount)
    .execute(&mut *tx)
    .await?;
    tx.commit().await.map_err(|e| ApiError::Database(e.to_string()))?;
    let _ = provider; // currently unused but kept for future audit log differentiation
    Ok(())
}
