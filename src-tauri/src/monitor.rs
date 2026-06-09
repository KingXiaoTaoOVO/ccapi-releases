use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, FixedOffset, TimeZone, Utc};
use regex::Regex;
use serde_json::json;

use crate::models::KeyCheckResult;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// Build the `/v1/messages` endpoint from a (possibly partial) base URL.
fn messages_endpoint(base_url: &Option<String>) -> String {
    let base = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/');

    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

pub(crate) fn classify_body_as_exhausted(body: &str) -> bool {
    let b = body.to_lowercase();
    ["credit", "balance", "quota", "insufficient", "exhaust", "余额", "额度"]
        .iter()
        .any(|kw| b.contains(kw))
}

/// Probe an API key with a minimal request and classify the outcome into one of
/// active / cooling / invalid / exhausted / error. Latency is measured too, so
/// the "fastest response" rotation strategy has data to work with.
#[tauri::command]
pub async fn check_key_status(
    key: String,
    base_url: Option<String>,
    auth_field: Option<String>,
    model: Option<String>,
    timeout_ms: Option<u64>,
) -> KeyCheckResult {
    let endpoint = messages_endpoint(&base_url);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000));
    let model = model.unwrap_or_else(|| "claude-3-5-haiku-20241022".to_string());
    let use_bearer = auth_field.as_deref() != Some("ANTHROPIC_API_KEY");

    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("CCAPI/0.1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return KeyCheckResult {
                ok: false,
                status: "error".into(),
                http_status: None,
                latency_ms: 0,
                message: format!("HTTP 客户端初始化失败: {e}"),
                retry_after_secs: None,
                checked_at: now_rfc3339(),
            };
        }
    };

    let payload = json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }]
    });

    let mut req = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .header("anthropic-version", ANTHROPIC_VERSION);

    req = if use_bearer {
        req.header("authorization", format!("Bearer {key}"))
    } else {
        req.header("x-api-key", key.clone())
    };

    let start = Instant::now();
    let response = req.json(&payload).send().await;
    let latency_ms = start.elapsed().as_millis() as u64;

    match response {
        Ok(resp) => {
            let http_status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let body = resp.text().await.unwrap_or_default();

            // Header `retry-after`, else a reset/cooldown time parsed from the
            // body (e.g. "将于6月9日晚上9:34(UTC+8)重置" / "tomorrow at 1:57 PM
            // (UTC+8)"). A known reset turns a hard limit into a recoverable
            // cooldown so the key auto-returns to the pool when it elapses.
            let reset = retry_after.or_else(|| parse_reset_secs(&body));

            let (status, ok, message) = match http_status {
                200..=299 => ("active", true, "密钥可用".to_string()),
                429 => ("cooling", false, "触发限流 / 冷却中".to_string()),
                401 | 403 => {
                    if classify_body_as_exhausted(&body) {
                        // "401 Insufficient balance" and friends are a balance/
                        // quota problem, not a bad credential.
                        if reset.is_some() {
                            ("cooling", false, "额度受限（将自动恢复）".to_string())
                        } else {
                            ("exhausted", false, "额度已用尽".to_string())
                        }
                    } else if http_status == 401 {
                        ("invalid", false, "密钥无效（未授权）".to_string())
                    } else {
                        ("invalid", false, "密钥被拒绝（无权限）".to_string())
                    }
                }
                402 => {
                    if reset.is_some() {
                        ("cooling", false, "额度受限（将自动恢复）".to_string())
                    } else {
                        ("exhausted", false, "额度已用尽".to_string())
                    }
                }
                400 => {
                    if classify_body_as_exhausted(&body) {
                        ("exhausted", false, "额度不足".to_string())
                    } else {
                        // Auth passed; the request shape was the only issue.
                        ("active", true, "密钥可用（请求被服务端校验）".to_string())
                    }
                }
                404 => (
                    "error",
                    false,
                    "接口地址不可达（请检查 API URL）".to_string(),
                ),
                500..=599 => ("error", false, format!("服务端错误 ({http_status})")),
                other => {
                    if classify_body_as_exhausted(&body) {
                        ("exhausted", false, "额度不足".to_string())
                    } else {
                        ("error", false, format!("未知响应 ({other})"))
                    }
                }
            };

            KeyCheckResult {
                ok,
                status: status.into(),
                http_status: Some(http_status),
                latency_ms,
                message,
                retry_after_secs: reset,
                checked_at: now_rfc3339(),
            }
        }
        Err(e) => {
            let status = if e.is_timeout() { "cooling" } else { "error" };
            let message = if e.is_timeout() {
                "请求超时（可能限流或网络缓慢）".to_string()
            } else if e.is_connect() {
                "无法连接到 API 服务".to_string()
            } else {
                format!("请求失败: {e}")
            };
            KeyCheckResult {
                ok: false,
                status: status.into(),
                http_status: None,
                latency_ms,
                message,
                retry_after_secs: None,
                checked_at: now_rfc3339(),
            }
        }
    }
}

// ============================================================
// Cooldown / reset-time parsing
//
// Relays report a quota reset moment inside the error body in several
// shapes, e.g.:
//   "tomorrow at 1:57 PM (UTC+8)"
//   "today 7:29 PM (UTC+8)"
//   "7:01 PM (UTC+8)将于6月9日晚上9:34(UTC+8)重置"
//   "将于6月9日晚上9:34(UTC+8)重置"
// We turn whichever we recognise into "seconds from now", so the key can be
// cooled down and auto-recovered exactly when the relay says it will reset.
// ============================================================

/// Seconds until the reset moment described in `body`, if any (relative to now).
pub(crate) fn parse_reset_secs(body: &str) -> Option<u64> {
    parse_reset_at(body, Utc::now())
}

/// Timezone offset hours from a `(UTC+8)` / `(UTC-5)` marker; defaults to +8.
fn parse_tz_offset(body: &str) -> i32 {
    Regex::new(r"UTC\s*([+-]\d{1,2})")
        .ok()
        .and_then(|re| re.captures(body))
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i32>().ok())
        .filter(|h| h.abs() <= 14)
        .unwrap_or(8)
}

/// Map a Chinese day-part marker onto a 24h hour.
fn cn_hour(hour: u32, marker: Option<&str>) -> u32 {
    match marker {
        Some("下午") | Some("晚上") if hour < 12 => hour + 12,
        Some("中午") => 12,
        Some("凌晨") | Some("上午") if hour == 12 => 0,
        _ => hour,
    }
}

/// Core, time-injected for deterministic testing.
fn parse_reset_at(body: &str, now_utc: DateTime<Utc>) -> Option<u64> {
    let offset = FixedOffset::east_opt(parse_tz_offset(body) * 3600)?;
    let now = now_utc.with_timezone(&offset);

    // Chinese explicit "M月D日…H:MM" wins (it's the actual reset moment), then
    // the English today/tomorrow/bare form.
    let target = parse_chinese(body, &now, &offset).or_else(|| parse_english(body, &now, &offset))?;

    let secs = (target.with_timezone(&Utc) - now_utc).num_seconds();
    if secs > 0 && secs <= 7 * 24 * 3600 {
        Some(secs as u64)
    } else {
        None
    }
}

fn parse_chinese(
    body: &str,
    now: &DateTime<FixedOffset>,
    offset: &FixedOffset,
) -> Option<DateTime<FixedOffset>> {
    let re =
        Regex::new(r"(\d{1,2})月(\d{1,2})日\s*(上午|中午|下午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})").ok()?;
    let c = re.captures(body)?;
    let month: u32 = c.get(1)?.as_str().parse().ok()?;
    let day: u32 = c.get(2)?.as_str().parse().ok()?;
    let hour: u32 = c.get(4)?.as_str().parse().ok()?;
    let minute: u32 = c.get(5)?.as_str().parse().ok()?;
    let hour = cn_hour(hour, c.get(3).map(|m| m.as_str()));

    let target = offset
        .with_ymd_and_hms(now.year(), month, day, hour, minute, 0)
        .single()?;
    if target > *now {
        return Some(target);
    }
    // Past this year — assume a year-boundary wrap only if it's clearly far back.
    if (*now - target).num_days() > 180 {
        offset
            .with_ymd_and_hms(now.year() + 1, month, day, hour, minute, 0)
            .single()
    } else {
        None
    }
}

fn parse_english(
    body: &str,
    now: &DateTime<FixedOffset>,
    offset: &FixedOffset,
) -> Option<DateTime<FixedOffset>> {
    let re = Regex::new(r"(?i)(today|tomorrow)?\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)").ok()?;

    // Prefer a match qualified with today/tomorrow; else the first bare time.
    let mut chosen = None;
    for caps in re.captures_iter(body) {
        if caps.get(1).is_some() {
            chosen = Some(caps);
            break;
        }
        if chosen.is_none() {
            chosen = Some(caps);
        }
    }
    let c = chosen?;
    let rel = c.get(1).map(|m| m.as_str().to_lowercase());
    let mut hour: u32 = c.get(2)?.as_str().parse().ok()?;
    let minute: u32 = c.get(3)?.as_str().parse().ok()?;
    match c.get(4)?.as_str().to_uppercase().as_str() {
        "PM" if hour < 12 => hour += 12,
        "AM" if hour == 12 => hour = 0,
        _ => {}
    }

    let base = if rel.as_deref() == Some("tomorrow") {
        *now + chrono::Duration::days(1)
    } else {
        *now
    };
    let mut target = offset
        .with_ymd_and_hms(base.year(), base.month(), base.day(), hour, minute, 0)
        .single()?;

    if rel.as_deref() != Some("tomorrow") && target <= *now {
        if rel.as_deref() == Some("today") {
            return None; // already elapsed today
        }
        target += chrono::Duration::days(1); // bare time → next occurrence
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn chinese_reset() {
        // now = 12:00 UTC = 20:00 (UTC+8) on 6/9; reset 6/9 晚上9:34 = 21:34 → +1h34m.
        let secs = parse_reset_at("将于6月9日晚上9:34(UTC+8)重置", at(2026, 6, 9, 12, 0)).unwrap();
        assert_eq!(secs, 3600 + 34 * 60);
    }

    #[test]
    fn combined_prefers_chinese_reset() {
        let s = "7:01 PM (UTC+8)将于6月9日晚上9:34(UTC+8)重置";
        let secs = parse_reset_at(s, at(2026, 6, 9, 12, 0)).unwrap();
        assert_eq!(secs, 3600 + 34 * 60);
    }

    #[test]
    fn english_tomorrow() {
        // now 12:00 UTC 6/9 (20:00 +8); tomorrow 13:57 +8 = 05:57 UTC 6/10.
        let secs = parse_reset_at("tomorrow at 1:57 PM (UTC+8)", at(2026, 6, 9, 12, 0)).unwrap();
        assert_eq!(secs, 17 * 3600 + 57 * 60);
    }

    #[test]
    fn english_today() {
        // now 9:00 UTC 6/9 (17:00 +8); today 19:29 +8 = 11:29 UTC.
        let secs = parse_reset_at("today 7:29 PM (UTC+8)", at(2026, 6, 9, 9, 0)).unwrap();
        assert_eq!(secs, 2 * 3600 + 29 * 60);
    }

    #[test]
    fn no_time_is_none() {
        assert!(parse_reset_at("Insufficient balance", at(2026, 6, 9, 12, 0)).is_none());
    }

    #[test]
    fn elapsed_today_is_none() {
        // today 7:29 PM (19:29 +8 = 11:29 UTC) but now is 12:00 UTC → already passed.
        assert!(parse_reset_at("today 7:29 PM (UTC+8)", at(2026, 6, 9, 12, 0)).is_none());
    }
}
