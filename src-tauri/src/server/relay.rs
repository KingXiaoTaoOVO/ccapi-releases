//! 官方代理路由：透传上游 + 记账。
//!
//! 兼容两条入口：
//!   POST /api/v1/chat/completions   —— OpenAI 风格（Claude Code 内置 SDK 用）
//!   POST /api/v1/messages           —— Anthropic 风格（Claude 官方 SDK 用）
//!
//! 鉴权：JWT（与其他 /api 路由一致；中间件已注入 UserContext）。
//!
//! 行为：
//!   1. 解析 body 中的 `model`，调用 router::select_channel 选 ONE 个渠道
//!   2. 按渠道类型构造上游 URL + Authorization 头
//!   3. 应用 model_mapping（user request model → upstream model）
//!   4. reqwest 透传请求体 / 响应体（含流式 SSE：透传 Bytes，不解析 token）
//!   5. 非流式响应：从 JSON 提取 usage.{prompt,completion}_tokens 写 usage_logs
//!   6. 流式响应：记录 0 tokens / 0 cost 的占位行（要精确需要在网关层解析 SSE）
//!   7. 失败：router::record_failure；成功：router::record_success
//!
//! 价格 / 用户分组倍率：本批先按 0 USD 写入，等模型定价表（5.3）上线再实算。

use std::time::Instant;

use axum::body::Body;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use axum::body::Bytes;
use futures_util::Stream;
use redis::aio::ConnectionManager;
use serde_json::Value;
use sqlx::MySqlPool;

use crate::server::billing;
use crate::server::jwt_mw::UserContext;
use crate::server::router::{
    apply_model_mapping, record_failure, record_success, select_channel, PickedChannel,
    RouteError,
};
use crate::server::transform::{param_override, sensitive};
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/chat/completions", post(chat_completions))
        .route("/api/v1/messages", post(anthropic_messages))
        .route("/api/v1/models", axum::routing::get(list_models))
}

// ----------------------------------------------------------------------------
// 入口 #1：OpenAI 兼容
// ----------------------------------------------------------------------------

async fn chat_completions(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    relay("openai", state, ctx, headers, body, "/v1/chat/completions").await
}

// ----------------------------------------------------------------------------
// 入口 #2：Anthropic 兼容
// ----------------------------------------------------------------------------

async fn anthropic_messages(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    relay("anthropic", state, ctx, headers, body, "/v1/messages").await
}

// ----------------------------------------------------------------------------
// 入口 #3：暴露已配置的全部模型清单（合并所有可用渠道）
// ----------------------------------------------------------------------------

async fn list_models(
    State(state): State<AppState>,
    Extension(_ctx): Extension<UserContext>,
) -> Response {
    let rows: Vec<(sqlx::types::Json<Value>,)> = sqlx::query_as(
        "SELECT models FROM channels WHERE status = 1 AND models IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let mut all = std::collections::BTreeSet::new();
    for (m,) in rows {
        if let Value::Array(arr) = m.0 {
            for v in arr {
                if let Some(s) = v.as_str() {
                    all.insert(s.to_string());
                }
            }
        }
    }
    let data: Vec<Value> = all
        .into_iter()
        .map(|id| serde_json::json!({"id": id, "object": "model"}))
        .collect();
    axum::Json(serde_json::json!({"object": "list", "data": data})).into_response()
}

// ----------------------------------------------------------------------------
// 核心 relay 流程
// ----------------------------------------------------------------------------

async fn relay(
    flavor: &str,
    state: AppState,
    ctx: UserContext,
    incoming_headers: HeaderMap,
    body: Bytes,
    upstream_path: &str,
) -> Response {
    // 1. 解析模型
    let json: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return error_json(StatusCode::BAD_REQUEST, &format!("解析请求体失败: {e}")),
    };
    let requested_model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if requested_model.is_empty() {
        return error_json(StatusCode::BAD_REQUEST, "请求缺少 model 字段");
    }
    // token 维度模型白名单
    if let Some(list) = ctx.token_models_allowed.as_ref() {
        if !list.is_empty() && !list.iter().any(|m| m == &requested_model || m == "*") {
            return error_json(
                StatusCode::FORBIDDEN,
                &format!("当前令牌不允许调用模型 {requested_model}"),
            );
        }
    }

    // 用户 / 分组 维度模型白名单
    if let Err(msg) = check_user_group_model_acl(&state, ctx.user_id, &requested_model).await {
        return error_json(StatusCode::FORBIDDEN, &msg);
    }
    let is_stream = json
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 1.5 敏感词过滤（命中任一词直接拒绝，不上游消耗）
    let words = sensitive::current_words(&state.db).await;
    if let Some(hit) = sensitive::first_hit(&json, &words) {
        return error_json(
            StatusCode::FORBIDDEN,
            &format!("请求包含敏感词，已被拦截：{hit}"),
        );
    }

    // 2. 选渠道
    let picked = match select_channel(&state.db, &state.jwt_secret, ctx.user_id, &requested_model)
        .await
    {
        Ok(p) => p,
        Err(RouteError::NoChannel(_)) => {
            return error_json(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("没有可用渠道支持模型 {requested_model}"),
            );
        }
        Err(e) => {
            return error_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    };

    // 3. 应用 model_mapping
    let upstream_model =
        apply_model_mapping(picked.model_mapping.as_ref(), &requested_model);
    let mut fwd_body = json.clone();
    if upstream_model != requested_model {
        if let Some(obj) = fwd_body.as_object_mut() {
            obj.insert("model".to_string(), Value::String(upstream_model.clone()));
        }
    }

    // 3.5. 应用渠道级参数覆盖（NewAPI 风格的 15 mode + 条件）
    param_override::apply(
        picked.param_override.as_ref(),
        &mut fwd_body,
        &requested_model,
        &upstream_model,
    );
    // OpenAI 流式：默认不带 usage，必须显式 stream_options.include_usage=true
    // 才能在末包拿到精确 prompt/completion_tokens。这里强制注入但保留用户自己的设置。
    if flavor == "openai" && is_stream {
        if let Some(obj) = fwd_body.as_object_mut() {
            let so = obj
                .entry("stream_options")
                .or_insert(Value::Object(Default::default()));
            if let Some(so_obj) = so.as_object_mut() {
                so_obj.insert("include_usage".to_string(), Value::Bool(true));
            } else {
                obj.insert(
                    "stream_options".to_string(),
                    serde_json::json!({"include_usage": true}),
                );
            }
        }
    }

    // 4. 构造上游 URL + Auth
    let base = effective_base(&picked, flavor);
    let url = format!("{}{}", base.trim_end_matches('/'), upstream_path);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("HTTP client: {e}")),
    };

    let mut req = client.post(&url);
    // 透传部分客户端 headers（除 host / authorization / content-length）
    for (k, v) in incoming_headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "host" | "authorization" | "content-length" | "x-api-key"
        ) {
            continue;
        }
        if let Ok(val) = v.to_str() {
            req = req.header(k.as_str(), val);
        }
    }
    // 注入上游 Auth
    req = add_upstream_auth(req, &picked, flavor);
    req = req.header("content-type", "application/json");
    let started = Instant::now();
    let body_bytes = match serde_json::to_vec(&fwd_body) {
        Ok(b) => b,
        Err(e) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("序列化失败: {e}")),
    };
    let resp = match req.body(body_bytes).send().await {
        Ok(r) => r,
        Err(e) => {
            record_failure(
                &state.db,
                picked.id,
                picked.key_index,
                picked.key_total,
                picked.auto_ban,
                picked.fail_threshold,
                &format!("上游连接失败: {e}"),
            )
            .await;
            return error_json(StatusCode::BAD_GATEWAY, &format!("上游连接失败: {e}"));
        }
    };

    let status = resp.status();
    let mut out_headers = HeaderMap::new();
    for (k, v) in resp.headers().iter() {
        // 透传 content-type、transfer-encoding 等
        out_headers.insert(
            HeaderName::from_bytes(k.as_str().as_bytes())
                .unwrap_or_else(|_| HeaderName::from_static("x-relay")),
            HeaderValue::from_bytes(v.as_bytes()).unwrap_or(HeaderValue::from_static("")),
        );
    }

    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        record_failure(
            &state.db,
            picked.id,
            picked.key_index,
            picked.key_total,
            picked.auto_ban,
            picked.fail_threshold,
            &format!("HTTP {status}"),
        )
        .await;
        let mut r = Response::new(Body::from(txt));
        *r.status_mut() = status;
        for (k, v) in out_headers.iter() {
            r.headers_mut().insert(k, v.clone());
        }
        return r;
    }

    if is_stream {
        record_success(&state.db, picked.id, picked.key_index, picked.key_total).await;
        // 流式：用一个边走边解析 SSE 的 stream 适配器；流结束时再扣费。
        // 同时计算 input_tokens 的"估算上限"（按 messages 字符总数 / 4），上游若没
        // 回精确 usage 时就用这个估算扣费。
        let estimated_input = estimate_input_tokens(&fwd_body);
        let upstream_stream = resp.bytes_stream();
        let body = stream_with_billing(
            upstream_stream,
            state.db.clone(),
            state.redis.clone(),
            ctx.user_id,
            ctx.token_id,
            upstream_model.clone(),
            flavor.to_string(),
            estimated_input,
            picked.id,
            started,
        );
        let mut r = Response::new(Body::from_stream(body));
        *r.status_mut() = status;
        for (k, v) in out_headers.iter() {
            r.headers_mut().insert(k, v.clone());
        }
        return r;
    }

    // 非流式：buffer 一次 + 解析 usage + 真扣费
    let resp_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return error_json(StatusCode::BAD_GATEWAY, &format!("读上游响应失败: {e}")),
    };
    let (input_tok, output_tok) = extract_tokens(&resp_bytes, flavor);
    record_success(&state.db, picked.id, picked.key_index, picked.key_total).await;
    let latency_ms = started.elapsed().as_millis() as i64;
    let _ = billing::charge_user_with_token(
        &state.db,
        &state.redis,
        ctx.user_id,
        ctx.token_id,
        &upstream_model,
        input_tok,
        output_tok,
        "official",
        billing::ChargeMetrics {
            latency_ms,
            channel_id: Some(picked.id),
        },
    )
    .await;
    let _ = started;

    let mut r = Response::new(Body::from(resp_bytes));
    *r.status_mut() = status;
    for (k, v) in out_headers.iter() {
        r.headers_mut().insert(k, v.clone());
    }
    r
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/// 校验 users.models_allowed 和 user_groups.models_allowed 是否允许 model。
/// 任意一层非空且未命中 → 拒绝；NULL 或空数组 = 不限。
async fn check_user_group_model_acl(
    state: &AppState,
    user_id: i64,
    model: &str,
) -> Result<(), String> {
    let row: Option<(Option<sqlx::types::Json<Value>>, Option<sqlx::types::Json<Value>>)> =
        sqlx::query_as(
            "SELECT u.models_allowed, g.models_allowed \
             FROM users u LEFT JOIN user_groups g ON g.id = u.group_id \
             WHERE u.id = ?",
        )
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let Some((user_allow, group_allow)) = row else {
        return Ok(());
    };
    fn check(slot: Option<&sqlx::types::Json<Value>>, model: &str) -> Result<(), ()> {
        match slot.map(|j| &j.0) {
            None | Some(Value::Null) => Ok(()),
            Some(Value::Array(arr)) if arr.is_empty() => Ok(()),
            Some(Value::Array(arr)) => {
                if arr
                    .iter()
                    .any(|v| v.as_str().map(|s| s == "*" || s == model).unwrap_or(false))
                {
                    Ok(())
                } else {
                    Err(())
                }
            }
            _ => Ok(()),
        }
    }
    if check(user_allow.as_ref(), model).is_err() {
        return Err(format!("当前用户未被授权调用模型 {model}"));
    }
    if check(group_allow.as_ref(), model).is_err() {
        return Err(format!("您所在分组未被授权调用模型 {model}"));
    }
    Ok(())
}

fn effective_base(p: &PickedChannel, flavor: &str) -> String {
    if let Some(b) = &p.base_url {
        if !b.trim().is_empty() {
            return b.clone();
        }
    }
    match p.r#type.as_str() {
        "openai" => "https://api.openai.com".to_string(),
        "anthropic" => "https://api.anthropic.com".to_string(),
        "gemini" => "https://generativelanguage.googleapis.com".to_string(),
        // custom / local 没默认值——上游会 400 让用户自己设
        _ => match flavor {
            "anthropic" => "https://api.anthropic.com".to_string(),
            _ => "https://api.openai.com".to_string(),
        },
    }
}

fn add_upstream_auth(
    req: reqwest::RequestBuilder,
    p: &PickedChannel,
    flavor: &str,
) -> reqwest::RequestBuilder {
    match (p.r#type.as_str(), flavor) {
        // Anthropic 渠道 + 任意 flavor：x-api-key
        ("anthropic", _) => req
            .header("x-api-key", p.key_plain.clone())
            .header("anthropic-version", "2023-06-01"),
        // Gemini：query 参数 ?key=... 但前面 url 已没 query，这里用 header（兼容某些反代）
        ("gemini", _) => req.header("x-goog-api-key", p.key_plain.clone()),
        // 其他都用 Bearer
        _ => req.header("Authorization", format!("Bearer {}", p.key_plain)),
    }
}

/// 解析响应 JSON 取 token 数。
/// - OpenAI: { usage: { prompt_tokens, completion_tokens } }
/// - Anthropic: { usage: { input_tokens, output_tokens } }
fn extract_tokens(bytes: &[u8], flavor: &str) -> (i64, i64) {
    let v: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return (0, 0),
    };
    let usage = v.get("usage").cloned().unwrap_or(Value::Null);
    let input = usage
        .get(if flavor == "anthropic" {
            "input_tokens"
        } else {
            "prompt_tokens"
        })
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let output = usage
        .get(if flavor == "anthropic" {
            "output_tokens"
        } else {
            "completion_tokens"
        })
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    (input, output)
}

// ----------------------------------------------------------------------------
// 流式：边转发边累加 SSE 里的 token usage，流结束时扣费
// ----------------------------------------------------------------------------

/// 包装上游 bytes 流：把每个 chunk 喂给 SseUsageParser 累加 input/output_tokens，
/// 流结束（包括 EOF / 上游断开）时异步 charge_user。返回 axum 兼容的 stream。
fn stream_with_billing<S, E>(
    upstream: S,
    db: MySqlPool,
    redis: ConnectionManager,
    user_id: i64,
    token_id: Option<i64>,
    model: String,
    flavor: String,
    estimated_input: i64,
    channel_id: i64,
    started: Instant,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let parser = SseUsageParser::new(&flavor);
    futures_util::stream::unfold(
        (
            Some(Box::pin(upstream)),
            parser,
            false,
            db,
            redis,
            user_id,
            token_id,
            model,
            estimated_input,
            channel_id,
            started,
        ),
        |(mut up, mut parser, charged, db, redis, user_id, token_id, model, est_in, ch_id, started)| async move {
            use futures_util::StreamExt;
            let Some(upstream) = up.as_mut() else {
                return None;
            };
            match upstream.next().await {
                Some(Ok(b)) => {
                    parser.feed(&b);
                    Some((
                        Ok::<Bytes, std::io::Error>(b),
                        (
                            up, parser, charged, db, redis, user_id, token_id, model, est_in, ch_id, started,
                        ),
                    ))
                }
                Some(Err(e)) => {
                    if !charged {
                        let (i, o) = parser.finalize_tokens(est_in);
                        let latency_ms = started.elapsed().as_millis() as i64;
                        let _ = crate::server::billing::charge_user_with_token(
                            &db, &redis, user_id, token_id, &model, i, o, "official",
                            crate::server::billing::ChargeMetrics { latency_ms, channel_id: Some(ch_id) },
                        )
                        .await;
                    }
                    Some((
                        Err(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("upstream: {e}"),
                        )),
                        (
                            None,
                            SseUsageParser::new("openai"),
                            true,
                            db,
                            redis,
                            user_id,
                            token_id,
                            model,
                            0,
                            ch_id,
                            started,
                        ),
                    ))
                }
                None => {
                    if !charged {
                        let (i, o) = parser.finalize_tokens(est_in);
                        let latency_ms = started.elapsed().as_millis() as i64;
                        let _ = crate::server::billing::charge_user_with_token(
                            &db, &redis, user_id, token_id, &model, i, o, "official",
                            crate::server::billing::ChargeMetrics { latency_ms, channel_id: Some(ch_id) },
                        )
                        .await;
                    }
                    None
                }
            }
        },
    )
}

/// 估算 input tokens（粗略：字符数 / 4，对 OpenAI / Anthropic 都按消息正文计）。
/// 仅用于流式上游不回 usage 时的回退；非流式 / 精确路径不走这里。
fn estimate_input_tokens(body: &Value) -> i64 {
    let mut chars: usize = 0;
    // OpenAI: messages: [{role, content: string | [{type:"text", text:"..."}]}]
    // Anthropic: messages: [{role, content: string | [{type:"text", text:"..."}]}]
    if let Some(msgs) = body.get("messages").and_then(|v| v.as_array()) {
        for m in msgs {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()) {
                chars += s.chars().count();
            } else if let Some(arr) = m.get("content").and_then(|v| v.as_array()) {
                for part in arr {
                    if let Some(s) = part.get("text").and_then(|v| v.as_str()) {
                        chars += s.chars().count();
                    }
                }
            }
        }
    }
    // system 字段（Anthropic 顶层）
    if let Some(s) = body.get("system").and_then(|v| v.as_str()) {
        chars += s.chars().count();
    }
    (chars as i64 / 4).max(0)
}

/// 极简 SSE event 累加器。
/// - 输入是按 chunk 喂入的 raw bytes（可能跨 chunk 截断）；
/// - 在内部维护一个 UTF-8 缓冲，按 `\n\n` 分割完整 event；
/// - 每个 event 内查 `data: <json>`，按 flavor 解析 usage。
struct SseUsageParser {
    buf: String,
    input_tokens: i64,
    output_tokens: i64,
    /// 累计 delta 内容的字符数，用作 output_tokens 的回退估算（chars / 4）
    delta_chars: usize,
    flavor: String,
}

impl SseUsageParser {
    fn new(flavor: &str) -> Self {
        Self {
            buf: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            delta_chars: 0,
            flavor: flavor.to_string(),
        }
    }

    fn feed(&mut self, chunk: &[u8]) {
        // utf-8 chunk 可能跨字符边界，但 SSE 都是 ASCII 控制字符（'\n'）切分，
        // 在 ASCII 范围内安全；中文等多字节内容只会出现在 data: 行的 JSON value 里，
        // 我们用 from_utf8_lossy 容错（lossy 替换字符不会影响 prompt_tokens 等 ASCII 字段）。
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        // 切完整 event（以 \n\n 结尾）
        while let Some(idx) = self.buf.find("\n\n") {
            let event: String = self.buf.drain(..idx + 2).collect();
            self.parse_event(&event);
        }
    }

    fn parse_event(&mut self, event: &str) {
        // 收集所有 `data: ...` 行拼成完整 JSON（标准 SSE 多行 data 用 \n 连接）
        let mut json_text = String::new();
        for line in event.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                let v = rest.trim_start();
                if v == "[DONE]" {
                    return;
                }
                if !json_text.is_empty() {
                    json_text.push('\n');
                }
                json_text.push_str(v);
            }
        }
        if json_text.is_empty() {
            return;
        }
        let Ok(v): Result<Value, _> = serde_json::from_str(&json_text) else {
            return;
        };
        self.absorb_usage(&v);
    }

    fn absorb_usage(&mut self, v: &Value) {
        // 同时累加 delta 文本作为估算备份
        self.accumulate_delta(v);

        // Anthropic message_start: message.usage.input_tokens
        // Anthropic message_delta: usage.output_tokens
        // OpenAI 末包（stream_options.include_usage）: usage.prompt_tokens / completion_tokens
        if self.flavor == "anthropic" {
            if let Some(u) = v.pointer("/message/usage") {
                if let Some(n) = u.get("input_tokens").and_then(|x| x.as_i64()) {
                    self.input_tokens = n;
                }
                if let Some(n) = u.get("output_tokens").and_then(|x| x.as_i64()) {
                    // message_start 通常 output_tokens=0；message_delta 给最终值
                    self.output_tokens = n.max(self.output_tokens);
                }
            }
            if let Some(u) = v.get("usage") {
                if let Some(n) = u.get("input_tokens").and_then(|x| x.as_i64()) {
                    self.input_tokens = n;
                }
                if let Some(n) = u.get("output_tokens").and_then(|x| x.as_i64()) {
                    self.output_tokens = n.max(self.output_tokens);
                }
            }
        } else {
            // openai
            if let Some(u) = v.get("usage") {
                if let Some(n) = u.get("prompt_tokens").and_then(|x| x.as_i64()) {
                    self.input_tokens = n;
                }
                if let Some(n) = u.get("completion_tokens").and_then(|x| x.as_i64()) {
                    self.output_tokens = n;
                }
            }
        }
    }

    /// 累加 chunk 内的文本字符——给上游不回 usage 时做估算。
    fn accumulate_delta(&mut self, v: &Value) {
        // OpenAI: choices[0].delta.content
        if let Some(arr) = v.get("choices").and_then(|x| x.as_array()) {
            for c in arr {
                if let Some(s) = c.pointer("/delta/content").and_then(|x| x.as_str()) {
                    self.delta_chars += s.chars().count();
                }
            }
        }
        // Anthropic: type=content_block_delta, delta.text
        if let Some(s) = v.pointer("/delta/text").and_then(|x| x.as_str()) {
            self.delta_chars += s.chars().count();
        }
    }

    /// 流结束时被调用。若上游已经回过 usage，就用 usage；否则用估算：
    /// - input = max(parsed, est_in)  // 取较大值以免漏算系统消息
    /// - output = max(parsed, delta_chars / 4)
    fn finalize_tokens(&self, est_in: i64) -> (i64, i64) {
        let i = if self.input_tokens > 0 {
            self.input_tokens
        } else {
            est_in
        };
        let o = if self.output_tokens > 0 {
            self.output_tokens
        } else {
            (self.delta_chars as i64) / 4
        };
        (i, o)
    }
}

fn error_json(status: StatusCode, msg: &str) -> Response {
    let body = serde_json::json!({"ok": false, "error": msg});
    let mut r = axum::Json(body).into_response();
    *r.status_mut() = status;
    r
}
