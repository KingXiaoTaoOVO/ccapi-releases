use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaInfo {
    /// Whether the upstream actually returned usable quota figures.
    pub supported: bool,
    pub total_usd: Option<f64>,
    pub used_usd: Option<f64>,
    pub remaining_usd: Option<f64>,
    pub remaining_pct: Option<f64>,
    pub currency: String,
    /// Which endpoint answered ("subscription+usage" | "credit_grants" | "none").
    pub source: String,
    pub message: String,
    pub checked_at: String,
}

fn empty(message: &str) -> QuotaInfo {
    QuotaInfo {
        supported: false,
        total_usd: None,
        used_usd: None,
        remaining_usd: None,
        remaining_pct: None,
        currency: "USD".into(),
        source: "none".into(),
        message: message.into(),
        checked_at: chrono::Local::now().to_rfc3339(),
    }
}

fn normalize_base(base_url: &Option<String>) -> String {
    base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string()
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Option<(u16, Value)> {
    let resp = client
        .get(url)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .send()
        .await
        .ok()?;
    let status = resp.status().as_u16();
    let value = resp.json::<Value>().await.unwrap_or(Value::Null);
    Some((status, value))
}

fn num(v: &Value, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(n) = v.get(k).and_then(|x| x.as_f64()) {
            return Some(n);
        }
    }
    None
}

/// Best-effort quota lookup against OpenAI-compatible relay billing endpoints
/// (new-api / one-api / sub2api / veloera and similar Claude relays expose them).
#[tauri::command]
pub async fn query_key_quota(
    key: String,
    base_url: Option<String>,
    timeout_ms: Option<u64>,
) -> QuotaInfo {
    let base = normalize_base(&base_url);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000));
    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("CCAPI/0.1")
        .build()
    {
        Ok(c) => c,
        Err(e) => return empty(&format!("HTTP 客户端初始化失败: {e}")),
    };

    // --- Strategy 1: subscription (hard limit) + usage (spent) ---
    let sub_url = format!("{base}/v1/dashboard/billing/subscription");
    if let Some((status, body)) = get_json(&client, &sub_url, &key).await {
        if status >= 200 && status < 300 {
            let total = num(
                &body,
                &["hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"],
            );

            // Usage over the widest range the endpoint typically allows (~100 days).
            let today = chrono::Local::now().date_naive();
            let start = today - chrono::Duration::days(99);
            let end = today + chrono::Duration::days(1);
            let usage_url = format!(
                "{base}/v1/dashboard/billing/usage?start_date={}&end_date={}",
                start.format("%Y-%m-%d"),
                end.format("%Y-%m-%d"),
            );

            let used = match get_json(&client, &usage_url, &key).await {
                Some((s, ub)) if (200..300).contains(&s) => {
                    num(&ub, &["total_usage"]).map(|cents| cents / 100.0)
                }
                _ => None,
            };

            if total.is_some() || used.is_some() {
                let remaining = match (total, used) {
                    (Some(t), Some(u)) => Some((t - u).max(0.0)),
                    _ => None,
                };
                let pct = match (total, remaining) {
                    (Some(t), Some(r)) if t > 0.0 => Some((r / t * 100.0).clamp(0.0, 100.0)),
                    _ => None,
                };
                return QuotaInfo {
                    supported: true,
                    total_usd: total,
                    used_usd: used,
                    remaining_usd: remaining,
                    remaining_pct: pct,
                    currency: "USD".into(),
                    source: "subscription+usage".into(),
                    message: "额度查询成功".into(),
                    checked_at: chrono::Local::now().to_rfc3339(),
                };
            }
        }
    }

    // --- Strategy 2: credit_grants (granted / used / available) ---
    let cg_url = format!("{base}/v1/dashboard/billing/credit_grants");
    if let Some((status, body)) = get_json(&client, &cg_url, &key).await {
        if (200..300).contains(&status) {
            let granted = num(&body, &["total_granted", "total_amount"]);
            let used = num(&body, &["total_used"]);
            let available = num(&body, &["total_available", "available"]);
            if granted.is_some() || available.is_some() {
                let pct = match (granted, available) {
                    (Some(g), Some(a)) if g > 0.0 => Some((a / g * 100.0).clamp(0.0, 100.0)),
                    _ => None,
                };
                return QuotaInfo {
                    supported: true,
                    total_usd: granted,
                    used_usd: used,
                    remaining_usd: available,
                    remaining_pct: pct,
                    currency: "USD".into(),
                    source: "credit_grants".into(),
                    message: "额度查询成功".into(),
                    checked_at: chrono::Local::now().to_rfc3339(),
                };
            }
        }
    }

    empty("该中转服务未提供标准额度查询接口")
}
