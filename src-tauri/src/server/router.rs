//! 智能路由：根据 user_id + model 选一个可用的 channels.id +（多 Key 模式下）一个具体的 key index。
//!
//! 选取顺序：
//!   1. 过滤 status=1
//!   2. 若 channels.models 是非空数组，要求 model 命中（精确匹配或前缀匹配）；为空 = 不限制
//!   3. 渠道分组：
//!      - 若 `group_ids` 是非空数组：要求包含 user 的 group_id
//!      - 否则 fallback `group_id` 单值：NULL = 任意；非 NULL = 等于 user 的 group_id
//!   4. priority DESC 取最高一档
//!   5. 同 priority 池按 weight 加权随机；weight 都为 0 → 等权
//!   6. 多 Key 模式：解析 key_encrypted 解密后的 JSON，按 strategy 从未被禁用的 key 里选一个
//!
//! 失败上报：`record_failure(state, channel_id, key_index, ...)`
//!   - 仅该 key 的 fail_count++；达到 fail_threshold 时该 key 标记 disabled
//!   - 整渠道的所有 key 全部 disabled 才把渠道 status=0
//! 成功：`record_success(state, channel_id, key_index)` 清零该 key 的 fail_count

use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::types::Json as SqlxJson;
use sqlx::MySqlPool;

use crate::server::crypto::decrypt_or_plain;

#[derive(Debug, Clone)]
pub struct PickedChannel {
    pub id: i64,
    #[allow(dead_code)]
    pub name: String,
    pub r#type: String,
    pub base_url: Option<String>,
    /// 实际下发到上游的 API Key 明文。
    pub key_plain: String,
    /// 多 Key 模式下选中的 key 在 KeyConfig.keys 中的下标。
    /// 旧的"单 key"模式恒为 0。
    pub key_index: usize,
    /// 该渠道总 key 数（≥1）。用于 record_failure 判断"全部失败 → 禁渠道"。
    pub key_total: usize,
    pub model_mapping: Option<Value>,
    /// 参数覆盖规则。relay 在转发前会调用 `transform::param_override::apply`。
    pub param_override: Option<Value>,
    pub auto_ban: bool,
    pub fail_threshold: i32,
}

#[derive(Debug)]
pub enum RouteError {
    NoChannel(String),
    Db(sqlx::Error),
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::NoChannel(m) => write!(f, "没有渠道支持模型 {m:?}"),
            RouteError::Db(e) => write!(f, "数据库错误: {e}"),
        }
    }
}

impl std::error::Error for RouteError {}

impl From<sqlx::Error> for RouteError {
    fn from(e: sqlx::Error) -> Self {
        RouteError::Db(e)
    }
}

#[derive(sqlx::FromRow)]
struct ChannelRow {
    id: i64,
    name: String,
    r#type: String,
    base_url: Option<String>,
    key_encrypted: String,
    models: Option<SqlxJson<Value>>,
    model_mapping: Option<SqlxJson<Value>>,
    param_override: Option<SqlxJson<Value>>,
    priority: i32,
    weight: i32,
    group_id: Option<i64>,
    group_ids: Option<SqlxJson<Value>>,
    key_state: Option<SqlxJson<Value>>,
    auto_ban: i8,
    fail_threshold: i32,
}

// ---------------------------------------------------------------------------
// 多 Key 配置 + 运行时状态
// ---------------------------------------------------------------------------

/// key_encrypted 解密后若是 JSON，应解析成这个结构；
/// 否则视为 legacy 单 key，被 `parse_key_config` 包成一元 KeyConfig。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct KeyConfig {
    keys: Vec<String>,
    /// "round_robin" | "weighted_random"
    strategy: String,
    weights: Vec<i32>,
}

/// `channels.key_state` 列的 schema。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct KeyState {
    fail_counts: Vec<i32>,
    disabled: Vec<bool>,
}

fn parse_key_config(decrypted: &str) -> KeyConfig {
    // 如果是 JSON object 且含 keys 数组 → 新格式
    if let Ok(v) = serde_json::from_str::<Value>(decrypted) {
        if let Some(obj) = v.as_object() {
            if obj.get("keys").and_then(|x| x.as_array()).is_some() {
                let cfg: KeyConfig = serde_json::from_value(v).unwrap_or_default();
                let cfg = KeyConfig {
                    keys: cfg
                        .keys
                        .into_iter()
                        .filter(|s| !s.trim().is_empty())
                        .collect(),
                    strategy: if cfg.strategy.is_empty() {
                        "round_robin".into()
                    } else {
                        cfg.strategy
                    },
                    weights: cfg.weights,
                };
                if !cfg.keys.is_empty() {
                    return cfg;
                }
            }
        }
    }
    // legacy: 一行明文裸 key
    KeyConfig {
        keys: vec![decrypted.to_string()],
        strategy: "round_robin".into(),
        weights: vec![1],
    }
}

fn parse_key_state(raw: Option<&SqlxJson<Value>>, len: usize) -> KeyState {
    let base = raw
        .and_then(|j| serde_json::from_value::<KeyState>(j.0.clone()).ok())
        .unwrap_or_default();
    // 长度对齐（管理员改完 key 列表后，老 state 可能短/长，按当前长度补齐/截断）
    let mut fail_counts = base.fail_counts;
    let mut disabled = base.disabled;
    fail_counts.resize(len, 0);
    disabled.resize(len, false);
    KeyState {
        fail_counts,
        disabled,
    }
}

/// 在 (cfg, state) 中按 strategy 选一个未被禁用的 key 下标。
fn pick_key_index(cfg: &KeyConfig, state: &KeyState) -> usize {
    let n = cfg.keys.len();
    if n == 0 {
        return 0;
    }
    let enabled: Vec<usize> = (0..n).filter(|i| !state.disabled[*i]).collect();
    // 全部 disabled：兜底用任意一个，让 relay 自己失败一次再交给上层重试逻辑
    let pool: Vec<usize> = if enabled.is_empty() {
        (0..n).collect()
    } else {
        enabled
    };

    if cfg.strategy == "weighted_random" && cfg.weights.len() == n {
        let total: i32 = pool.iter().map(|i| cfg.weights[*i].max(0)).sum();
        if total > 0 {
            let mut x = rand::thread_rng().gen_range(0..total);
            for i in &pool {
                let w = cfg.weights[*i].max(0);
                if x < w {
                    return *i;
                }
                x -= w;
            }
        }
    }
    // round_robin 等同"等权随机"（不持久化 lastIndex —— 多请求并发时随机更均衡）
    let i = rand::thread_rng().gen_range(0..pool.len());
    pool[i]
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

pub async fn select_channel(
    db: &MySqlPool,
    jwt_secret: &str,
    user_id: i64,
    model: &str,
) -> Result<PickedChannel, RouteError> {
    // 用户分组。users 表当前可能没 group_id 列（老 schema），query 失败容错为 None
    let user_group_id: Option<i64> = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT group_id FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|(g,)| g);

    let rows: Vec<ChannelRow> = sqlx::query_as(
        "SELECT id,name,type,base_url,key_encrypted,models,model_mapping,param_override,\
         priority,weight,group_id,group_ids,key_state,auto_ban,fail_threshold \
         FROM channels WHERE status = 1 ORDER BY priority DESC",
    )
    .fetch_all(db)
    .await?;

    let candidates: Vec<&ChannelRow> = rows
        .iter()
        .filter(|c| group_allows(c, user_group_id))
        .filter(|c| match &c.models {
            None => true,
            Some(SqlxJson(Value::Null)) => true,
            Some(SqlxJson(Value::Array(arr))) if arr.is_empty() => true,
            Some(SqlxJson(Value::Array(arr))) => arr
                .iter()
                .any(|v| v.as_str().map(|s| model_match(s, model)).unwrap_or(false)),
            _ => true,
        })
        .collect();

    if candidates.is_empty() {
        return Err(RouteError::NoChannel(model.to_string()));
    }

    // 同 priority 取最高池
    let top_priority = candidates[0].priority;
    let pool: Vec<&&ChannelRow> = candidates
        .iter()
        .filter(|c| c.priority == top_priority)
        .collect();

    // 加权随机选渠道
    let weights: Vec<i32> = pool.iter().map(|c| c.weight.max(0)).collect();
    let total: i32 = weights.iter().sum();
    let chosen: &ChannelRow = if total <= 0 {
        let i = rand::thread_rng().gen_range(0..pool.len());
        pool[i]
    } else {
        let mut x = rand::thread_rng().gen_range(0..total);
        let mut picked: Option<&ChannelRow> = None;
        for (idx, w) in weights.iter().enumerate() {
            if x < *w {
                picked = Some(pool[idx]);
                break;
            }
            x -= *w;
        }
        picked.unwrap_or(pool[0])
    };

    // ---- 多 Key 选取 ----
    let decrypted = decrypt_or_plain(jwt_secret, &chosen.key_encrypted);
    let cfg = parse_key_config(&decrypted);
    let state = parse_key_state(chosen.key_state.as_ref(), cfg.keys.len());
    let key_index = pick_key_index(&cfg, &state);
    let key_plain = cfg
        .keys
        .get(key_index)
        .cloned()
        .unwrap_or_else(|| decrypted.clone());

    Ok(PickedChannel {
        id: chosen.id,
        name: chosen.name.clone(),
        r#type: chosen.r#type.clone(),
        base_url: chosen.base_url.clone(),
        key_plain,
        key_index,
        key_total: cfg.keys.len().max(1),
        model_mapping: chosen.model_mapping.clone().map(|j| j.0),
        param_override: chosen.param_override.clone().map(|j| j.0),
        auto_ban: chosen.auto_ban != 0,
        fail_threshold: chosen.fail_threshold,
    })
}

/// 渠道分组过滤：优先看 group_ids（多对多），fallback 到 group_id（单值）。
fn group_allows(c: &ChannelRow, user_group_id: Option<i64>) -> bool {
    if let Some(SqlxJson(Value::Array(arr))) = &c.group_ids {
        if !arr.is_empty() {
            // group_ids 非空：必须包含用户分组
            return arr.iter().any(|v| v.as_i64() == user_group_id);
        }
    }
    match c.group_id {
        None => true,
        Some(gid) => Some(gid) == user_group_id,
    }
}

/// 渠道命中规则：精确匹配 / 通配符 `*` / 前缀 `gpt-4*`。
fn model_match(pattern: &str, model: &str) -> bool {
    if pattern == "*" || pattern == model {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return model.starts_with(prefix);
    }
    false
}

// ---------------------------------------------------------------------------
// 成功 / 失败上报（精确到 key index）
// ---------------------------------------------------------------------------

pub async fn record_success(db: &MySqlPool, channel_id: i64, key_index: usize, key_total: usize) {
    // 整渠道清零
    let _ = sqlx::query("UPDATE channels SET fail_count = 0 WHERE id = ?")
        .bind(channel_id)
        .execute(db)
        .await;
    // 对应 key 的 fail_count 清零
    let _ = update_key_state(db, channel_id, key_total, |st| {
        if let Some(c) = st.fail_counts.get_mut(key_index) {
            *c = 0;
        }
        // 注意：不主动 enable 已禁用的 key（要管理员显式重启），避免抖动
    })
    .await;
}

pub async fn record_failure(
    db: &MySqlPool,
    channel_id: i64,
    key_index: usize,
    key_total: usize,
    auto_ban: bool,
    fail_threshold: i32,
    reason: &str,
) {
    // 整渠道 fail_count（向后兼容老 UI 显示）
    let _ = sqlx::query(
        "UPDATE channels SET fail_count = fail_count + 1 WHERE id = ?",
    )
    .bind(channel_id)
    .execute(db)
    .await;

    // 精确到 key 的失败计数 + 自动禁用
    let updated_state = update_key_state(db, channel_id, key_total, |st| {
        if let Some(c) = st.fail_counts.get_mut(key_index) {
            *c += 1;
            if auto_ban && *c >= fail_threshold {
                if let Some(d) = st.disabled.get_mut(key_index) {
                    *d = true;
                }
            }
        }
    })
    .await;

    if !auto_ban {
        return;
    }

    // 整渠道是否要禁：所有 key 都 disabled 才禁
    if let Ok(st) = updated_state {
        let all_disabled = !st.disabled.is_empty() && st.disabled.iter().all(|d| *d);
        if all_disabled {
            let _ = sqlx::query(
                "UPDATE channels SET status = 0, disabled_reason = ? WHERE id = ?",
            )
            .bind(format!("自动禁用：全部 Key 失效（{reason}）"))
            .bind(channel_id)
            .execute(db)
            .await;
        }
    } else {
        // 老库没有 key_state 列时（极少见）：兜底回退到整渠道 fail_count 判定
        let row: Option<(i32,)> =
            sqlx::query_as("SELECT fail_count FROM channels WHERE id = ?")
                .bind(channel_id)
                .fetch_optional(db)
                .await
                .ok()
                .flatten();
        if let Some((c,)) = row {
            if c >= fail_threshold {
                let _ = sqlx::query(
                    "UPDATE channels SET status = 0, disabled_reason = ? WHERE id = ?",
                )
                .bind(format!("自动禁用：连续失败 {c} 次（{reason}）"))
                .bind(channel_id)
                .execute(db)
                .await;
            }
        }
    }
}

async fn update_key_state(
    db: &MySqlPool,
    channel_id: i64,
    key_total: usize,
    mutator: impl FnOnce(&mut KeyState),
) -> Result<KeyState, sqlx::Error> {
    // 读现状
    let row: Option<(Option<SqlxJson<Value>>,)> =
        sqlx::query_as("SELECT key_state FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(db)
            .await?;
    let raw = row.and_then(|(j,)| j);
    let mut state = parse_key_state(raw.as_ref(), key_total);
    mutator(&mut state);
    let serialized = serde_json::to_value(&state).unwrap_or(Value::Null);
    sqlx::query("UPDATE channels SET key_state = ? WHERE id = ?")
        .bind(SqlxJson(serialized))
        .bind(channel_id)
        .execute(db)
        .await?;
    Ok(state)
}

/// 应用 model_mapping：用户请求的 model → 上游实际 model。
pub fn apply_model_mapping(mapping: Option<&Value>, requested: &str) -> String {
    if let Some(Value::Object(map)) = mapping {
        if let Some(Value::String(target)) = map.get(requested) {
            return target.clone();
        }
    }
    requested.to_string()
}
