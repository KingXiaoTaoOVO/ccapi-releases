use redis::aio::ConnectionManager;

use super::local_config::RedisConfig;

pub async fn connect(cfg: &RedisConfig) -> Result<ConnectionManager, String> {
    let client = redis::Client::open(cfg.url()).map_err(|e| format!("Redis URL 无效: {e}"))?;
    ConnectionManager::new(client)
        .await
        .map_err(|e| format!("Redis 连接失败: {e}"))
}

pub async fn test_connection(cfg: &RedisConfig) -> Result<(), String> {
    let mut conn = connect(cfg).await?;
    let pong: String = redis::cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(|e| format!("Redis PING 失败: {e}"))?;
    if pong != "PONG" {
        return Err(format!("Redis 返回非预期: {pong}"));
    }
    Ok(())
}
