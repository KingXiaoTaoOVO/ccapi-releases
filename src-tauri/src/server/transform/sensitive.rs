//! 敏感词过滤 —— 拦截在 relay 转发上游之前。
//!
//! 实现非常朴素：从 `config_kv("sensitive_words")` 读字符串数组，
//! 在请求体 JSON 的所有字符串值里做 `contains` 匹配。
//! 命中任一词 → relay 直接 403，不消耗上游配额。
//!
//! 加 5 秒 in-memory 缓存避免每次 DB 查询。

use once_cell::sync::Lazy;
use serde_json::Value;
use sqlx::MySqlPool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Cache {
    words: Vec<String>,
    until: Instant,
}

static CACHE: Lazy<Mutex<Option<Cache>>> = Lazy::new(|| Mutex::new(None));

async fn load_words(db: &MySqlPool) -> Vec<String> {
    let row: Option<(sqlx::types::Json<Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'sensitive_words'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let mut out = Vec::new();
    if let Some((sqlx::types::Json(Value::Array(arr)),)) = row {
        for v in arr {
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    out.push(t.to_lowercase());
                }
            }
        }
    }
    out
}

pub async fn current_words(db: &MySqlPool) -> Vec<String> {
    if let Ok(g) = CACHE.lock() {
        if let Some(c) = g.as_ref() {
            if Instant::now() < c.until {
                return c.words.clone();
            }
        }
    }
    let words = load_words(db).await;
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(Cache {
            words: words.clone(),
            until: Instant::now() + Duration::from_secs(5),
        });
    }
    words
}

/// 扫描 request body JSON 中所有字符串，返回首个命中的敏感词；否则 None。
pub fn first_hit(body: &Value, words: &[String]) -> Option<String> {
    if words.is_empty() {
        return None;
    }
    let mut stack: Vec<&Value> = vec![body];
    while let Some(v) = stack.pop() {
        match v {
            Value::String(s) => {
                let s_lower = s.to_lowercase();
                for w in words {
                    if s_lower.contains(w) {
                        return Some(w.clone());
                    }
                }
            }
            Value::Array(arr) => stack.extend(arr.iter()),
            Value::Object(obj) => stack.extend(obj.values()),
            _ => {}
        }
    }
    None
}
