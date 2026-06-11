//! 一键写入 Codex CLI 配置（~/.codex/config.toml + ~/.codex/auth.json）。
//!
//! 目标：让 OpenAI Codex CLI 直接通过 CCAPI 转发，无需用户手动改 toml。
//! 策略：
//! - 新增 / 覆盖 `[model_providers.ccapi]` 段（保留用户其它 provider）；
//! - 把 `model_provider = "ccapi"` 设为顶层默认；
//! - 在 `~/.codex/auth.json` 写 `{"OPENAI_API_KEY": "<token>"}`（这是 codex 当前读环境变量的回退路径）。
//!
//! 用 toml_edit 解析 + 写回，保留用户其它 key 的格式与注释。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::json;
use toml_edit::{value, DocumentMut, Item, Table};

use crate::paths;

const PROVIDER_KEY: &str = "ccapi";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigReport {
    pub config_path: String,
    pub auth_path: String,
    pub created_provider: bool,
    /// 原文件是否本来就存在
    pub had_existing_config: bool,
}

fn codex_dir() -> Result<PathBuf, String> {
    let home = paths::home_dir().ok_or("无法定位用户主目录")?;
    let dir = home.join(".codex");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 ~/.codex: {e}"))?;
    Ok(dir)
}

fn write_config_toml(base_url: &str, model: &str) -> Result<(String, bool, bool), String> {
    let dir = codex_dir()?;
    let path = dir.join("config.toml");
    let existed = path.exists();
    let raw = if existed {
        fs::read_to_string(&path).map_err(|e| format!("读取 config.toml 失败: {e}"))?
    } else {
        String::new()
    };
    let mut doc: DocumentMut = raw
        .parse::<DocumentMut>()
        .map_err(|e| format!("config.toml 不是合法 TOML: {e}"))?;

    let providers = doc
        .as_table_mut()
        .entry("model_providers")
        .or_insert(Item::Table(Table::new()));
    let providers_table = providers
        .as_table_mut()
        .ok_or("model_providers 不是表，无法注入")?;
    providers_table.set_implicit(true);

    let created_provider = !providers_table.contains_key(PROVIDER_KEY);
    let prov_entry = providers_table
        .entry(PROVIDER_KEY)
        .or_insert(Item::Table(Table::new()));
    let prov_table = prov_entry
        .as_table_mut()
        .ok_or("model_providers.ccapi 不是表，无法注入")?;
    prov_table["name"] = value("CCAPI");
    prov_table["base_url"] = value(base_url);
    // codex 默认从 env_key 读 token；我们另外在 auth.json 写一份兜底
    prov_table["env_key"] = value("OPENAI_API_KEY");
    prov_table["wire_api"] = value("chat");

    // 顶层默认 provider / model（如果用户没指定）
    doc["model_provider"] = value(PROVIDER_KEY);
    if !doc.contains_key("model") {
        doc["model"] = value(model);
    }

    fs::write(&path, doc.to_string()).map_err(|e| format!("写入 config.toml 失败: {e}"))?;
    Ok((paths::to_string(&path), created_provider, existed))
}

fn write_auth_json(token: &str) -> Result<String, String> {
    let dir = codex_dir()?;
    let path = dir.join("auth.json");
    let body = json!({ "OPENAI_API_KEY": token });
    fs::write(&path, serde_json::to_string_pretty(&body).unwrap())
        .map_err(|e| format!("写入 auth.json 失败: {e}"))?;
    Ok(paths::to_string(&path))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCurrentConfig {
    pub config_path: String,
    pub config_exists: bool,
    pub model_provider: Option<String>,
    pub ccapi_base_url: Option<String>,
    pub default_model: Option<String>,
}

/// 读取当前的 ~/.codex/config.toml，告诉前端"Codex 现在指向哪儿"。
#[tauri::command]
pub fn read_codex_config() -> Result<CodexCurrentConfig, String> {
    let dir = match codex_dir() {
        Ok(d) => d,
        Err(_) => {
            return Ok(CodexCurrentConfig {
                config_path: "~/.codex/config.toml".into(),
                config_exists: false,
                model_provider: None,
                ccapi_base_url: None,
                default_model: None,
            })
        }
    };
    let path = dir.join("config.toml");
    let exists = path.exists();
    if !exists {
        return Ok(CodexCurrentConfig {
            config_path: paths::to_string(&path),
            config_exists: false,
            model_provider: None,
            ccapi_base_url: None,
            default_model: None,
        });
    }
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let doc: DocumentMut = raw.parse().unwrap_or_else(|_| DocumentMut::new());
    let model_provider = doc
        .get("model_provider")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let default_model = doc
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let ccapi_base_url = doc
        .get("model_providers")
        .and_then(|v| v.as_table_like())
        .and_then(|t| t.get(PROVIDER_KEY))
        .and_then(|v| v.as_table_like())
        .and_then(|t| t.get("base_url"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(CodexCurrentConfig {
        config_path: paths::to_string(&path),
        config_exists: true,
        model_provider,
        ccapi_base_url,
        default_model,
    })
}

/// 把 base_url + token 配置进 Codex CLI。
/// `model` 是默认要用的模型名（如 "claude-3-5-sonnet-20241022"）。
#[tauri::command]
pub fn configure_codex(
    base_url: String,
    token: String,
    model: Option<String>,
) -> Result<CodexConfigReport, String> {
    if base_url.trim().is_empty() {
        return Err("base_url 不能为空".into());
    }
    if token.trim().is_empty() {
        return Err("token 不能为空".into());
    }
    let model = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("gpt-4o")
        .to_string();
    let (config_path, created_provider, had_existing) =
        write_config_toml(base_url.trim_end_matches('/'), &model)?;
    let auth_path = write_auth_json(&token)?;
    Ok(CodexConfigReport {
        config_path,
        auth_path,
        created_provider,
        had_existing_config: had_existing,
    })
}
