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

    // ---- session metrics ----
    total_forwarded: u64,
    /// Key id last selected for a successful forward.
    current_hit: Option<String>,
    /// Per-key cumulative failure count (cooled/exhausted/invalid this session).
    failures: HashMap<String, u64>,
    /// Last time we emitted `proxy://metrics`; rate-limits push events.
    last_metrics_emit: Option<Instant>,
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
                total_forwarded: 0,
                current_hit: None,
                failures: HashMap::new(),
                last_metrics_emit: None,
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

fn should_failover(status: u16) -> bool {
    matches!(
        status,
        401 | 402 | 403 | 408 | 429 | 500 | 502 | 503 | 504 | 529
    )
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
                ("invalid", 6 * 3600)
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

    let path_q = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
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
                    let (hint, cooldown) = failover_plan(status.as_u16(), &text);
                    state.cool(&key.id, cooldown);
                    let next = state.pick();
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
                    last_status = status;
                    last_body = text;
                    last_ct = ct;
                    if next.is_some() {
                        continue;
                    }
                    break;
                }
                // Success (or a non-failover error like 400) → stream straight back.
                state.record_success(&key.id);
                state.maybe_emit_metrics();
                return stream_back(r);
            }
            Err(e) => {
                // Network-level error: cool this key briefly and try the next.
                state.cool(&key.id, 30);
                state.maybe_emit_metrics();
                last_status = StatusCode::BAD_GATEWAY;
                last_body = format!("上游请求失败: {e}");
                last_ct = Some("application/json".into());
                if state.pick().is_some() {
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
    let router = Router::new()
        .fallback(handler)
        .layer(DefaultBodyLimit::max(MAX_BODY))
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

/// `true` when 127.0.0.1:<port> can be bound right now (i.e. it's free).
#[tauri::command]
pub async fn check_port_available(port: u16) -> bool {
    tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok()
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
