//! 计费核心：模型定价查询 + 用户分组倍率 + 真扣费 + 滑动窗口累加。
//!
//! 所有 token-计费路径都应该走这里，避免和 quota_hook.rs 里的硬编码分叉。
//! - relay.rs 直接调 charge_user；
//! - quota_hook.rs::charge 也调 charge_user，保持与本地代理一致；
//! - 模型未在 models 表中登记时回退到 family 关键词估算（与历史 price_for 等价）。

use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::Utc;
use redis::aio::ConnectionManager;
use sqlx::MySqlPool;

/// USD per 1M tokens。
pub struct ModelPrice {
    pub input_per_million: f64,
    pub output_per_million: f64,
}

/// 查询模型价格。先精确匹配 models 表，再按名称关键词估算，最后回退默认 sonnet。
pub async fn get_model_price(db: &MySqlPool, model: &str) -> ModelPrice {
    // 1. 精确名查 models 表
    let row: Option<(BigDecimal, BigDecimal)> = sqlx::query_as(
        "SELECT prompt_price_per_million, completion_price_per_million \
         FROM models WHERE name = ? AND enabled = 1",
    )
    .bind(model)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    if let Some((p, c)) = row {
        return ModelPrice {
            input_per_million: p.to_f64().unwrap_or(3.0),
            output_per_million: c.to_f64().unwrap_or(15.0),
        };
    }

    // 2. family 关键词 fallback（与历史 quota_hook::price_for 一致）
    let m = model.to_lowercase();
    if m.contains("opus") {
        return ModelPrice {
            input_per_million: 15.0,
            output_per_million: 75.0,
        };
    }
    if m.contains("haiku") {
        return ModelPrice {
            input_per_million: 0.8,
            output_per_million: 4.0,
        };
    }
    if m.contains("sonnet") {
        return ModelPrice {
            input_per_million: 3.0,
            output_per_million: 15.0,
        };
    }
    if m.contains("gpt-4o-mini") {
        return ModelPrice {
            input_per_million: 0.15,
            output_per_million: 0.60,
        };
    }
    if m.contains("gpt-4o") || m.contains("gpt-4-turbo") {
        return ModelPrice {
            input_per_million: 2.5,
            output_per_million: 10.0,
        };
    }
    if m.contains("gpt-3.5") {
        return ModelPrice {
            input_per_million: 0.5,
            output_per_million: 1.5,
        };
    }

    // 3. 默认按 sonnet 估算
    ModelPrice {
        input_per_million: 3.0,
        output_per_million: 15.0,
    }
}

/// 查询用户所属分组的倍率。users.group_id 列不存在或为 NULL 时返回 1.0。
pub async fn get_user_multiplier(db: &MySqlPool, user_id: i64) -> f64 {
    let row: Option<(Option<BigDecimal>,)> = sqlx::query_as(
        "SELECT g.multiplier FROM users u \
         LEFT JOIN user_groups g ON g.id = u.group_id \
         WHERE u.id = ?",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    match row {
        Some((Some(m),)) => m.to_f64().unwrap_or(1.0),
        _ => 1.0,
    }
}

/// 扣费时附加的指标 —— relay 转发后填写，本地代理传默认值即可。
#[derive(Debug, Clone, Copy, Default)]
pub struct ChargeMetrics {
    pub latency_ms: i64,
    pub channel_id: Option<i64>,
}

/// 实际扣费：写 user_quota（先 bonus 后 base） + 写 usage_logs + 累加 Redis 滑动窗口。
///
/// `source`: "local"（用户本机代理）或 "official"（服务端渠道转发），落到 usage_logs.source。
/// 返回实际扣费的 USD（含倍率）。
/// 接收 `token_id`：若 Some(_)，同事务里把扣费
/// 累加到 api_tokens.used_usd + 更新 last_used_at（让 token 维度配额生效）。
pub async fn charge_user_with_token(
    db: &MySqlPool,
    redis: &ConnectionManager,
    user_id: i64,
    token_id: Option<i64>,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    source: &str,
    metrics: ChargeMetrics,
) -> Result<f64, String> {
    let price = get_model_price(db, model).await;
    let mult = get_user_multiplier(db, user_id).await;
    let cost = ((input_tokens as f64 / 1_000_000.0) * price.input_per_million
        + (output_tokens as f64 / 1_000_000.0) * price.output_per_million)
        * mult;

    if cost <= 0.0 {
        // 仍要写一条 0 元日志（便于统计调用次数 / token）
        let _ = sqlx::query(
            "INSERT INTO usage_logs (user_id, model, input_tokens, output_tokens, cost_usd, pool, source, latency_ms, channel_id) \
             VALUES (?, ?, ?, ?, 0, 'base', ?, ?, ?)",
        )
        .bind(user_id)
        .bind(model)
        .bind(input_tokens)
        .bind(output_tokens)
        .bind(source)
        .bind(metrics.latency_ms)
        .bind(metrics.channel_id)
        .execute(db)
        .await;
        return Ok(0.0);
    }

    let mut tx = db
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let row: Option<(BigDecimal, BigDecimal)> = sqlx::query_as(
        "SELECT bonus_remaining_usd, base_remaining_usd FROM user_quota \
         WHERE user_id = ? FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("加锁额度失败: {e}"))?;
    let (mut bonus, mut base) =
        row.unwrap_or((BigDecimal::from(0), BigDecimal::from(0)));
    let bonus_f = bonus.to_f64().unwrap_or(0.0);
    let from_bonus = cost.min(bonus_f);
    let from_base = cost - from_bonus;
    let pool_used = if from_bonus > 0.0 { "bonus" } else { "base" };
    if from_bonus > 0.0 {
        bonus = BigDecimal::try_from(bonus_f - from_bonus).unwrap_or_default();
    }
    let base_f = base.to_f64().unwrap_or(0.0);
    if from_base > 0.0 {
        base = BigDecimal::try_from((base_f - from_base).max(0.0)).unwrap_or_default();
    }
    sqlx::query(
        "INSERT INTO user_quota (user_id, bonus_remaining_usd, base_remaining_usd, total_consumed_usd) \
         VALUES (?, ?, ?, ?) \
         ON DUPLICATE KEY UPDATE bonus_remaining_usd = VALUES(bonus_remaining_usd), \
         base_remaining_usd = VALUES(base_remaining_usd), \
         total_consumed_usd = total_consumed_usd + ?",
    )
    .bind(user_id)
    .bind(&bonus)
    .bind(&base)
    .bind(cost)
    .bind(cost)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新额度失败: {e}"))?;

    sqlx::query(
        "INSERT INTO usage_logs (user_id, model, input_tokens, output_tokens, cost_usd, pool, source, latency_ms, channel_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(model)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cost)
    .bind(pool_used)
    .bind(source)
    .bind(metrics.latency_ms)
    .bind(metrics.channel_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("写入用量日志失败: {e}"))?;

    if let Some(tid) = token_id {
        sqlx::query(
            "UPDATE api_tokens SET used_usd = used_usd + ?, last_used_at = NOW() \
             WHERE id = ? AND user_id = ?",
        )
        .bind(cost)
        .bind(tid)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("更新 token 用量失败: {e}"))?;
    }

    tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))?;

    // Redis 滑动窗口（用于订阅限流校验）
    let mut conn = redis.clone();
    let now = Utc::now().timestamp();
    let bucket_5h = 300i64;
    let bucket_7d = 6 * 3600i64;
    let key_5h = format!("usage:{}:5h:{}", user_id, (now / bucket_5h) * bucket_5h);
    let key_7d = format!("usage:{}:7d:{}", user_id, (now / bucket_7d) * bucket_7d);
    let _: Result<f64, _> = redis::cmd("INCRBYFLOAT")
        .arg(&key_5h)
        .arg(cost)
        .query_async(&mut conn)
        .await;
    let _: Result<i32, _> = redis::cmd("EXPIRE")
        .arg(&key_5h)
        .arg(5 * 3600)
        .query_async(&mut conn)
        .await;
    let _: Result<f64, _> = redis::cmd("INCRBYFLOAT")
        .arg(&key_7d)
        .arg(cost)
        .query_async(&mut conn)
        .await;
    let _: Result<i32, _> = redis::cmd("EXPIRE")
        .arg(&key_7d)
        .arg(7 * 24 * 3600)
        .query_async(&mut conn)
        .await;

    Ok(cost)
}
