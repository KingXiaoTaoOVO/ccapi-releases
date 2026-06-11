use async_trait::async_trait;
use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::Utc;
use redis::aio::ConnectionManager;
use sqlx::mysql::MySqlPool;

use crate::server::billing;

/// 代理转发前后调用的额度钩子。服务端模式启动时实例化 `LocalQuotaHook` 并通过
/// `proxy::set_quota_hook` 注入；客户端模式则不注入，proxy 行为保持向后兼容。
///
/// 当前 proxy.rs 的 local pool 路径**完全不**调这个钩子（用户用自己的上游 key，
/// 不应消耗 CCAPI 激活码 / 订阅额度）。trait 仍保留以便未来 SaaS 模式或
/// 同进程 server admin 自调用时直接复用。
#[allow(dead_code)]
#[async_trait]
pub trait QuotaHook: Send + Sync + 'static {
    /// 在转发前调用：检查 user 是否还能继续调用模型。
    async fn check(&self, user_id: i64) -> Result<(), String>;

    /// 在转发成功后调用：扣费 + 写 usage_logs + 累加滑动窗口。
    async fn charge(
        &self,
        user_id: i64,
        model: String,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<(), String>;
}

#[allow(dead_code)]
pub struct LocalQuotaHook {
    pub db: MySqlPool,
    pub redis: ConnectionManager,
}

#[async_trait]
impl QuotaHook for LocalQuotaHook {
    async fn check(&self, user_id: i64) -> Result<(), String> {
        // 1. 余额
        let row: Option<(BigDecimal, BigDecimal)> =
            sqlx::query_as("SELECT bonus_remaining_usd, base_remaining_usd FROM user_quota WHERE user_id = ?")
                .bind(user_id)
                .fetch_optional(&self.db)
                .await
                .map_err(|e| format!("查询额度失败: {e}"))?;
        let (bonus, base) = row.unwrap_or((BigDecimal::from(0), BigDecimal::from(0)));
        let total = bonus.to_f64().unwrap_or(0.0) + base.to_f64().unwrap_or(0.0);
        if total <= 0.0 {
            return Err("您的奖励 / 订阅额度都已用完，请兑换激活码后再试".into());
        }

        // 2. 限流窗口（任意一个超限就拒）
        let sub: Option<(BigDecimal, BigDecimal)> = sqlx::query_as(
            "SELECT t.quota_5h_usd, t.quota_7d_usd FROM user_subscriptions s \
             JOIN tiers t ON t.id = s.tier_id \
             WHERE s.user_id = ? AND s.expires_at > NOW() \
             ORDER BY s.expires_at DESC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| format!("查询订阅失败: {e}"))?;
        if let Some((q5, q7)) = sub {
            let q5f = q5.to_f64().unwrap_or(0.0);
            let q7f = q7.to_f64().unwrap_or(0.0);
            let used5 = sum_window(&mut self.redis.clone(), user_id, "5h", 5 * 3600).await;
            let used7 = sum_window(&mut self.redis.clone(), user_id, "7d", 7 * 24 * 3600).await;
            if q5f > 0.0 && used5 >= q5f {
                return Err(format!(
                    "已达到 5 小时窗口上限（${:.2} / ${:.2}），请等待重置",
                    used5, q5f
                ));
            }
            if q7f > 0.0 && used7 >= q7f {
                return Err(format!(
                    "已达到 7 天窗口上限（${:.2} / ${:.2}），请等待重置",
                    used7, q7f
                ));
            }
        }
        Ok(())
    }

    async fn charge(
        &self,
        user_id: i64,
        model: String,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<(), String> {
        // 委托给统一的 billing 模块（已含定价表 + 用户分组倍率 + 滑动窗口累加）
        // 本地代理路径不知道渠道 / 不可测上游延迟，传 default ChargeMetrics
        billing::charge_user_with_token(
            &self.db,
            &self.redis,
            user_id,
            None,
            &model,
            input_tokens as i64,
            output_tokens as i64,
            "local",
            billing::ChargeMetrics::default(),
        )
        .await
        .map(|_| ())
    }
}

#[allow(dead_code)]
async fn sum_window(
    conn: &mut ConnectionManager,
    user_id: i64,
    label: &str,
    span_secs: i64,
) -> f64 {
    let now = Utc::now().timestamp();
    let bucket = if label == "5h" { 300 } else { 6 * 3600 };
    let buckets = span_secs / bucket;
    let mut total = 0.0;
    for i in 0..buckets {
        let ts = (now - i * bucket) / bucket * bucket;
        let key = format!("usage:{}:{}:{}", user_id, label, ts);
        let v: Option<f64> = redis::cmd("GET")
            .arg(&key)
            .query_async(conn)
            .await
            .ok()
            .flatten();
        total += v.unwrap_or(0.0);
    }
    total
}
