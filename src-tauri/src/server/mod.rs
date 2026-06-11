pub mod audit;
pub mod auth;
pub mod billing;
pub mod captcha;
pub mod crypto;
pub mod db;
pub mod error;
pub mod export;
pub mod jwt_mw;
pub mod kv;
pub mod local_config;
pub mod mail;
pub mod permissions;
pub mod quota_hook;
pub mod relay;
pub mod router;
pub mod routes;
pub mod transform;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware;
use axum::Router;
use redis::aio::ConnectionManager;
use serde::Serialize;
use sqlx::mysql::MySqlPool;
use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex};
use tower_http::cors::{Any, CorsLayer};

use auth::JwtIssuer;

// ---------------------------------------------------------------------------
// AppState — 注入到 axum 路由
// ---------------------------------------------------------------------------
#[derive(Clone)]
pub struct AppState {
    pub db: MySqlPool,
    pub redis: ConnectionManager,
    pub jwt: Arc<JwtIssuer>,
    /// 原始 jwt_secret，给字段加密派生主密钥用。仅服务端进程内持有。
    pub jwt_secret: Arc<String>,
    #[allow(dead_code)]
    pub app: AppHandle,
}

// ---------------------------------------------------------------------------
// ServerState — Tauri 注入的全局可变状态
// ---------------------------------------------------------------------------
pub struct ServerHandle {
    pub shutdown: oneshot::Sender<()>,
    pub bound: SocketAddr,
}

pub struct ServerState {
    pub inner: Mutex<Option<ServerHandle>>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令：启动 / 停止 / 状态
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub bound_address: Option<String>,
    pub initialized: bool,
}

#[tauri::command]
pub async fn admin_server_status(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
) -> Result<ServerStatus, String> {
    let cfg = local_config::read_server_local_config(app)?;
    let guard = state.inner.lock().await;
    Ok(ServerStatus {
        running: guard.is_some(),
        bound_address: guard.as_ref().map(|h| h.bound.to_string()),
        initialized: cfg.initialized,
    })
}

#[tauri::command]
pub async fn start_admin_server(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
    proxy_state: tauri::State<'_, Arc<crate::proxy::ProxyState>>,
) -> Result<ServerStatus, String> {
    // 已运行则直接返回
    {
        let g = state.inner.lock().await;
        if g.is_some() {
            return Ok(ServerStatus {
                running: true,
                bound_address: g.as_ref().map(|h| h.bound.to_string()),
                initialized: true,
            });
        }
    }

    let cfg = local_config::read_server_local_config(app.clone())?;
    if !cfg.initialized {
        return Err("服务端尚未初始化（请先在设置中保存 MySQL/Redis 并初始化数据库）".into());
    }

    let db = db::connect(&cfg.mysql).await?;
    let redis_conn = kv::connect(&cfg.redis).await?;
    let jwt = Arc::new(JwtIssuer::new(&cfg.jwt_secret));

    // 在同一进程内把 quota hook 注入本机 proxy —— 服务端模式下，admin 自己同时
    // 是客户端时也能直接走代理；客户端模式下 proxy_state 不会被服务端注入。
    let hook = Arc::new(quota_hook::LocalQuotaHook {
        db: db.clone(),
        redis: redis_conn.clone(),
    });
    proxy_state.set_quota_hook(Some(hook as Arc<dyn quota_hook::QuotaHook>));

    let app_state = AppState {
        db,
        redis: redis_conn,
        jwt,
        jwt_secret: Arc::new(cfg.jwt_secret.clone()),
        app: app.clone(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // 受认证保护的路由：me / change-password / logout / admin/*
    let protected = Router::new()
        .merge(routes::auth::protected_router())
        .merge(routes::users::router())
        .merge(routes::roles::router())
        .merge(routes::config::router())
        .merge(routes::usage::router())
        .merge(routes::codes::router())
        .merge(routes::tiers::router())
        .merge(routes::me::router())
        .merge(routes::invites::router())
        .merge(routes::channels::router())
        .merge(routes::dashboard::router())
        .merge(routes::models::router())
        .merge(routes::user_groups::router())
        .merge(routes::tokens::router())
        .merge(routes::mail::protected_router())
        .merge(routes::site::protected_router())
        .merge(routes::totp::router())
        .merge(routes::passkey::router())
        .merge(routes::oauth::protected_router())
        .merge(routes::recharge::protected_router())
        .merge(routes::subscriptions::router())
        .merge(routes::tasks::router())
        .merge(routes::data_export::router())
        .merge(routes::orgs::router())
        .merge(routes::checkin::router())
        .merge(routes::prefill::router())
        .merge(audit::router())
        .merge(relay::router())
        .layer(middleware::from_fn_with_state(
            app_state.clone(),
            jwt_mw::jwt_layer,
        ));

    let public = Router::new()
        .merge(routes::health::router())
        .merge(routes::auth::router())
        .merge(routes::mail::public_router())
        .merge(routes::site::public_router())
        .merge(routes::oauth::public_router())
        .merge(routes::passkey::public_router())
        .merge(routes::recharge::public_router())
        .merge(captcha::router());

    let api = Router::new()
        .merge(public)
        .merge(protected)
        .with_state(app_state)
        .layer(cors);

    let listen_addr = format!("{}:{}", cfg.listen_ip, cfg.listen_port);
    let addr: SocketAddr = listen_addr
        .parse()
        .map_err(|e| format!("监听地址无效: {e}"))?;

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("端口绑定失败: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;

    let (tx, rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, api)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    {
        let mut g = state.inner.lock().await;
        *g = Some(ServerHandle {
            shutdown: tx,
            bound,
        });
    }

    Ok(ServerStatus {
        running: true,
        bound_address: Some(bound.to_string()),
        initialized: true,
    })
}

#[tauri::command]
pub async fn stop_admin_server(
    state: tauri::State<'_, Arc<ServerState>>,
    proxy_state: tauri::State<'_, Arc<crate::proxy::ProxyState>>,
) -> Result<(), String> {
    let mut g = state.inner.lock().await;
    if let Some(h) = g.take() {
        let _ = h.shutdown.send(());
    }
    proxy_state.set_quota_hook(None);
    Ok(())
}

// ---------------------------------------------------------------------------
// 初始化 / 测试连接 / 探活
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn test_mysql_connection(
    cfg: local_config::MysqlConfig,
) -> Result<(), String> {
    db::test_connection(&cfg).await
}

#[tauri::command]
pub async fn test_redis_connection(
    cfg: local_config::RedisConfig,
) -> Result<(), String> {
    kv::test_connection(&cfg).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitReport {
    pub statements_executed: u32,
    pub admin_seeded: bool,
}

#[tauri::command]
pub async fn init_database(app: AppHandle) -> Result<InitReport, String> {
    init_database_inner(app, false).await
}

/// 完全重置数据库（DROP + CREATE + schema + seed admin）。
/// 用于 schema 升级或用户主动重建。会丢失所有数据，前端二次确认必须强制。
#[tauri::command]
pub async fn reset_database(app: AppHandle) -> Result<InitReport, String> {
    init_database_inner(app, true).await
}

async fn init_database_inner(app: AppHandle, drop_first: bool) -> Result<InitReport, String> {
    let mut cfg = local_config::read_server_local_config(app.clone())?;

    // 1. 执行 schema + 业务种子 SQL（可选先 DROP）
    let executed = if drop_first {
        db::reset_database(&cfg.mysql).await?
    } else {
        db::run_init_script(&cfg.mysql).await?
    };

    // 2. 连接目标库
    let pool = db::connect(&cfg.mysql).await?;

    // 2.5 增量迁移：给已有 schema 补缺字段（容错忽略已存在的错误）
    // users.group_id
    let _ = sqlx::query(
        "ALTER TABLE users ADD COLUMN group_id BIGINT DEFAULT NULL",
    )
    .execute(&pool)
    .await;
    let _ = sqlx::query(
        "ALTER TABLE users ADD INDEX idx_users_group (group_id)",
    )
    .execute(&pool)
    .await;
    // usage_logs.source（区分 local 本机代理 / official 服务端渠道）
    let _ = sqlx::query(
        "ALTER TABLE usage_logs ADD COLUMN source ENUM('local','official') NOT NULL DEFAULT 'official'",
    )
    .execute(&pool)
    .await;
    let _ = sqlx::query(
        "ALTER TABLE usage_logs ADD INDEX idx_usage_source (source)",
    )
    .execute(&pool)
    .await;
    // channels.group_ids（多对多分组）
    let _ = sqlx::query(
        "ALTER TABLE channels ADD COLUMN group_ids JSON DEFAULT NULL",
    )
    .execute(&pool)
    .await;
    // channels.key_state（多 Key 模式：每 key 的 failCount / disabled 数组）
    let _ = sqlx::query(
        "ALTER TABLE channels ADD COLUMN key_state JSON DEFAULT NULL",
    )
    .execute(&pool)
    .await;
    // usage_logs.latency_ms + channel_id（性能监控 + 渠道维度统计）
    let _ = sqlx::query(
        "ALTER TABLE usage_logs ADD COLUMN latency_ms INT NOT NULL DEFAULT 0",
    )
    .execute(&pool)
    .await;
    let _ = sqlx::query(
        "ALTER TABLE usage_logs ADD COLUMN channel_id BIGINT DEFAULT NULL",
    )
    .execute(&pool)
    .await;
    let _ = sqlx::query(
        "ALTER TABLE usage_logs ADD INDEX idx_usage_channel (channel_id, created_at)",
    )
    .execute(&pool)
    .await;
    // users.models_allowed（按用户维度模型白名单）
    let _ = sqlx::query(
        "ALTER TABLE users ADD COLUMN models_allowed JSON DEFAULT NULL",
    )
    .execute(&pool)
    .await;
    // user_groups.models_allowed（按分组维度模型白名单）
    let _ = sqlx::query(
        "ALTER TABLE user_groups ADD COLUMN models_allowed JSON DEFAULT NULL",
    )
    .execute(&pool)
    .await;
    // Root 角色 seed（容错：已存在则 NOOP）
    let _ = sqlx::query(
        "INSERT INTO roles (id, name, description, is_system, permissions) \
         VALUES (3, 'root', '超级管理员（站点/支付/SMTP 等系统级配置）', 1, JSON_ARRAY('*')) \
         ON DUPLICATE KEY UPDATE description = VALUES(description)",
    )
    .execute(&pool)
    .await;

    // 第 5.1 波修复：给 user 角色补 token.* 权限（用户管理自己的 API 令牌时需要）
    // 用 UPDATE 而不是 INSERT ... ON DUPLICATE KEY，避免覆盖管理员定制的 user 权限
    let _ = sqlx::query(
        "UPDATE roles SET permissions = JSON_ARRAY(\
            'self.read','self.update','self.password',\
            'invite.create','invite.read.self',\
            'code.redeem','usage.read.self',\
            'token.read','token.create','token.update','token.delete'\
         ) WHERE name = 'user' AND is_system = 1",
    )
    .execute(&pool)
    .await;

    // 第 5.1 波修复：把过低的全局速率限制默认值提升到 6000/分钟
    // （旧默认 60 在管理员看板并发 12 个请求时会立刻触发"请求过快"）
    let _ = sqlx::query(
        "UPDATE config_kv SET v = CAST('6000' AS JSON) \
         WHERE k = 'api_rate_per_minute' AND v = CAST('60' AS JSON)",
    )
    .execute(&pool)
    .await;

    // 第 2/3 波：建新表（容错忽略已存在）
    for stmt in [
        "CREATE TABLE IF NOT EXISTS user_totp (\
            user_id BIGINT PRIMARY KEY, \
            secret_encrypted TEXT NOT NULL, \
            enabled TINYINT(1) NOT NULL DEFAULT 0, \
            recovery_hashes JSON NOT NULL, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            verified_at DATETIME DEFAULT NULL\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS user_passkeys (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            user_id BIGINT NOT NULL, \
            credential_id VARCHAR(255) UNIQUE NOT NULL, \
            public_key TEXT NOT NULL, \
            sign_count BIGINT NOT NULL DEFAULT 0, \
            nickname VARCHAR(64) DEFAULT NULL, \
            last_used_at DATETIME DEFAULT NULL, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            INDEX idx_passkey_user (user_id)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS oauth_providers (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            code VARCHAR(32) UNIQUE NOT NULL, \
            display_name VARCHAR(64) NOT NULL, \
            client_id VARCHAR(255) NOT NULL, \
            client_secret_encrypted TEXT NOT NULL, \
            authorize_url VARCHAR(255) NOT NULL, \
            token_url VARCHAR(255) NOT NULL, \
            userinfo_url VARCHAR(255) NOT NULL, \
            scopes VARCHAR(255) DEFAULT '', \
            enabled TINYINT(1) NOT NULL DEFAULT 1, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS user_oauth_links (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            user_id BIGINT NOT NULL, \
            provider_code VARCHAR(32) NOT NULL, \
            external_id VARCHAR(128) NOT NULL, \
            external_name VARCHAR(128) DEFAULT NULL, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            UNIQUE KEY uq_oauth_external (provider_code, external_id), \
            INDEX idx_oauth_user (user_id)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS recharge_orders (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            order_no VARCHAR(64) UNIQUE NOT NULL, \
            user_id BIGINT NOT NULL, \
            provider ENUM('epay','stripe','manual') NOT NULL, \
            amount_usd DECIMAL(10,2) NOT NULL, \
            currency VARCHAR(8) NOT NULL DEFAULT 'USD', \
            status ENUM('pending','paid','failed','refunded','cancelled') NOT NULL DEFAULT 'pending', \
            external_id VARCHAR(128) DEFAULT NULL, \
            metadata JSON DEFAULT NULL, \
            paid_at DATETIME DEFAULT NULL, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, \
            INDEX idx_orders_user (user_id, created_at), \
            INDEX idx_orders_status (status)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS async_tasks (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            user_id BIGINT NOT NULL, \
            task_type VARCHAR(64) NOT NULL, \
            status ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued', \
            payload JSON DEFAULT NULL, \
            result JSON DEFAULT NULL, \
            error TEXT DEFAULT NULL, \
            progress INT NOT NULL DEFAULT 0, \
            started_at DATETIME DEFAULT NULL, \
            finished_at DATETIME DEFAULT NULL, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            INDEX idx_task_user (user_id, created_at), \
            INDEX idx_task_status (status)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS subscription_auto_renew (\
            user_id BIGINT PRIMARY KEY, \
            tier_id BIGINT NOT NULL, \
            enabled TINYINT(1) NOT NULL DEFAULT 1, \
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS organizations (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            name VARCHAR(128) UNIQUE NOT NULL, \
            display_name VARCHAR(128) NOT NULL, \
            owner_user_id BIGINT NOT NULL, \
            billing_email VARCHAR(128) DEFAULT NULL, \
            status ENUM('active','disabled') NOT NULL DEFAULT 'active', \
            description VARCHAR(255) DEFAULT NULL, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, \
            INDEX idx_orgs_owner (owner_user_id)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS organization_members (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            org_id BIGINT NOT NULL, \
            user_id BIGINT NOT NULL, \
            role ENUM('owner','admin','member') NOT NULL DEFAULT 'member', \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            UNIQUE KEY uq_org_member (org_id, user_id), \
            INDEX idx_org_member_user (user_id)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS daily_checkins (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            user_id BIGINT NOT NULL, \
            checked_on DATE NOT NULL, \
            reward_usd DECIMAL(10,4) NOT NULL DEFAULT 0.10, \
            streak INT NOT NULL DEFAULT 1, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            UNIQUE KEY uq_checkin_day (user_id, checked_on), \
            INDEX idx_checkin_user (user_id, checked_on)\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS prefill_groups (\
            id BIGINT PRIMARY KEY AUTO_INCREMENT, \
            code VARCHAR(64) UNIQUE NOT NULL, \
            display_name VARCHAR(128) NOT NULL, \
            description VARCHAR(255) DEFAULT NULL, \
            prompts JSON NOT NULL, \
            enabled TINYINT(1) NOT NULL DEFAULT 1, \
            sort_order INT NOT NULL DEFAULT 0, \
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, \
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP\
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    ] {
        let _ = sqlx::query(stmt).execute(&pool).await;
    }

    // 第 2 波：补缺 config_kv 默认值（已有则不动）
    for (k, v) in [
        ("site_info", r#"{"name":"CCAPI","logoUrl":"","icpRecord":"","footer":"Powered by CCAPI","announcement":"","updateRepo":"KingXiaoTaoOVO/ccapi-releases"}"#),
        ("register_policy", r#"{"open":true,"requireInviteCode":false,"requireEmailVerify":false,"captchaStrength":"normal"}"#),
        ("smtp_config", r#"{"enabled":false,"host":"","port":587,"username":"","password":"","fromAddress":"","fromName":"CCAPI","useTls":true}"#),
        ("payment_config", r#"{"epay":{"enabled":false,"merchantId":"","key":"","gateway":"","notifyUrl":"","returnUrl":""},"stripe":{"enabled":false,"publishableKey":"","secretKey":"","webhookSecret":""}}"#),
        ("sensitive_words", "[]"),
        ("rate_limit_per_user_per_minute", "120"),
        ("rate_limit_per_group_per_minute", "{}"),
        // 第 4 波：计费 / 文档 / 高级
        ("billing_rules", r#"{"defaultMultiplier":1.0,"minBillingUnit":0.000001,"roundDecimals":6}"#),
        ("docs_content", r#"{"title":"使用文档","markdown":""}"#),
        ("system_advanced", r#"{"chatEnabled":true,"drawEnabled":true,"dashboardEnabled":true}"#),
    ] {
        let _ = sqlx::query(
            "INSERT IGNORE INTO config_kv (k, v) VALUES (?, CAST(? AS JSON))",
        )
        .bind(k)
        .bind(v)
        .execute(&pool)
        .await;
    }

    // 3. UPSERT admin 用户 —— 运行时用 Argon2id 哈希「123456」，确保哈希格式可被 verify 正确识别
    let admin_hash = auth::hash_password("123456")
        .map_err(|e| format!("生成 admin 密码哈希失败: {e}"))?;
    let res = sqlx::query(
        "INSERT INTO users (id, username, password_hash, role_id, status, must_change_password) \
         VALUES (1, 'admin', ?, 1, 'active', 1) \
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), must_change_password = 1",
    )
    .bind(&admin_hash)
    .execute(&pool)
    .await
    .map_err(|e| format!("种子 admin 用户失败: {e}"))?;
    let seeded = res.rows_affected() > 0;

    // 4. 标记本地配置已初始化
    cfg.initialized = true;
    local_config::write_server_local_config(app, cfg)?;

    Ok(InitReport {
        statements_executed: executed,
        admin_seeded: seeded,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHealth {
    pub ok: bool,
    pub service: Option<String>,
    pub version: Option<String>,
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn probe_remote_server(url: String) -> Result<RemoteHealth, String> {
    let started = std::time::Instant::now();
    let normalized = url.trim_end_matches('/').to_string();
    let probe = format!("{}/api/health", normalized);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&probe)
        .send()
        .await
        .map_err(|e| format!("探活失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .unwrap_or_else(|_| serde_json::json!({ "ok": status.is_success() }));
    Ok(RemoteHealth {
        ok: status.is_success() && body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        service: body
            .get("service")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        version: body
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        latency_ms: started.elapsed().as_millis() as u64,
    })
}
