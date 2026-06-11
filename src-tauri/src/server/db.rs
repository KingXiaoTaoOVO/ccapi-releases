use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use std::time::Duration;

use super::local_config::MysqlConfig;

/// 嵌入 SQL 脚本（include_str! 在编译期把 sql/init.sql 直接编入二进制）
const INIT_SQL: &str = include_str!("../../../sql/init.sql");

pub async fn connect(cfg: &MysqlConfig) -> Result<MySqlPool, String> {
    let url = cfg.url();
    MySqlPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&url)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))
}

/// 测试连接（不持久化 pool，仅用于 UI 上的「测试连接」按钮）
pub async fn test_connection(cfg: &MysqlConfig) -> Result<(), String> {
    // 测试时先连不带库名的根连接，避免库不存在导致失败
    let test_dsn = format!(
        "mysql://{}:{}@{}:{}/",
        cfg.user, cfg.password, cfg.host, cfg.port
    );
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&test_dsn)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))?;
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| format!("MySQL 查询失败: {e}"))?;
    Ok(())
}

/// 执行 sql/init.sql 完成数据库初始化。
///
/// MySQL 的 `USE` 和 `CREATE DATABASE` 不支持 prepared statement protocol（错误 1295）。
/// 解决：
///   1. 先用「无库」DSN 连接，单独 raw_sql 执行 CREATE DATABASE
///   2. 切到目标库 pool 后，跳过 `USE` 与 `CREATE DATABASE` 语句执行剩余 schema
///   3. DDL/INSERT 用 raw_sql 提交（避免 sqlx 把多语句拆 prepared）
pub async fn run_init_script(cfg: &MysqlConfig) -> Result<u32, String> {
    run_init_script_inner(cfg, false).await
}

/// 重置数据库：DROP DATABASE IF EXISTS → CREATE DATABASE → 执行 schema。
/// 用于 schema 升级 / 用户主动重建。会丢失所有用户数据，前端必须二次确认。
pub async fn reset_database(cfg: &MysqlConfig) -> Result<u32, String> {
    run_init_script_inner(cfg, true).await
}

async fn run_init_script_inner(cfg: &MysqlConfig, drop_first: bool) -> Result<u32, String> {
    let root_dsn = format!(
        "mysql://{}:{}@{}:{}/",
        cfg.user, cfg.password, cfg.host, cfg.port
    );
    let root_pool = MySqlPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&root_dsn)
        .await
        .map_err(|e| format!("MySQL 连接失败（初始化）: {e}"))?;

    // 步骤 0（可选）：DROP 旧数据库（仅在 reset 时调用）
    if drop_first {
        let drop_db = format!("DROP DATABASE IF EXISTS `{}`", cfg.database);
        sqlx::raw_sql(&drop_db)
            .execute(&root_pool)
            .await
            .map_err(|e| format!("删除数据库失败: {e}"))?;
    }

    // 步骤 1：创建数据库（用 raw_sql 直接走文本协议）
    let create_db = format!(
        "CREATE DATABASE IF NOT EXISTS `{}` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        cfg.database
    );
    sqlx::raw_sql(&create_db)
        .execute(&root_pool)
        .await
        .map_err(|e| format!("创建数据库失败: {e}"))?;
    drop(root_pool);

    // 步骤 2：连接目标库
    let pool = connect(cfg).await?;

    // 步骤 3：依次执行其余语句（跳过 USE 与 CREATE DATABASE）
    let mut executed = 0u32;
    for stmt in split_statements(INIT_SQL) {
        let s = stmt.trim();
        if s.is_empty() {
            continue;
        }
        let upper = s.to_uppercase();
        if upper.starts_with("USE ")
            || upper.starts_with("USE\t")
            || upper.starts_with("USE\n")
            || upper.starts_with("CREATE DATABASE")
        {
            continue;
        }
        // raw_sql 走文本协议，能容忍 DDL/INSERT 中的各种 MySQL 扩展
        sqlx::raw_sql(s)
            .execute(&pool)
            .await
            .map_err(|e| format!("执行 SQL 失败: {e}\n语句: {}", &s[..s.len().min(160)]))?;
        executed += 1;
    }
    Ok(executed)
}

/// 简易 SQL 分语句（不处理字符串中含 `;` 的极端情况，但我们的 init.sql 不含此类）
fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    for line in sql.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("--") || trimmed.is_empty() {
            continue;
        }
        buf.push_str(line);
        buf.push('\n');
        if line.trim_end().ends_with(';') {
            out.push(buf.clone());
            buf.clear();
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}
