//! 管理员仪表盘聚合接口。
//!
//! 所有数据基于 usage_logs / users / channels / invitations 等核心表
//! 直接 SQL 聚合，无依赖额外缓存。前端轮询 30s 刷新。

use axum::extract::{Extension, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use bigdecimal::{BigDecimal, ToPrimitive};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::ApiResult;
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/dashboard/overview", get(overview))
        .route("/api/admin/dashboard/timeseries", get(timeseries))
        .route("/api/admin/dashboard/top-users", get(top_users))
        .route("/api/admin/dashboard/top-models", get(top_models))
        .route("/api/admin/dashboard/qps", get(qps))
        .route("/api/admin/dashboard/channels-24h", get(channels_24h))
        .route("/api/admin/dashboard/system", get(system_status))
        .route("/api/admin/dashboard/activity", get(activity))
        .route("/api/admin/dashboard/perf", get(perf))
        .route("/api/admin/dashboard/group-spend", get(group_spend))
        .route("/api/admin/dashboard/failing-channels", get(failing_channels))
}

// ----------------------------------------------------------------------------
// overview: 5 张 KPI 卡需要的所有数字
// ----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    users_total: i64,
    users_new_today: i64,
    calls_today: i64,
    tokens_today: i64,
    cost_today_usd: String,
    cost_7d_usd: String,
    cost_30d_usd: String,
    channels_total: i64,
    channels_enabled: i64,
    channels_failing: i64,
    invitations_total: i64,
}

async fn overview(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;

    let users_total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await?;
    let users_new_today: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM users WHERE created_at >= CURDATE()",
    )
    .fetch_one(&state.db)
    .await?;

    let calls_today: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM usage_logs WHERE created_at >= CURDATE()",
    )
    .fetch_one(&state.db)
    .await?;
    let tokens_today: (Option<BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM usage_logs \
         WHERE created_at >= CURDATE()",
    )
    .fetch_one(&state.db)
    .await?;

    let cost_today: (Option<BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM usage_logs WHERE created_at >= CURDATE()",
    )
    .fetch_one(&state.db)
    .await?;
    let cost_7d: (Option<BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM usage_logs \
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
    )
    .fetch_one(&state.db)
    .await?;
    let cost_30d: (Option<BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM usage_logs \
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
    )
    .fetch_one(&state.db)
    .await?;

    // channels 表可能还没建（老库）—— 容错
    let (channels_total, channels_enabled, channels_failing) =
        match sqlx::query_as::<_, (i64, i64, i64)>(
            "SELECT COUNT(*), \
             SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), \
             SUM(CASE WHEN last_test_ok = 0 THEN 1 ELSE 0 END) \
             FROM channels",
        )
        .fetch_one(&state.db)
        .await
        {
            Ok((a, b, c)) => (a, b, c),
            Err(_) => (0, 0, 0),
        };

    let invitations_total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM invitations")
        .fetch_one(&state.db)
        .await?;

    let ov = Overview {
        users_total: users_total.0,
        users_new_today: users_new_today.0,
        calls_today: calls_today.0,
        tokens_today: tokens_today.0.and_then(|d| d.to_i64()).unwrap_or(0),
        cost_today_usd: cost_today
            .0
            .map(|d| d.to_string())
            .unwrap_or_else(|| "0".into()),
        cost_7d_usd: cost_7d
            .0
            .map(|d| d.to_string())
            .unwrap_or_else(|| "0".into()),
        cost_30d_usd: cost_30d
            .0
            .map(|d| d.to_string())
            .unwrap_or_else(|| "0".into()),
        channels_total,
        channels_enabled,
        channels_failing,
        invitations_total: invitations_total.0,
    };
    Ok(Json(json!({ "ok": true, "overview": ov })))
}

// ----------------------------------------------------------------------------
// timeseries: 近 N 天每日聚合（默认 30 天）
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct TimeseriesQuery {
    days: Option<u32>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct DailyRow {
    /// 日期（仅 YYYY-MM-DD）
    day: NaiveDateTime,
    calls: i64,
    input_tokens: Option<BigDecimal>,
    output_tokens: Option<BigDecimal>,
    cost_usd: Option<BigDecimal>,
}

async fn timeseries(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<TimeseriesQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let days = q.days.unwrap_or(30).min(180);

    let rows: Vec<DailyRow> = sqlx::query_as(
        "SELECT DATE(created_at) AS day, \
                COUNT(*) AS calls, \
                COALESCE(SUM(input_tokens), 0) AS input_tokens, \
                COALESCE(SUM(output_tokens), 0) AS output_tokens, \
                COALESCE(SUM(cost_usd), 0) AS cost_usd \
         FROM usage_logs \
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) \
         GROUP BY DATE(created_at) ORDER BY day ASC",
    )
    .bind(days as i64)
    .fetch_all(&state.db)
    .await?;

    let points: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "day": r.day.format("%Y-%m-%d").to_string(),
                "calls": r.calls,
                "inputTokens": r.input_tokens.and_then(|d| d.to_i64()).unwrap_or(0),
                "outputTokens": r.output_tokens.and_then(|d| d.to_i64()).unwrap_or(0),
                "costUsd": r.cost_usd.map(|d| d.to_string()).unwrap_or_else(|| "0".into()),
            })
        })
        .collect();
    Ok(Json(json!({ "ok": true, "points": points })))
}

// ----------------------------------------------------------------------------
// top-users / top-models
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct TopQuery {
    n: Option<u32>,
    days: Option<u32>,
}

async fn top_users(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<TopQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let n = q.n.unwrap_or(10).min(50) as i64;
    let days = q.days.unwrap_or(30).min(180) as i64;

    let rows: Vec<(i64, String, i64, Option<BigDecimal>, Option<BigDecimal>)> =
        sqlx::query_as(
            "SELECT u.id, u.username, COUNT(*) AS calls, \
                    COALESCE(SUM(l.input_tokens + l.output_tokens), 0) AS tokens, \
                    COALESCE(SUM(l.cost_usd), 0) AS cost \
             FROM usage_logs l JOIN users u ON u.id = l.user_id \
             WHERE l.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) \
             GROUP BY u.id, u.username \
             ORDER BY cost DESC LIMIT ?",
        )
        .bind(days)
        .bind(n)
        .fetch_all(&state.db)
        .await?;
    let top: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, calls, tokens, cost)| {
            json!({
                "id": id,
                "username": name,
                "calls": calls,
                "tokens": tokens.and_then(|d| d.to_i64()).unwrap_or(0),
                "costUsd": cost.map(|d| d.to_string()).unwrap_or_else(|| "0".into()),
            })
        })
        .collect();
    Ok(Json(json!({ "ok": true, "topUsers": top })))
}

async fn top_models(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<TopQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let n = q.n.unwrap_or(10).min(50) as i64;
    let days = q.days.unwrap_or(30).min(180) as i64;

    let rows: Vec<(String, i64, Option<BigDecimal>, Option<BigDecimal>)> = sqlx::query_as(
        "SELECT model, COUNT(*) AS calls, \
                COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, \
                COALESCE(SUM(cost_usd), 0) AS cost \
         FROM usage_logs \
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) \
         GROUP BY model ORDER BY tokens DESC LIMIT ?",
    )
    .bind(days)
    .bind(n)
    .fetch_all(&state.db)
    .await?;
    let top: Vec<Value> = rows
        .into_iter()
        .map(|(m, calls, tokens, cost)| {
            json!({
                "model": m,
                "calls": calls,
                "tokens": tokens.and_then(|d| d.to_i64()).unwrap_or(0),
                "costUsd": cost.map(|d| d.to_string()).unwrap_or_else(|| "0".into()),
            })
        })
        .collect();
    Ok(Json(json!({ "ok": true, "topModels": top })))
}

// ----------------------------------------------------------------------------
// QPS: 近 N 分钟每分钟调用数（默认 60 分钟）
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct QpsQuery {
    minutes: Option<u32>,
}

async fn qps(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Query(q): Query<QpsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let minutes = q.minutes.unwrap_or(60).clamp(5, 1440) as i64;

    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS bucket, COUNT(*) AS calls \
         FROM usage_logs \
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE) \
         GROUP BY bucket ORDER BY bucket ASC",
    )
    .bind(minutes)
    .fetch_all(&state.db)
    .await?;

    let points: Vec<Value> = rows
        .into_iter()
        .map(|(b, c)| json!({ "bucket": b, "calls": c }))
        .collect();
    Ok(Json(json!({ "ok": true, "points": points })))
}

// ----------------------------------------------------------------------------
// channels-24h: 各渠道近 24h 调用量 + 成功率（基于 last_test_ok 近似）
// ----------------------------------------------------------------------------

async fn channels_24h(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let calls_24h: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM usage_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)",
    )
    .fetch_one(&state.db)
    .await?;
    // 现在 usage_logs.channel_id 已存在，可以做真正的"渠道维度 24h 统计"
    let rows: Vec<(i64, String, i8, Option<i32>, Option<i8>, i64, i64, i64)> = sqlx::query_as(
        "SELECT c.id, c.name, c.status, c.last_test_ms, c.last_test_ok, \
                COALESCE(SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END), 0) AS calls_24h, \
                COALESCE(SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND l.latency_ms > 0 THEN l.latency_ms ELSE 0 END), 0) AS sum_lat, \
                COALESCE(SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND l.latency_ms > 0 THEN 1 ELSE 0 END), 0) AS lat_count \
         FROM channels c LEFT JOIN usage_logs l ON l.channel_id = c.id \
         GROUP BY c.id, c.name, c.status, c.last_test_ms, c.last_test_ok ORDER BY c.id",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let channels: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, status, ms, ok, calls, sum_lat, lat_n)| {
            let avg_lat = if lat_n > 0 { sum_lat / lat_n } else { 0 };
            json!({
                "id": id,
                "name": name,
                "status": status,
                "lastTestMs": ms,
                "lastTestOk": ok,
                "calls24h": calls,
                "avgLatencyMs": avg_lat,
            })
        })
        .collect();
    Ok(Json(json!({
        "ok": true,
        "callsTotal24h": calls_24h.0,
        "channels": channels,
    })))
}

// ----------------------------------------------------------------------------
// system: CPU / Memory / Redis 队列长度（轻量快照）
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// 活跃用户（DAU / WAU / MAU + 当前在线）
// ----------------------------------------------------------------------------

async fn activity(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    async fn count_distinct_days(state: &AppState, days: i64) -> i64 {
        let r: (i64,) = sqlx::query_as(
            "SELECT COUNT(DISTINCT user_id) FROM usage_logs \
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)",
        )
        .bind(days)
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));
        r.0
    }
    let dau = count_distinct_days(&state, 1).await;
    let wau = count_distinct_days(&state, 7).await;
    let mau = count_distinct_days(&state, 30).await;

    // 在线用户：Redis 中 refresh:{jti} 的 key 数量（粗略，等价"未登出 session 数"）
    let mut conn = state.redis.clone();
    let online: i64 = redis::cmd("EVAL")
        .arg("local c = 0 for _,_ in ipairs(redis.call('keys', 'refresh:*')) do c = c + 1 end return c")
        .arg(0)
        .query_async(&mut conn)
        .await
        .unwrap_or(0);

    Ok(Json(json!({
        "ok": true,
        "dau": dau,
        "wau": wau,
        "mau": mau,
        "online": online,
    })))
}

// ----------------------------------------------------------------------------
// 性能：渠道 latency p50/p95/p99（基于 usage_logs.latency_ms）
// ----------------------------------------------------------------------------

async fn perf(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    // 简化：对最近 24h 内每个渠道，取最大/平均/min；再算全局 p50/p95/p99
    let per_channel: Vec<(Option<i64>, Option<String>, i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT l.channel_id, c.name, COUNT(*) AS calls, \
                CAST(AVG(l.latency_ms) AS SIGNED) AS avg_ms, \
                MAX(l.latency_ms) AS max_ms \
         FROM usage_logs l LEFT JOIN channels c ON c.id = l.channel_id \
         WHERE l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND l.latency_ms > 0 \
         GROUP BY l.channel_id, c.name ORDER BY avg_ms DESC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;

    // 全局百分位：取最近 10k 条排序选下标
    let lats: Vec<i64> = sqlx::query_scalar(
        "SELECT latency_ms FROM usage_logs \
         WHERE latency_ms > 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) \
         ORDER BY id DESC LIMIT 10000",
    )
    .fetch_all(&state.db)
    .await?;
    let mut sorted = lats.clone();
    sorted.sort_unstable();
    let percentile = |p: f64| -> i64 {
        if sorted.is_empty() {
            return 0;
        }
        let idx = ((sorted.len() as f64 - 1.0) * p) as usize;
        sorted[idx]
    };

    Ok(Json(json!({
        "ok": true,
        "globalP50": percentile(0.50),
        "globalP95": percentile(0.95),
        "globalP99": percentile(0.99),
        "perChannel": per_channel
            .into_iter()
            .map(|(cid, name, calls, avg, max)| json!({
                "channelId": cid,
                "name": name,
                "calls": calls,
                "avgMs": avg.unwrap_or(0),
                "maxMs": max.unwrap_or(0),
            }))
            .collect::<Vec<_>>(),
    })))
}

// ----------------------------------------------------------------------------
// 用户分组消费占比
// ----------------------------------------------------------------------------

async fn group_spend(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let rows: Vec<(Option<i64>, Option<String>, Option<BigDecimal>)> = sqlx::query_as(
        "SELECT u.group_id, g.display_name, COALESCE(SUM(l.cost_usd), 0) AS cost \
         FROM usage_logs l JOIN users u ON u.id = l.user_id \
         LEFT JOIN user_groups g ON g.id = u.group_id \
         WHERE l.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) \
         GROUP BY u.group_id, g.display_name ORDER BY cost DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    Ok(Json(json!({
        "ok": true,
        "groups": rows.into_iter().map(|(gid, name, cost)| json!({
            "groupId": gid,
            "name": name.unwrap_or_else(|| "未分组".into()),
            "costUsd": cost.map(|d| d.to_string()).unwrap_or_else(|| "0".into()),
        })).collect::<Vec<_>>(),
    })))
}

// ----------------------------------------------------------------------------
// TOP 10 异常渠道（按 fail_count + last_test_ok=0 排序）
// ----------------------------------------------------------------------------

async fn failing_channels(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;
    let rows: Vec<(i64, String, i32, i8, Option<i8>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, fail_count, status, last_test_ok, disabled_reason \
         FROM channels \
         WHERE fail_count > 0 OR status = 0 OR last_test_ok = 0 \
         ORDER BY fail_count DESC, status ASC LIMIT 10",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    Ok(Json(json!({
        "ok": true,
        "channels": rows.into_iter().map(|(id,n,fc,st,ok,reason)| json!({
            "id": id, "name": n, "failCount": fc, "status": st,
            "lastTestOk": ok, "disabledReason": reason,
        })).collect::<Vec<_>>(),
    })))
}

async fn system_status(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("usage.read.all")?;

    let (cpu_pct, mem_used, mem_total) = {
        let mut sys = sysinfo::System::new();
        sys.refresh_cpu_usage();
        // sysinfo 第一次 refresh 拿不到 CPU 增量，sleep 一小会再 refresh
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let cpu = sys.global_cpu_usage();
        let mem_used = sys.used_memory(); // bytes
        let mem_total = sys.total_memory();
        (cpu, mem_used, mem_total)
    };

    // Redis 任意队列长度：这里没有特定 list，给一个 CLIENT LIST 的连接数代替
    let mut conn = state.redis.clone();
    let redis_clients: i64 = redis::cmd("CLIENT")
        .arg("LIST")
        .query_async::<String>(&mut conn)
        .await
        .map(|s| s.lines().count() as i64)
        .unwrap_or(0);

    Ok(Json(json!({
        "ok": true,
        "cpuPct": cpu_pct,
        "memUsedBytes": mem_used,
        "memTotalBytes": mem_total,
        "memUsedPct": if mem_total > 0 {
            (mem_used as f64 / mem_total as f64) * 100.0
        } else { 0.0 },
        "redisClients": redis_clients,
    })))
}
