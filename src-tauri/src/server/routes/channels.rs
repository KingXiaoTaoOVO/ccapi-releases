//! 渠道管理（参考 NewAPI 简化版）。
//!
//! 设计要点：
//! - 字段集来自 NewAPI 的 Channel 模型，但只保留 CCAPI 当前阶段需要的字段。
//! - `key_encrypted` 第一版直接明文存（仍叫这个名字以便后续无痛升级），
//!   读取时再决定要不要透传给前端（这里不返回，只在 test/路由时使用）。
//! - 单条 / 批量测试：直接给上游 base_url + Authorization 发一个最小请求，
//!   测的是连通性 + Auth 有效性，不消耗额度。
//!
//! 路由：
//!   GET    /api/admin/channels                列表
//!   POST   /api/admin/channels                新建
//!   PATCH  /api/admin/channels/:id            修改
//!   DELETE /api/admin/channels/:id            删除
//!   POST   /api/admin/channels/:id/test       单测
//!   POST   /api/admin/channels/batch          批量启停 / 改 tag / 批量测试

use std::time::{Duration, Instant};

use axum::extract::{Extension, Path, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{NaiveDateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::crypto;
use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/channels", get(list).post(create))
        .route(
            "/api/admin/channels/{id}",
            patch(update).delete(remove),
        )
        .route("/api/admin/channels/{id}/test", post(test_one))
        .route("/api/admin/channels/batch", post(batch))
}

// ----------------------------------------------------------------------------
// 数据结构
// ----------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ChannelRow {
    id: i64,
    name: String,
    #[sqlx(rename = "type")]
    r#type: String,
    key_encrypted: String,
    base_url: Option<String>,
    models: Option<sqlx::types::Json<Value>>,
    model_mapping: Option<sqlx::types::Json<Value>>,
    param_override: Option<sqlx::types::Json<Value>>,
    priority: i32,
    weight: i32,
    status: i8,
    disabled_reason: Option<String>,
    group_id: Option<i64>,
    group_ids: Option<sqlx::types::Json<Value>>,
    key_state: Option<sqlx::types::Json<Value>>,
    auto_ban: i8,
    fail_threshold: i32,
    fail_count: i32,
    last_test_at: Option<NaiveDateTime>,
    last_test_ms: Option<i32>,
    last_test_ok: Option<i8>,
    tag: Option<String>,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

/// 把 ChannelRow 转成前端视图。`key_encrypted` 仅用于推导 key_summary（key 数量 /
/// strategy / weights），不会出现在返回值里。
fn row_to_view(r: &ChannelRow, jwt_secret: &str) -> Value {
    let summary = build_key_summary(&r.key_encrypted, r.key_state.as_ref(), jwt_secret);
    json!({
        "id": r.id,
        "name": r.name,
        "type": r.r#type,
        "baseUrl": r.base_url,
        "models": r.models.as_ref().map(|j| &j.0),
        "modelMapping": r.model_mapping.as_ref().map(|j| &j.0),
        "paramOverride": r.param_override.as_ref().map(|j| &j.0),
        "priority": r.priority,
        "weight": r.weight,
        "status": r.status,
        "disabledReason": r.disabled_reason,
        "groupId": r.group_id,
        "groupIds": r.group_ids.as_ref().map(|j| &j.0),
        "autoBan": r.auto_ban,
        "failThreshold": r.fail_threshold,
        "failCount": r.fail_count,
        "lastTestAt": r.last_test_at,
        "lastTestMs": r.last_test_ms,
        "lastTestOk": r.last_test_ok,
        "tag": r.tag,
        "createdAt": r.created_at,
        "updatedAt": r.updated_at,
        "keySummary": summary,
    })
}

fn build_key_summary(
    key_blob: &str,
    state_raw: Option<&sqlx::types::Json<Value>>,
    jwt_secret: &str,
) -> Value {
    let decrypted = crypto::decrypt_or_plain(jwt_secret, key_blob);
    let (count, strategy, weights) = match serde_json::from_str::<Value>(&decrypted) {
        Ok(v) => {
            let keys = v
                .get("keys")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(1);
            let strategy = v
                .get("strategy")
                .and_then(|x| x.as_str())
                .unwrap_or("round_robin")
                .to_string();
            let weights = v
                .get("weights")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .map(|w| w.as_i64().unwrap_or(1) as i32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| vec![1; keys]);
            (keys, strategy, weights)
        }
        // legacy: 单裸 key
        Err(_) => (1, "round_robin".to_string(), vec![1]),
    };
    let (fail_counts, disabled) = state_raw
        .and_then(|j| {
            let fc = j
                .0
                .get("failCounts")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .map(|w| w.as_i64().unwrap_or(0) as i32)
                        .collect::<Vec<_>>()
                })?;
            let d = j
                .0
                .get("disabled")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().map(|w| w.as_bool().unwrap_or(false)).collect::<Vec<_>>())?;
            Some((fc, d))
        })
        .unwrap_or_else(|| (vec![0; count], vec![false; count]));
    json!({
        "keyCount": count,
        "strategy": strategy,
        "weights": weights,
        "failCounts": fail_counts,
        "disabled": disabled,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertBody {
    name: String,
    #[serde(rename = "type")]
    r#type: String,
    /// 单 Key（legacy）。新建必须带 `key` 或 `keys` 二者之一；编辑时缺省则保留旧值。
    key: Option<String>,
    /// 多 Key 模式：每个元素是一把 key 明文。
    keys: Option<Vec<String>>,
    /// 多 Key 选取策略："round_robin" | "weighted_random"
    strategy: Option<String>,
    /// 仅 weighted_random 模式使用。长度必须与 keys 等长，否则按等权处理。
    weights: Option<Vec<i32>>,
    base_url: Option<String>,
    models: Option<Value>,
    model_mapping: Option<Value>,
    param_override: Option<Value>,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    weight: i32,
    #[serde(default = "default_status")]
    status: i8,
    group_id: Option<i64>,
    /// 多对多分组 ID 列表。空数组 = 任意分组可见。NULL（未提供）= 沿用 group_id 兼容路径。
    group_ids: Option<Vec<i64>>,
    #[serde(default = "default_auto_ban")]
    auto_ban: i8,
    #[serde(default = "default_fail_threshold")]
    fail_threshold: i32,
    tag: Option<String>,
}

/// 把 UpsertBody 中的 key/keys/strategy/weights 归一成"待加密明文"。
/// 返回 Some(plaintext) 表示要更新；None 表示请求里没指定（保留旧值，仅 update 路径走）。
fn build_key_plaintext(body: &UpsertBody) -> ApiResult<Option<String>> {
    if let Some(list) = body.keys.as_ref() {
        let cleaned: Vec<String> = list
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if cleaned.is_empty() {
            return Err(ApiError::BadRequest("keys 不能全为空".into()));
        }
        let strategy = match body.strategy.as_deref() {
            Some(s) if s == "round_robin" || s == "weighted_random" => s.to_string(),
            Some(other) => {
                return Err(ApiError::BadRequest(format!(
                    "未知 strategy: {other}（仅支持 round_robin / weighted_random）"
                )))
            }
            None => "round_robin".to_string(),
        };
        let weights = match body.weights.clone() {
            Some(ws) if ws.len() == cleaned.len() => ws,
            Some(_) => {
                return Err(ApiError::BadRequest(
                    "weights 长度必须等于 keys 长度".into(),
                ))
            }
            None => vec![1; cleaned.len()],
        };
        let payload = json!({
            "keys": cleaned,
            "strategy": strategy,
            "weights": weights,
        });
        return Ok(Some(payload.to_string()));
    }
    if let Some(k) = body.key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // 单 key：以 JSON 形式存储，便于后续无痛追加为多 key
        let payload = json!({
            "keys": [k],
            "strategy": "round_robin",
            "weights": [1],
        });
        return Ok(Some(payload.to_string()));
    }
    Ok(None)
}

fn default_status() -> i8 {
    1
}
fn default_auto_ban() -> i8 {
    1
}
fn default_fail_threshold() -> i32 {
    5
}

const ALLOWED_TYPES: &[&str] = &["openai", "anthropic", "gemini", "custom", "local"];

/// 从加密的 key blob 中解出第一把 key 明文（兼容老的"裸 key"和新的 JSON 多 Key 格式）。
/// 仅用于测试连通性 / 批量 ping —— 真实路由调用走 router::select_channel。
fn first_key_from_blob(jwt_secret: &str, blob: &str) -> String {
    let decrypted = crypto::decrypt_or_plain(jwt_secret, blob);
    if let Ok(v) = serde_json::from_str::<Value>(&decrypted) {
        if let Some(arr) = v.get("keys").and_then(|x| x.as_array()) {
            if let Some(first) = arr.iter().find_map(|x| x.as_str()) {
                return first.to_string();
            }
        }
    }
    decrypted
}

fn validate(body: &UpsertBody) -> ApiResult<()> {
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("渠道名不能为空".into()));
    }
    if !ALLOWED_TYPES.contains(&body.r#type.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "不支持的渠道类型: {}（允许: {}）",
            body.r#type,
            ALLOWED_TYPES.join(", ")
        )));
    }
    if body.fail_threshold < 1 {
        return Err(ApiError::BadRequest("fail_threshold 必须 ≥ 1".into()));
    }
    Ok(())
}

// ----------------------------------------------------------------------------
// 列表 / CRUD
// ----------------------------------------------------------------------------

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("channel.read")?;
    let rows: Vec<ChannelRow> = sqlx::query_as(
        "SELECT id,name,type,key_encrypted,base_url,models,model_mapping,param_override,priority,weight,\
         status,disabled_reason,group_id,group_ids,key_state,auto_ban,fail_threshold,fail_count,\
         last_test_at,last_test_ms,last_test_ok,tag,created_at,updated_at \
         FROM channels ORDER BY priority DESC, id ASC",
    )
    .fetch_all(&state.db)
    .await?;
    let views: Vec<Value> = rows
        .iter()
        .map(|r| row_to_view(r, &state.jwt_secret))
        .collect();
    Ok(Json(json!({ "ok": true, "channels": views })))
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("channel.create")?;
    validate(&body)?;
    let plaintext = build_key_plaintext(&body)?
        .ok_or_else(|| ApiError::BadRequest("新建时必须填写 API Key".into()))?;
    let key_encrypted = crypto::encrypt(&state.jwt_secret, &plaintext)
        .map_err(|e| ApiError::Internal(format!("加密失败: {e}")))?;
    let group_ids_json = body
        .group_ids
        .as_ref()
        .map(|v| sqlx::types::Json(json!(v)));
    let res = sqlx::query(
        "INSERT INTO channels (name,type,key_encrypted,base_url,models,model_mapping,\
         param_override,priority,weight,status,group_id,group_ids,auto_ban,fail_threshold,tag) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(body.name.trim())
    .bind(&body.r#type)
    .bind(&key_encrypted)
    .bind(body.base_url.as_deref())
    .bind(body.models.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.model_mapping.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.param_override.as_ref().map(|v| sqlx::types::Json(v.clone())))
    .bind(body.priority)
    .bind(body.weight)
    .bind(body.status)
    .bind(body.group_id)
    .bind(group_ids_json)
    .bind(body.auto_ban)
    .bind(body.fail_threshold)
    .bind(body.tag.as_deref())
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
    ctx.require("channel.update")?;
    validate(&body)?;
    let group_ids_json = body
        .group_ids
        .as_ref()
        .map(|v| sqlx::types::Json(json!(v)));
    // 不带 key/keys 时不动 key_encrypted；带了就更新（同时 key_state 重置成 NULL，
    // 由 router::parse_key_state 在下次选取时按新 key 数量重新初始化）
    let res = if let Some(plaintext) = build_key_plaintext(&body)? {
        let key_encrypted = crypto::encrypt(&state.jwt_secret, &plaintext)
            .map_err(|e| ApiError::Internal(format!("加密失败: {e}")))?;
        sqlx::query(
            "UPDATE channels SET name=?,type=?,key_encrypted=?,key_state=NULL,base_url=?,models=?,\
             model_mapping=?,param_override=?,priority=?,weight=?,status=?,group_id=?,group_ids=?,\
             auto_ban=?,fail_threshold=?,tag=?,disabled_reason=NULL WHERE id=?",
        )
        .bind(body.name.trim())
        .bind(&body.r#type)
        .bind(&key_encrypted)
        .bind(body.base_url.as_deref())
        .bind(body.models.as_ref().map(|v| sqlx::types::Json(v.clone())))
        .bind(body.model_mapping.as_ref().map(|v| sqlx::types::Json(v.clone())))
        .bind(body.param_override.as_ref().map(|v| sqlx::types::Json(v.clone())))
        .bind(body.priority)
        .bind(body.weight)
        .bind(body.status)
        .bind(body.group_id)
        .bind(group_ids_json)
        .bind(body.auto_ban)
        .bind(body.fail_threshold)
        .bind(body.tag.as_deref())
        .bind(id)
        .execute(&state.db)
        .await?
    } else {
        sqlx::query(
            "UPDATE channels SET name=?,type=?,base_url=?,models=?,\
             model_mapping=?,param_override=?,priority=?,weight=?,status=?,group_id=?,group_ids=?,\
             auto_ban=?,fail_threshold=?,tag=?,disabled_reason=NULL WHERE id=?",
        )
        .bind(body.name.trim())
        .bind(&body.r#type)
        .bind(body.base_url.as_deref())
        .bind(body.models.as_ref().map(|v| sqlx::types::Json(v.clone())))
        .bind(body.model_mapping.as_ref().map(|v| sqlx::types::Json(v.clone())))
        .bind(body.param_override.as_ref().map(|v| sqlx::types::Json(v.clone())))
        .bind(body.priority)
        .bind(body.weight)
        .bind(body.status)
        .bind(body.group_id)
        .bind(group_ids_json)
        .bind(body.auto_ban)
        .bind(body.fail_threshold)
        .bind(body.tag.as_deref())
        .bind(id)
        .execute(&state.db)
        .await?
    };
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("渠道不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("channel.delete")?;
    let res = sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("渠道不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

// ----------------------------------------------------------------------------
// 测试连通性
// ----------------------------------------------------------------------------

/// 取出一个渠道的 ping endpoint + auth header。不同上游差异不大：
/// - openai / custom：GET {base_url}/models 带 Authorization: Bearer <key>
/// - anthropic：     POST {base_url}/v1/messages 1 token；这里为省 token，
///                   降级为 GET /v1/models（Anthropic 也支持），失败 fallback。
/// - gemini：        GET {base_url}/v1beta/models?key=<key>
/// - local：         直接返回 ok（没有上游）
fn default_base_for(r#type: &str) -> &'static str {
    match r#type {
        "openai" => "https://api.openai.com",
        "anthropic" => "https://api.anthropic.com",
        "gemini" => "https://generativelanguage.googleapis.com",
        _ => "",
    }
}

async fn ping_channel(
    r#type: &str,
    base_url: &str,
    key: &str,
) -> (bool, u16, u32, String) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return (false, 0, 0, format!("client build: {e}")),
    };

    let started = Instant::now();

    if r#type == "local" {
        return (true, 200, 0, "local 类型无需测试".into());
    }

    let base = if base_url.is_empty() {
        default_base_for(r#type)
    } else {
        base_url.trim_end_matches('/')
    };

    let (url, req) = match r#type {
        "openai" | "custom" => {
            let url = format!("{}/v1/models", base);
            let req = client
                .get(&url)
                .header("Authorization", format!("Bearer {}", key));
            (url, req)
        }
        "anthropic" => {
            let url = format!("{}/v1/models", base);
            let req = client
                .get(&url)
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
            (url, req)
        }
        "gemini" => {
            let url = format!("{}/v1beta/models?key={}", base, key);
            let req = client.get(&url);
            (url, req)
        }
        _ => {
            return (
                false,
                0,
                0,
                format!("未实现的渠道类型: {}", r#type),
            )
        }
    };

    let resp = req.send().await;
    let elapsed_ms = started.elapsed().as_millis() as u32;
    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let ok = r.status().is_success();
            let msg = if ok {
                format!("HTTP {} from {}", status, url)
            } else {
                let body = r.text().await.unwrap_or_default();
                let truncated: String = body.chars().take(200).collect();
                format!("HTTP {} from {}: {}", status, url, truncated)
            };
            (ok, status, elapsed_ms, msg)
        }
        Err(e) => (false, 0, elapsed_ms, format!("请求失败: {e}")),
    }
}

async fn test_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    ctx.require("channel.test")?;
    let row: (String, Option<String>, String) = sqlx::query_as(
        "SELECT type, base_url, key_encrypted FROM channels WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::NotFound("渠道不存在".into()))?;
    let (r#type, base_url, key_blob) = row;
    let key = first_key_from_blob(&state.jwt_secret, &key_blob);
    let (ok, status, ms, message) =
        ping_channel(&r#type, base_url.as_deref().unwrap_or(""), &key).await;

    let now = Utc::now().naive_utc();
    let ok_i = if ok { 1i8 } else { 0i8 };
    sqlx::query(
        "UPDATE channels SET last_test_at=?, last_test_ms=?, last_test_ok=? WHERE id=?",
    )
    .bind(now)
    .bind(ms as i32)
    .bind(ok_i)
    .bind(id)
    .execute(&state.db)
    .await
    .ok();

    Ok(Json(json!({
        "ok": ok,
        "httpStatus": status,
        "latencyMs": ms,
        "message": message,
        "channelId": id,
    })))
}

// ----------------------------------------------------------------------------
// 批量操作
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchBody {
    ids: Vec<i64>,
    /// "enable" | "disable" | "delete" | "tag" | "test"
    action: String,
    /// action=tag 时使用
    tag: Option<String>,
}

async fn batch(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<BatchBody>,
) -> ApiResult<Json<Value>> {
    if body.ids.is_empty() {
        return Err(ApiError::BadRequest("ids 不能为空".into()));
    }
    let action = body.action.as_str();
    let perm = match action {
        "enable" | "disable" | "tag" => "channel.update",
        "delete" => "channel.delete",
        "test" => "channel.test",
        _ => return Err(ApiError::BadRequest(format!("未知操作: {action}"))),
    };
    ctx.require(perm)?;

    let placeholders = vec!["?"; body.ids.len()].join(",");
    let affected: u64;
    match action {
        "enable" => {
            let sql = format!(
                "UPDATE channels SET status=1, disabled_reason=NULL, fail_count=0 \
                 WHERE id IN ({})",
                placeholders
            );
            let mut q = sqlx::query(&sql);
            for id in &body.ids {
                q = q.bind(id);
            }
            affected = q.execute(&state.db).await?.rows_affected();
        }
        "disable" => {
            let sql = format!(
                "UPDATE channels SET status=0, disabled_reason='管理员批量禁用' \
                 WHERE id IN ({})",
                placeholders
            );
            let mut q = sqlx::query(&sql);
            for id in &body.ids {
                q = q.bind(id);
            }
            affected = q.execute(&state.db).await?.rows_affected();
        }
        "delete" => {
            let sql = format!("DELETE FROM channels WHERE id IN ({})", placeholders);
            let mut q = sqlx::query(&sql);
            for id in &body.ids {
                q = q.bind(id);
            }
            affected = q.execute(&state.db).await?.rows_affected();
        }
        "tag" => {
            let tag = body
                .tag
                .as_deref()
                .ok_or_else(|| ApiError::BadRequest("缺少 tag".into()))?;
            let sql = format!(
                "UPDATE channels SET tag=? WHERE id IN ({})",
                placeholders
            );
            let mut q = sqlx::query(&sql).bind(tag);
            for id in &body.ids {
                q = q.bind(id);
            }
            affected = q.execute(&state.db).await?.rows_affected();
        }
        "test" => {
            // 串行测试，避免一次给上游打太多并发
            let mut results = Vec::with_capacity(body.ids.len());
            for id in &body.ids {
                let row: Option<(String, Option<String>, String)> = sqlx::query_as(
                    "SELECT type, base_url, key_encrypted FROM channels WHERE id = ?",
                )
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
                if let Some((r#type, base_url, key_blob)) = row {
                    let key = first_key_from_blob(&state.jwt_secret, &key_blob);
                    let (ok, status, ms, message) =
                        ping_channel(&r#type, base_url.as_deref().unwrap_or(""), &key).await;
                    let now = Utc::now().naive_utc();
                    sqlx::query(
                        "UPDATE channels SET last_test_at=?, last_test_ms=?, last_test_ok=? \
                         WHERE id=?",
                    )
                    .bind(now)
                    .bind(ms as i32)
                    .bind(if ok { 1i8 } else { 0i8 })
                    .bind(id)
                    .execute(&state.db)
                    .await
                    .ok();
                    results.push(json!({
                        "id": id,
                        "ok": ok,
                        "httpStatus": status,
                        "latencyMs": ms,
                        "message": message,
                    }));
                }
            }
            return Ok(Json(json!({ "ok": true, "results": results })));
        }
        _ => unreachable!(),
    }
    Ok(Json(json!({ "ok": true, "affected": affected })))
}
