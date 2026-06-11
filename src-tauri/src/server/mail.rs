//! 邮件子系统：SMTP 配置读取 + send_email 工具 + 验证码存取（Redis）。
//!
//! 设计要点：
//! - SMTP 配置完全走 config_kv("smtp_config")；UI 改这一个 KV 即可热生效，无需重启
//! - 发件实现走 lettre + tokio rustls；不强制启用，未启用时 `is_enabled()` 返回 false
//! - 验证码使用 Redis：`email_code:{purpose}:{email}` → code，TTL 5 分钟
//! - 同邮箱限速：`email_code_rl:{email}` 1 分钟一次

use lettre::message::{header, Mailbox};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use rand::Rng;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SmtpConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from_address: String,
    pub from_name: String,
    pub use_tls: bool,
}

pub async fn load_smtp_config(db: &MySqlPool) -> SmtpConfig {
    let row: Option<(sqlx::types::Json<serde_json::Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'smtp_config'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    match row {
        Some((sqlx::types::Json(v),)) => serde_json::from_value(v).unwrap_or_default(),
        None => SmtpConfig::default(),
    }
}

pub fn is_enabled(cfg: &SmtpConfig) -> bool {
    cfg.enabled && !cfg.host.is_empty() && !cfg.from_address.is_empty()
}

/// 真发邮件。返回 Err 时给前端友好提示。
pub async fn send_email(
    cfg: &SmtpConfig,
    to: &str,
    subject: &str,
    body_html: &str,
) -> Result<(), String> {
    if !is_enabled(cfg) {
        return Err("SMTP 服务尚未启用或未配置".into());
    }
    let from: Mailbox = format!("{} <{}>", cfg.from_name, cfg.from_address)
        .parse()
        .map_err(|e| format!("发件地址无效: {e}"))?;
    let to: Mailbox = to.parse().map_err(|e| format!("收件地址无效: {e}"))?;
    let email = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .header(header::ContentType::TEXT_HTML)
        .body(body_html.to_string())
        .map_err(|e| format!("构造邮件失败: {e}"))?;

    let creds = Credentials::new(cfg.username.clone(), cfg.password.clone());
    let mailer: AsyncSmtpTransport<Tokio1Executor> = if cfg.use_tls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
            .map_err(|e| format!("SMTP TLS 初始化失败: {e}"))?
            .credentials(creds)
            .port(cfg.port)
            .build()
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host)
            .credentials(creds)
            .port(cfg.port)
            .build()
    };
    mailer
        .send(email)
        .await
        .map_err(|e| format!("SMTP 发送失败: {e}"))?;
    Ok(())
}

/// 生成 6 位数字验证码并写入 Redis（5 分钟有效）。
/// purpose: "register" / "reset_pw" / 等等
pub async fn issue_email_code(
    redis: &mut ConnectionManager,
    purpose: &str,
    email: &str,
) -> Result<String, String> {
    // 限速：60s 内同邮箱不能再次请求
    let rl_key = format!("email_code_rl:{purpose}:{email}");
    let exists: Option<i32> = redis::cmd("EXISTS")
        .arg(&rl_key)
        .query_async(redis)
        .await
        .map_err(|e| e.to_string())?;
    if exists.unwrap_or(0) == 1 {
        return Err("请求过于频繁，请 60 秒后再试".into());
    }
    // 注意：ThreadRng 不是 Send，必须在 await 前结束作用域
    let code_str = {
        let mut rng = rand::thread_rng();
        format!("{:06}", rng.gen_range(0..1_000_000u32))
    };
    let key = format!("email_code:{purpose}:{email}");
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(&code_str)
        .arg("EX")
        .arg(5 * 60)
        .query_async(redis)
        .await
        .map_err(|e| e.to_string())?;
    let _: () = redis::cmd("SET")
        .arg(&rl_key)
        .arg("1")
        .arg("EX")
        .arg(60)
        .query_async(redis)
        .await
        .map_err(|e| e.to_string())?;
    Ok(code_str)
}

/// 校验验证码；通过后立即删除（防重放）。
pub async fn verify_email_code(
    redis: &mut ConnectionManager,
    purpose: &str,
    email: &str,
    code: &str,
) -> Result<(), String> {
    let key = format!("email_code:{purpose}:{email}");
    let stored: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(redis)
        .await
        .map_err(|e| e.to_string())?;
    let Some(real) = stored else {
        return Err("验证码已过期或未发送".into());
    };
    if real != code.trim() {
        return Err("验证码错误".into());
    }
    let _: i64 = redis::cmd("DEL")
        .arg(&key)
        .query_async(redis)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 渲染统一的 HTML 验证码邮件
pub fn render_code_email(site_name: &str, code: &str, purpose_label: &str) -> String {
    format!(
        r#"<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, sans-serif; background: #f6f7f9; padding: 24px;">
<div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
  <h2 style="margin: 0 0 8px; color: #111;">{site_name}</h2>
  <p style="color: #555; margin: 0 0 16px;">您正在进行 <b>{purpose_label}</b> 操作。</p>
  <div style="font-size: 28px; letter-spacing: 6px; padding: 12px 16px; background: #f3f4f6; border-radius: 8px; text-align: center; color: #111; font-weight: 600;">{code}</div>
  <p style="color: #888; font-size: 12px; margin-top: 16px;">验证码 5 分钟内有效。如果不是您本人的操作，请忽略本邮件。</p>
</div>
</body></html>"#
    )
}

/// 从 config_kv("mail_templates") 取到对应 purpose 的模板（subject + html），
/// 用 `{code}` `{site}` `{email}` 占位符替换。模板缺失时回退到内置 `render_code_email`。
pub async fn render_template_email(
    db: &sqlx::MySqlPool,
    purpose: &str,
    site_name: &str,
    code: &str,
    email: &str,
) -> (String, String) {
    let row: Option<(sqlx::types::Json<serde_json::Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'mail_templates'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let templates = row.map(|(j,)| j.0).unwrap_or(serde_json::Value::Null);
    // purpose 映射到模板键
    let tmpl_key = match purpose {
        "register" => "register",
        "reset_pw" => "resetPw",
        "bind_email" => "bindEmail",
        _ => "register",
    };
    let subject = templates
        .get(tmpl_key)
        .and_then(|v| v.get("subject"))
        .and_then(|v| v.as_str())
        .map(|s| substitute(s, site_name, code, email))
        .unwrap_or_else(|| format!("【{}】验证码：{}", site_name, code));
    let html = templates
        .get(tmpl_key)
        .and_then(|v| v.get("html"))
        .and_then(|v| v.as_str())
        .map(|s| substitute(s, site_name, code, email))
        .unwrap_or_else(|| render_code_email(site_name, code, purpose));
    (subject, html)
}

fn substitute(src: &str, site: &str, code: &str, email: &str) -> String {
    src.replace("{site}", site)
        .replace("{code}", code)
        .replace("{email}", email)
}

/// 取站点名（来自 config_kv.site_info.name，否则 "CCAPI"）。
pub async fn site_name(db: &sqlx::MySqlPool) -> String {
    let row: Option<(sqlx::types::Json<serde_json::Value>,)> =
        sqlx::query_as("SELECT v FROM config_kv WHERE k = 'site_info'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    row.and_then(|(j,)| {
        j.0.get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })
    .unwrap_or_else(|| "CCAPI".into())
}
