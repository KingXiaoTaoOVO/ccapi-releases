// ============================================================
// Local proxy ("CCAPI 本地代理")
//
// Claude Code is permanently pointed at http://127.0.0.1:<port> with
// `ANTHROPIC_AUTH_TOKEN=<our proxy key>`. Every request is authenticated
// against that proxy key, then forwarded to the *current* upstream key's real
// endpoint with that key's auth header injected. If the upstream rejects the
// request before any response bytes are streamed (401 / insufficient balance /
// 402 / 429 / 5xx), we transparently switch to the next healthy key and RETRY
// the same request — so a long-running Claude session never sees the failure.
//
// Real third-party URL/KEY values are NEVER written into Claude's settings.json
// — they only live inside this app's storage.
// ============================================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
    Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State as TauriState};
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

use crate::server::quota_hook::QuotaHook;

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const MAX_BODY: usize = 64 * 1024 * 1024;
/// Emit `proxy://metrics` at most this often to avoid flooding the webview.
const METRICS_EMIT_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyKey {
    pub id: String,
    pub name: String,
    pub key: String,
    pub url: Option<String>,
    /// "ANTHROPIC_AUTH_TOKEN" (Bearer) | "ANTHROPIC_API_KEY" (x-api-key)
    pub auth_field: Option<String>,
}

/// 桥接到 CCAPI 服务端的官方代理。当 Some(_) 时本地代理跳过 key 池，
/// 把所有请求转发到 server_url + 原路径（Claude Code 一般打到 /v1/messages），
/// Authorization 替换为 Bearer <user_jwt>，由服务端 relay 走渠道选路 + 真扣费。
#[derive(Clone, Debug)]
pub struct OfficialConfig {
    pub server_url: String,
    pub jwt: String,
}

struct ProxyInner {
    keys: Vec<ProxyKey>,
    cursor: usize,
    cooling: HashMap<String, Instant>,
    default_base_url: String,
    running: bool,
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    /// Proxy key Claude Code must present in Authorization / x-api-key.
    /// Empty disables authentication (only the very first install sees this).
    token: String,
    /// 启用时本地代理转发到 CCAPI 服务端官方渠道。
    official: Option<OfficialConfig>,

    // ---- session metrics ----
    total_forwarded: u64,
    /// Key id last selected for a successful forward.
    current_hit: Option<String>,
    /// Per-key cumulative failure count (cooled/exhausted/invalid this session).
    failures: HashMap<String, u64>,
    /// Last time we emitted `proxy://metrics`; rate-limits push events.
    last_metrics_emit: Option<Instant>,

    // ---- SaaS quota hook (Phase 3+) ----
    /// 当前活跃 user_id（由 client 模式登录后通过 set_active_user 设入）。
    /// 0 表示无活跃用户（行为退回原 standalone 模式：不做 quota check）。
    active_user_id: i64,
    /// 业务侧注入的额度钩子（由 server::start_admin_server 在同一进程内注入）。
    /// 客户端模式 / 无 quota 集成时为 None。
    quota_hook: Option<Arc<dyn QuotaHook>>,
}

pub struct ProxyState {
    app: AppHandle,
    client: reqwest::Client,
    inner: Mutex<ProxyInner>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub port: u16,
    pub pool_size: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyFailure {
    pub id: String,
    pub name: String,
    pub count: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMetrics {
    pub running: bool,
    pub port: u16,
    pub pool_size: usize,
    pub total_forwarded: u64,
    pub current_hit_id: Option<String>,
    pub current_hit_name: Option<String>,
    pub failures: Vec<ProxyFailure>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProxySwitch {
    from_id: String,
    from_name: String,
    to_id: Option<String>,
    to_name: Option<String>,
    http_status: u16,
    /// "cooling" | "exhausted" | "invalid"
    status_hint: String,
    cooldown_secs: u64,
}

impl ProxyState {
    pub fn new(app: AppHandle) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent("CCAPI-Proxy/0.1")
            .build()
            .unwrap_or_default();
        ProxyState {
            app,
            client,
            inner: Mutex::new(ProxyInner {
                keys: Vec::new(),
                cursor: 0,
                cooling: HashMap::new(),
                default_base_url: DEFAULT_BASE_URL.to_string(),
                running: false,
                port: 0,
                shutdown: None,
                token: String::new(),
                official: None,
                total_forwarded: 0,
                current_hit: None,
                failures: HashMap::new(),
                last_metrics_emit: None,
                active_user_id: 0,
                quota_hook: None,
            }),
        }
    }

    fn status(&self) -> ProxyStatus {
        let g = self.inner.lock().unwrap();
        ProxyStatus {
            running: g.running,
            port: g.port,
            pool_size: g.keys.len(),
        }
    }

    fn metrics(&self) -> ProxyMetrics {
        let g = self.inner.lock().unwrap();
        let name_by_id: HashMap<&str, &str> =
            g.keys.iter().map(|k| (k.id.as_str(), k.name.as_str())).collect();
        let current_hit_name = g
            .current_hit
            .as_deref()
            .and_then(|id| name_by_id.get(id).copied())
            .map(|s| s.to_string());
        let mut failures: Vec<ProxyFailure> = g
            .failures
            .iter()
            .map(|(id, count)| ProxyFailure {
                id: id.clone(),
                name: name_by_id
                    .get(id.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| id.clone()),
                count: *count,
            })
            .collect();
        failures.sort_by(|a, b| b.count.cmp(&a.count));
        ProxyMetrics {
            running: g.running,
            port: g.port,
            pool_size: g.keys.len(),
            total_forwarded: g.total_forwarded,
            current_hit_id: g.current_hit.clone(),
            current_hit_name,
            failures,
        }
    }

    fn set_keys(&self, keys: Vec<ProxyKey>, default_base_url: String, active_id: Option<String>) {
        let mut g = self.inner.lock().unwrap();
        g.cursor = active_id
            .as_deref()
            .and_then(|id| keys.iter().position(|k| k.id == id))
            .unwrap_or(0);
        // Drop cooling/failure entries for keys no longer present.
        let present: std::collections::HashSet<&str> = keys.iter().map(|k| k.id.as_str()).collect();
        g.cooling.retain(|id, _| present.contains(id.as_str()));
        g.failures.retain(|id, _| present.contains(id.as_str()));
        if let Some(id) = g.current_hit.clone() {
            if !present.contains(id.as_str()) {
                g.current_hit = None;
            }
        }
        g.keys = keys;
        g.default_base_url = default_base_url;
    }

    fn set_token(&self, token: String) {
        let mut g = self.inner.lock().unwrap();
        g.token = token;
    }

    fn token(&self) -> String {
        self.inner.lock().unwrap().token.clone()
    }

    /// 注入业务侧的额度钩子（服务端模式启动时调用）；None 时退回原行为。
    pub fn set_quota_hook(&self, hook: Option<Arc<dyn QuotaHook>>) {
        let mut g = self.inner.lock().unwrap();
        g.quota_hook = hook;
    }

    /// 设置当前活跃用户（客户端登录后调用，登出时设 0）。
    pub fn set_active_user(&self, user_id: i64) {
        let mut g = self.inner.lock().unwrap();
        g.active_user_id = user_id;
    }

    /// 保留接口供未来扩展。当前 local 路径完全不查 quota，official 路径
    /// 由服务端 relay 自己扣费，所以本方法目前没有调用者。
    #[allow(dead_code)]
    fn quota_context(&self) -> (i64, Option<Arc<dyn QuotaHook>>) {
        let g = self.inner.lock().unwrap();
        (g.active_user_id, g.quota_hook.clone())
    }

    pub fn set_official(&self, cfg: Option<OfficialConfig>) {
        let mut g = self.inner.lock().unwrap();
        g.official = cfg;
    }

    fn official(&self) -> Option<OfficialConfig> {
        self.inner.lock().unwrap().official.clone()
    }

    /// First non-cooling key starting at the cursor; advances cursor to it.
    fn pick(&self) -> Option<(ProxyKey, String)> {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        g.cooling.retain(|_, until| *until > now);
        let n = g.keys.len();
        if n == 0 {
            return None;
        }
        let base = g.default_base_url.clone();
        for i in 0..n {
            let idx = (g.cursor + i) % n;
            let k = g.keys[idx].clone();
            if !g.cooling.contains_key(&k.id) {
                g.cursor = idx;
                return Some((k, base));
            }
        }
        None
    }

    fn cool(&self, id: &str, secs: u64) {
        let mut g = self.inner.lock().unwrap();
        g.cooling
            .insert(id.to_string(), Instant::now() + Duration::from_secs(secs.max(1)));
        *g.failures.entry(id.to_string()).or_insert(0) += 1;
        // Move the cursor forward so the next pick() prefers a different key.
        if !g.keys.is_empty() {
            g.cursor = (g.cursor + 1) % g.keys.len();
        }
    }

    /// Move the round-robin cursor forward WITHOUT cooling the current key or
    /// counting a failure. Used by internal probes (model-list / in-app chat)
    /// so a 4xx on one key doesn't poison the pool.
    fn advance_cursor(&self) {
        let mut g = self.inner.lock().unwrap();
        if !g.keys.is_empty() {
            g.cursor = (g.cursor + 1) % g.keys.len();
        }
    }

    /// Like `pick`, but does NOT mutate the cursor — used to look ahead for
    /// "is there another key we could try?" without committing to it.
    fn pick_peek(&self) -> Option<(ProxyKey, String)> {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        g.cooling.retain(|_, until| *until > now);
        let n = g.keys.len();
        if n == 0 {
            return None;
        }
        let base = g.default_base_url.clone();
        for i in 0..n {
            let idx = (g.cursor + i) % n;
            let k = g.keys[idx].clone();
            if !g.cooling.contains_key(&k.id) {
                return Some((k, base));
            }
        }
        None
    }

    fn record_success(&self, id: &str) {
        let mut g = self.inner.lock().unwrap();
        g.total_forwarded = g.total_forwarded.saturating_add(1);
        g.current_hit = Some(id.to_string());
    }

    /// The real key currently at the cursor.
    #[allow(dead_code)]
    pub fn current_key(&self) -> Option<ProxyKey> {
        let g = self.inner.lock().unwrap();
        g.keys.get(g.cursor).cloned()
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().running
    }

    fn emit_switch(&self, ev: ProxySwitch) {
        let _ = self.app.emit("proxy://switch", ev);
    }

    /// Push a metrics snapshot, but at most once every `METRICS_EMIT_INTERVAL`.
    fn maybe_emit_metrics(&self) {
        let now = Instant::now();
        {
            let mut g = self.inner.lock().unwrap();
            match g.last_metrics_emit {
                Some(t) if now.duration_since(t) < METRICS_EMIT_INTERVAL => return,
                _ => g.last_metrics_emit = Some(now),
            }
        }
        let snap = self.metrics();
        let _ = self.app.emit("proxy://metrics", snap);
    }
}

/// Build the upstream URL from a key base + the incoming path/query, guarding
/// against a duplicated `/v1` when a base already ends in `/v1`.
fn upstream_url(base: &str, path_and_query: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let base = if base.is_empty() { DEFAULT_BASE_URL } else { base };
    let mut path = path_and_query.to_string();
    if base.ends_with("/v1") && path.starts_with("/v1/") {
        path = path["/v1".len()..].to_string();
    }
    format!("{base}{path}")
}

/// 哪些上游 HTTP 状态应触发"切换到下一把 key"。
///
/// **设计**（2026/06 修订）：
/// - 只对**和 key 本身相关**的失败做 failover —— 鉴权失败、额度耗尽、被限流。
/// - 上游 5xx / 超时是**服务端故障**，换 key 帮不上忙、还会把好 key 一起冷却掉
///   并造成 Claude Code 那边"流被切断"。直接把错误透传回客户端，由
///   Claude Code 自己 retry。
fn should_failover(status: u16) -> bool {
    matches!(status, 401 | 402 | 403 | 429 | 529)
}

/// Map an upstream failure to (frontend status hint, cooldown seconds).
fn failover_plan(status: u16, body: &str) -> (&'static str, u64) {
    let reset = crate::monitor::parse_reset_secs(body);
    match status {
        429 | 529 => ("cooling", reset.unwrap_or(60)),
        402 => match reset {
            Some(r) => ("cooling", r),
            None => ("exhausted", 3600),
        },
        401 | 403 => {
            if crate::monitor::classify_body_as_exhausted(body) {
                match reset {
                    Some(r) => ("cooling", r),
                    None => ("exhausted", 3600),
                }
            } else {
                // 旧值 6h 太狠 —— 一旦上游短暂抽风全员 invalid 半天没法用；
                // 改成 30 分钟，给用户排查时间又不会永久封 key
                ("invalid", 30 * 60)
            }
        }
        _ => ("cooling", reset.unwrap_or(30)),
    }
}

fn err_response(status: StatusCode, message: &str) -> Response {
    let payload = serde_json::json!({
        "error": { "type": "ccapi_proxy_error", "message": message }
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

/// Extract the bearer / api-key from the incoming request headers.
fn extract_client_token(h: &HeaderMap) -> Option<String> {
    use axum::http::header::{HeaderName, AUTHORIZATION};
    if let Some(v) = h.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let v = v.trim();
        if let Some(rest) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
            return Some(rest.trim().to_string());
        }
        return Some(v.to_string());
    }
    if let Some(v) = h
        .get(HeaderName::from_static("x-api-key"))
        .and_then(|v| v.to_str().ok())
    {
        return Some(v.trim().to_string());
    }
    None
}

/// Copy request headers, dropping host/auth/encoding/length, then inject the
/// selected key's credential.
fn build_headers(incoming: &HeaderMap, key: &ProxyKey) -> HeaderMap {
    use axum::http::header::{
        HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_LENGTH, HOST,
    };
    let mut h = incoming.clone();
    h.remove(HOST);
    h.remove(CONTENT_LENGTH);
    h.remove(ACCEPT_ENCODING);
    h.remove(AUTHORIZATION);
    h.remove(HeaderName::from_static("x-api-key"));
    // Internal marker is for the proxy only — never leak it to the upstream.
    h.remove(HeaderName::from_static("x-ccapi-internal"));

    let use_bearer = key.auth_field.as_deref() != Some("ANTHROPIC_API_KEY");
    if use_bearer {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", key.key)) {
            h.insert(AUTHORIZATION, v);
        }
    } else if let Ok(v) = HeaderValue::from_str(&key.key) {
        h.insert(HeaderName::from_static("x-api-key"), v);
    }
    h
}

/// 从 Anthropic Messages API 请求体粗略估算 (model, input_tokens, output_tokens)。
/// 流式响应里的精确 usage 我们拿不到（要破坏 streaming 才行），所以这里用请求体
/// 估算 input tokens（约 chars/4），output 用 max_tokens 上限（如果有）/否则 1024。
///
/// 当前 local 路径不计费，故无调用者；保留作为未来 SaaS 模式重启用。
#[allow(dead_code)]
fn estimate_usage_from_body(body: &[u8]) -> (String, u64, u64) {
    let v: serde_json::Value =
        serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let model = v
        .get("model")
        .and_then(|x| x.as_str())
        .unwrap_or("claude-3-5-sonnet")
        .to_string();
    let mut input_chars: usize = 0;
    if let Some(msgs) = v.get("messages").and_then(|x| x.as_array()) {
        for m in msgs {
            if let Some(s) = m.get("content").and_then(|x| x.as_str()) {
                input_chars += s.chars().count();
            } else if let Some(arr) = m.get("content").and_then(|x| x.as_array()) {
                for blk in arr {
                    if let Some(s) = blk.get("text").and_then(|x| x.as_str()) {
                        input_chars += s.chars().count();
                    }
                }
            }
        }
    }
    if let Some(sys) = v.get("system").and_then(|x| x.as_str()) {
        input_chars += sys.chars().count();
    }
    let input_tokens = (input_chars / 4).max(1) as u64;
    let output_tokens = v
        .get("max_tokens")
        .and_then(|x| x.as_u64())
        .unwrap_or(1024);
    (model, input_tokens, output_tokens)
}

/// Relay a successful upstream response back to the client, streaming the body.
fn stream_back(resp: reqwest::Response) -> Response {
    use axum::http::header::{CONNECTION, CONTENT_LENGTH, TRANSFER_ENCODING};
    let status = resp.status();
    let mut builder = Response::builder().status(status);
    for (name, value) in resp.headers() {
        if name == CONTENT_LENGTH || name == TRANSFER_ENCODING || name == CONNECTION {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| err_response(StatusCode::BAD_GATEWAY, "代理响应构建失败"))
}

async fn handler(
    State(state): State<Arc<ProxyState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Authenticate the caller against our own proxy key.
    let expected = state.token();
    if !expected.is_empty() {
        match extract_client_token(&headers) {
            Some(t) if t == expected => {}
            _ => {
                return err_response(
                    StatusCode::UNAUTHORIZED,
                    "代理密钥不匹配 — 请用 CCAPI 设置页中的代理密钥",
                );
            }
        }
    }

    // ---- Official 桥接：直接转发到 CCAPI 服务端官方代理 ----
    // 这条路径下后端 relay 自己负责扣 CCAPI 额度（按渠道倍率 + 模型倍率）。
    if let Some(off) = state.official() {
        return forward_official(state.client.clone(), off, method, uri, headers, body).await;
    }

    // ---- Local 模式：用户用的是自己的上游 API key ----
    // 用户自己付上游费用，CCAPI 不参与计费 —— 所以**绝对不**触发 quota_hook
    // 的 check / charge。哪怕同进程注入了 hook、即便 active_user_id > 0：
    // local pool 这条路径上 hook 一律忽略。否则同时开着 server 和 client 模式
    // 时会出现「我用自己的 key 还被扣 CCAPI 激活码额度」的 402（用户实测）。
    //
    // 内部探测（模型列表 / 在 CCAPI 内置 Chat）的标记仍保留 —— 即便不再触发
    // 额度，也用来跳过 key 冷却 / 失败计数 / 轮换桌面通知。
    let path_q = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let is_internal = headers
        .get("x-ccapi-internal")
        .and_then(|v| v.to_str().ok())
        .map(|s| !s.is_empty() && s != "0")
        .unwrap_or(false)
        || (method == Method::GET && path_q.starts_with("/v1/models"));

    let max_attempts = {
        let g = state.inner.lock().unwrap();
        g.keys.len().max(1)
    };

    let mut last_status = StatusCode::SERVICE_UNAVAILABLE;
    let mut last_body = String::from("没有可用的密钥");
    let mut last_ct: Option<String> = None;

    for _ in 0..max_attempts {
        let (key, base) = match state.pick() {
            Some(x) => x,
            None => break,
        };
        let target = key.url.as_deref().unwrap_or(&base);
        let url = upstream_url(target, path_q);
        let hdrs = build_headers(&headers, &key);

        let resp = state
            .client
            .request(method.clone(), url)
            .headers(hdrs)
            .body(body.clone())
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status = r.status();
                if should_failover(status.as_u16()) {
                    let ct = r
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    let text = r.text().await.unwrap_or_default();
                    if is_internal {
                        // 内部探测：不冷却、不发轮换通知、不计入 failures。
                        // 仍然换下一把 key 重试，保证下拉列表能拿到结果。
                        state.advance_cursor();
                    } else {
                        let (hint, cooldown) = failover_plan(status.as_u16(), &text);
                        state.cool(&key.id, cooldown);
                        let next = state.pick_peek();
                        state.emit_switch(ProxySwitch {
                            from_id: key.id.clone(),
                            from_name: key.name.clone(),
                            to_id: next.as_ref().map(|(k, _)| k.id.clone()),
                            to_name: next.as_ref().map(|(k, _)| k.name.clone()),
                            http_status: status.as_u16(),
                            status_hint: hint.to_string(),
                            cooldown_secs: cooldown,
                        });
                        state.maybe_emit_metrics();
                    }
                    last_status = status;
                    last_body = text;
                    last_ct = ct;
                    if state.pick_peek().is_some() {
                        continue;
                    }
                    break;
                }
                // Success (or a non-failover error like 400) → stream straight back.
                // Local 模式不计费，所以这里只更新 session metrics、不再调 quota_hook.charge。
                if !is_internal {
                    state.record_success(&key.id);
                    state.maybe_emit_metrics();
                }
                return stream_back(r);
            }
            Err(e) => {
                // Network-level error: cool this key briefly and try the next.
                if is_internal {
                    state.advance_cursor();
                } else {
                    state.cool(&key.id, 30);
                    state.maybe_emit_metrics();
                }
                last_status = StatusCode::BAD_GATEWAY;
                last_body = format!("上游请求失败: {e}");
                last_ct = Some("application/json".into());
                if state.pick_peek().is_some() {
                    continue;
                }
                break;
            }
        }
    }

    // All keys exhausted — surface the last upstream error so Claude Code shows
    // something meaningful (and the UI has already been notified via events).
    match last_ct {
        Some(ct) => Response::builder()
            .status(last_status)
            .header("content-type", ct)
            .body(Body::from(last_body))
            .unwrap_or_else(|_| err_response(last_status, "代理失败")),
        None => err_response(last_status, &last_body),
    }
}

/// 把 Claude Code 入站请求透传给 CCAPI 服务端的 /api/v1/* 路由，使用用户 JWT。
async fn forward_official(
    client: reqwest::Client,
    off: OfficialConfig,
    method: Method,
    uri: Uri,
    incoming: HeaderMap,
    body: Bytes,
) -> Response {
    // 拼上游 URL：server_url + uri.path_and_query()
    // Claude Code 默认走 /v1/messages；OpenAI 兼容客户端走 /v1/chat/completions
    // 服务端 relay 已经分别在 /api/v1/messages 和 /api/v1/chat/completions 暴露。
    let path_q = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let mapped_path = if path_q.starts_with("/v1/") {
        format!("/api{}", path_q)
    } else if path_q.starts_with("/api/v1/") {
        path_q.to_string()
    } else {
        // 其他路径（如健康检查）直接挂到 /api 下
        format!("/api{}", path_q)
    };
    let url = format!("{}{}", off.server_url.trim_end_matches('/'), mapped_path);

    let mut req = client.request(method, &url);
    for (k, v) in incoming.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "host" | "authorization" | "x-api-key" | "content-length"
        ) {
            continue;
        }
        if let Ok(val) = v.to_str() {
            req = req.header(k.as_str(), val);
        }
    }
    req = req
        .header("authorization", format!("Bearer {}", off.jwt))
        .header("content-type", "application/json")
        .body(body);

    match req.send().await {
        Ok(r) => stream_back(r),
        Err(e) => err_response(
            StatusCode::BAD_GATEWAY,
            &format!("Official 代理转发失败: {e}"),
        ),
    }
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn start_proxy(
    state: TauriState<'_, Arc<ProxyState>>,
    port: u16,
) -> Result<u16, String> {
    if state.is_running() {
        return Ok(state.status().port);
    }
    let arc = state.inner().clone();

    // Fail loudly if the requested port is taken so the UI can prompt the user
    // to pick a different one (instead of silently moving them to a random port
    // that won't match Claude's configured base URL).
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("端口 {port} 无法绑定: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("无法读取端口: {e}"))?
        .port();

    let (tx, rx) = oneshot::channel::<()>();
    {
        let mut g = arc.inner.lock().unwrap();
        g.running = true;
        g.port = bound;
        g.shutdown = Some(tx);
    }

    let app_state = arc.clone();
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let router = Router::new()
        .fallback(handler)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(cors)
        .with_state(app_state);

    let serve_state = arc.clone();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = rx.await;
        });
        if let Err(e) = server.await {
            eprintln!("代理服务器退出: {e}");
        }
        let mut g = serve_state.inner.lock().unwrap();
        g.running = false;
        g.shutdown = None;
    });

    Ok(bound)
}

#[tauri::command]
pub fn stop_proxy(state: TauriState<'_, Arc<ProxyState>>) -> Result<(), String> {
    let mut g = state.inner.lock().unwrap();
    if let Some(tx) = g.shutdown.take() {
        let _ = tx.send(());
    }
    g.running = false;
    Ok(())
}

#[tauri::command]
pub fn proxy_status(state: TauriState<'_, Arc<ProxyState>>) -> ProxyStatus {
    state.status()
}

#[tauri::command]
pub fn proxy_metrics(state: TauriState<'_, Arc<ProxyState>>) -> ProxyMetrics {
    state.metrics()
}

#[tauri::command]
pub fn set_proxy_keys(
    state: TauriState<'_, Arc<ProxyState>>,
    keys: Vec<ProxyKey>,
    default_base_url: String,
    active_id: Option<String>,
) -> Result<(), String> {
    state.set_keys(keys, default_base_url, active_id);
    Ok(())
}

#[tauri::command]
pub fn set_proxy_token(
    state: TauriState<'_, Arc<ProxyState>>,
    token: String,
) -> Result<(), String> {
    state.set_token(token);
    Ok(())
}

/// 启用 / 禁用本地代理的"官方代理桥接"模式。
/// 传 None / 空 server_url 关闭，回到本地 key 池转发。
#[tauri::command]
pub fn set_proxy_official_mode(
    state: TauriState<'_, Arc<ProxyState>>,
    server_url: Option<String>,
    jwt: Option<String>,
) -> Result<(), String> {
    match (server_url.as_deref(), jwt.as_deref()) {
        (Some(u), Some(t)) if !u.is_empty() && !t.is_empty() => {
            state.set_official(Some(OfficialConfig {
                server_url: u.trim_end_matches('/').to_string(),
                jwt: t.to_string(),
            }));
        }
        _ => state.set_official(None),
    }
    Ok(())
}

/// `true` when 127.0.0.1:<port> can be bound right now (i.e. it's free).
#[tauri::command]
pub async fn check_port_available(port: u16) -> bool {
    tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok()
}

/// 设置当前活跃 user_id（客户端登录后 / 登出时调用）。0 表示无人登录。
#[tauri::command]
pub fn set_proxy_active_user(
    state: TauriState<'_, Arc<ProxyState>>,
    user_id: i64,
) -> Result<(), String> {
    state.set_active_user(user_id);
    Ok(())
}

/// 直接向单把 key 的上游拉「这把 key 真实可用的模型列表」。
///
/// 不走本地代理 router，所以不会触发冷却 / 计费 / 失败计数。供前端动态填充
/// Chat / Playground / Agents 的模型下拉框使用。
///
/// 行为：
/// - `base` 为空 / None → fallback 到 Claude 官方端点
/// - 优先访问 `{base}/v1/models`（OpenAI / OpenRouter / Claude proxy 通用风格）
/// - 失败时返回空列表 + 错误说明，由调用方决定是否兜底
#[tauri::command]
pub async fn fetch_models_for_key(
    base_url: Option<String>,
    api_key: String,
    auth_field: Option<String>,
) -> Result<Vec<String>, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
    let base = base_url
        .as_deref()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let url = if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    };

    let mut headers = HeaderMap::new();
    let use_bearer = auth_field.as_deref() != Some("ANTHROPIC_API_KEY");
    if use_bearer {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", api_key)) {
            headers.insert(AUTHORIZATION, v);
        }
    } else if let Ok(v) = HeaderValue::from_str(&api_key) {
        headers.insert(HeaderName::from_static("x-api-key"), v);
    }
    // Claude 官方 API 需要 anthropic-version；带上不影响 OpenAI 兼容端点。
    if let Ok(v) = HeaderValue::from_str("2023-06-01") {
        headers.insert(HeaderName::from_static("anthropic-version"), v);
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .user_agent("CCAPI-ModelProbe/0.1")
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;

    let resp = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {}", resp.status().as_u16(), url));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析失败: {e}"))?;

    // OpenAI / Anthropic / OpenRouter 几乎都用 { data: [{ id: "..." }, ...] }
    let mut out: Vec<String> = Vec::new();
    if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                if !id.is_empty() {
                    out.push(id.to_string());
                }
            }
        }
    }
    // 一些自建 proxy 用 { models: ["..."] }
    if out.is_empty() {
        if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
            for item in arr {
                if let Some(s) = item.as_str() {
                    out.push(s.to_string());
                } else if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                    out.push(id.to_string());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_join_basic() {
        assert_eq!(
            upstream_url("https://cc.freemodel.dev", "/v1/messages?beta=true"),
            "https://cc.freemodel.dev/v1/messages?beta=true"
        );
    }

    #[test]
    fn url_join_trailing_slash() {
        assert_eq!(
            upstream_url("https://api.anthropic.com/", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn url_join_dedupes_v1() {
        assert_eq!(
            upstream_url("https://relay.example/v1", "/v1/messages"),
            "https://relay.example/v1/messages"
        );
    }

    #[test]
    fn failover_matrix() {
        assert!(should_failover(401));
        assert!(should_failover(429));
        assert!(should_failover(529));
        assert!(!should_failover(200));
        assert!(!should_failover(400));
        assert!(!should_failover(404));
    }

    #[test]
    fn plan_balance_401_is_exhausted() {
        let (hint, _) = failover_plan(401, "{\"error\":\"Insufficient balance\"}");
        assert_eq!(hint, "exhausted");
    }

    #[test]
    fn plan_plain_401_is_invalid() {
        let (hint, _) = failover_plan(401, "unauthorized");
        assert_eq!(hint, "invalid");
    }
}
