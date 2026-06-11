use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
use argon2::Argon2;
use rand::RngCore;

/// `<app_data>/server.json` — 本地（DB 之前就需要的）服务端配置。
/// 包含：MySQL/Redis 连接、监听 IP/端口、入口密码 Argon2 哈希、JWT 签发密钥。
fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    Ok(dir.join("server.json"))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MysqlConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
}

impl Default for MysqlConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: "root".into(),
            database: "ccapi".into(),
        }
    }
}

impl MysqlConfig {
    pub fn url(&self) -> String {
        // sqlx mysql DSN — 密码 url-encoded by sqlx internally is unreliable;
        // 我们让用户保证密码不含 `@:/` 等特殊字符，或自行 url-encode。
        format!(
            "mysql://{}:{}@{}:{}/{}",
            self.user, self.password, self.host, self.port, self.database
        )
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RedisConfig {
    pub host: String,
    pub port: u16,
    /// Redis 默认无密码，task.txt 明确说明
    pub password: Option<String>,
    pub username: Option<String>,
    pub db: u8,
}

impl Default for RedisConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 6379,
            password: None,
            username: None,
            db: 0,
        }
    }
}

impl RedisConfig {
    pub fn url(&self) -> String {
        let auth = match (self.username.as_deref(), self.password.as_deref()) {
            (Some(u), Some(p)) => format!("{u}:{p}@"),
            (None, Some(p)) => format!(":{p}@"),
            _ => String::new(),
        };
        format!("redis://{}{}:{}/{}", auth, self.host, self.port, self.db)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerLocalConfig {
    pub mysql: MysqlConfig,
    pub redis: RedisConfig,
    pub listen_ip: String,
    pub listen_port: u16,
    /// 服务端入口密码（默认 root）的 Argon2id 哈希
    pub entry_password_hash: String,
    /// JWT 签发密钥（base64）。首次启动随机生成。
    pub jwt_secret: String,
    /// 标记是否已通过初次设置流程
    pub initialized: bool,
}

fn argon2_hash(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("Argon2 哈希失败: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn argon2_verify(password: &str, phc: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

fn random_secret() -> String {
    let mut buf = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut buf);
    use base64::Engine;
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(buf)
}

impl ServerLocalConfig {
    pub fn default_with_hashed() -> Result<Self, String> {
        Ok(Self {
            mysql: MysqlConfig::default(),
            redis: RedisConfig::default(),
            listen_ip: "127.0.0.1".into(),
            listen_port: 8787,
            entry_password_hash: argon2_hash("root")?,
            jwt_secret: random_secret(),
            initialized: false,
        })
    }
}

#[tauri::command]
pub fn read_server_local_config(app: AppHandle) -> Result<ServerLocalConfig, String> {
    let path = config_file(&app)?;
    if !path.exists() {
        let fresh = ServerLocalConfig::default_with_hashed()?;
        let text = serde_json::to_string_pretty(&fresh).map_err(|e| e.to_string())?;
        fs::write(&path, text).map_err(|e| format!("写入 server.json 失败: {e}"))?;
        return Ok(fresh);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 server.json 失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 server.json 失败: {e}"))
}

#[tauri::command]
pub fn write_server_local_config(
    app: AppHandle,
    cfg: ServerLocalConfig,
) -> Result<(), String> {
    let path = config_file(&app)?;
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 server.json 失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存 server.json 失败: {e}"))?;
    Ok(())
}

/// 校验入口密码
#[tauri::command]
pub fn verify_entry_password(app: AppHandle, password: String) -> Result<bool, String> {
    let cfg = read_server_local_config(app)?;
    Ok(argon2_verify(&password, &cfg.entry_password_hash))
}

/// 修改入口密码（需要旧密码二次确认）
#[tauri::command]
pub fn change_entry_password(
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.len() < 4 {
        return Err("新密码至少 4 位".into());
    }
    let mut cfg = read_server_local_config(app.clone())?;
    if !argon2_verify(&old_password, &cfg.entry_password_hash) {
        return Err("旧密码不正确".into());
    }
    cfg.entry_password_hash = argon2_hash(&new_password)?;
    write_server_local_config(app, cfg)
}
