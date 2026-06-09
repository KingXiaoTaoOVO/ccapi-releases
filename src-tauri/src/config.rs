use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::models::{BackupEntry, ClaudeConfig};
use crate::paths;

const AUTH_TOKEN_FIELD: &str = "ANTHROPIC_AUTH_TOKEN";
const API_KEY_FIELD: &str = "ANTHROPIC_API_KEY";
const BASE_URL_FIELD: &str = "ANTHROPIC_BASE_URL";

/// `<app_data>/backups`
fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建备份目录: {e}"))?;
    Ok(dir)
}

fn read_json(path: &PathBuf) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取配置失败: {e}"))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("配置文件不是合法 JSON: {e}"))
}

/// Read `~/.claude/settings.json` and extract the active key / base URL.
#[tauri::command]
pub fn read_claude_config() -> Result<ClaudeConfig, String> {
    let path = paths::settings_path().ok_or("无法定位用户主目录")?;
    let exists = path.exists();

    if !exists {
        return Ok(ClaudeConfig {
            settings_path: paths::to_string(&path),
            exists: false,
            raw: String::new(),
            current_key: None,
            current_base_url: None,
            current_auth_field: None,
        });
    }

    let raw = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    let env = parsed.get("env").and_then(|e| e.as_object());

    let (current_key, current_auth_field) = match env {
        Some(env) => {
            if let Some(v) = env.get(AUTH_TOKEN_FIELD).and_then(|v| v.as_str()) {
                (Some(v.to_string()), Some(AUTH_TOKEN_FIELD.to_string()))
            } else if let Some(v) = env.get(API_KEY_FIELD).and_then(|v| v.as_str()) {
                (Some(v.to_string()), Some(API_KEY_FIELD.to_string()))
            } else {
                (None, None)
            }
        }
        None => (None, None),
    };

    let current_base_url = env
        .and_then(|e| e.get(BASE_URL_FIELD))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(ClaudeConfig {
        settings_path: paths::to_string(&path),
        exists: true,
        raw,
        current_key,
        current_base_url,
        current_auth_field,
    })
}

/// Core writer: merge a credential (and optional base URL) into the `env` block
/// of `~/.claude/settings.json`, preserving every other setting. No backup.
pub fn write_env_credential(
    key: &str,
    base_url: Option<&str>,
    auth_field: Option<&str>,
) -> Result<String, String> {
    let path = paths::settings_path().ok_or("无法定位用户主目录")?;
    let field = match auth_field {
        Some(API_KEY_FIELD) => API_KEY_FIELD,
        _ => AUTH_TOKEN_FIELD,
    };
    let other_field = if field == AUTH_TOKEN_FIELD {
        API_KEY_FIELD
    } else {
        AUTH_TOKEN_FIELD
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录: {e}"))?;
    }

    let mut root = if path.exists() {
        read_json(&path)?
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();

    let env_entry = obj.entry("env").or_insert_with(|| json!({}));
    if !env_entry.is_object() {
        *env_entry = json!({});
    }
    let env = env_entry.as_object_mut().unwrap();

    env.insert(field.to_string(), json!(key));
    // Avoid ambiguity between the two auth styles for the same endpoint.
    env.remove(other_field);

    match base_url {
        Some(url) if !url.trim().is_empty() => {
            env.insert(BASE_URL_FIELD.to_string(), json!(url.trim()));
        }
        _ => {}
    }

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, pretty).map_err(|e| format!("写入配置失败: {e}"))?;

    Ok(paths::to_string(&path))
}

/// Write `key` (and optional base URL) into `~/.claude/settings.json`, taking a
/// timestamped backup first. Preserves every other setting untouched.
#[tauri::command]
pub fn apply_key_to_config(
    app: AppHandle,
    key: String,
    base_url: Option<String>,
    auth_field: Option<String>,
    backup: bool,
) -> Result<String, String> {
    let path = paths::settings_path().ok_or("无法定位用户主目录")?;
    if backup && path.exists() {
        backup_to_dir(&app, &path)?;
    }
    write_env_credential(&key, base_url.as_deref(), auth_field.as_deref())
}

/// Point Claude Code at the local proxy. Always writes the proxy URL +
/// proxy token (Bearer) into `~/.claude/settings.json`, never the real
/// third-party credential.
#[tauri::command]
pub fn migrate_to_proxy(
    app: AppHandle,
    port: u16,
    token: String,
    backup: bool,
) -> Result<String, String> {
    let path = paths::settings_path().ok_or("无法定位用户主目录")?;
    if backup && path.exists() {
        backup_to_dir(&app, &path)?;
    }
    let url = format!("http://127.0.0.1:{port}");
    write_env_credential(&token, Some(&url), Some(AUTH_TOKEN_FIELD))
}

/// Keep the most recent N backup files, deleting older ones — otherwise the
/// directory grows unbounded as the user (or the auto-backup-before-write
/// path) keeps creating new files.
const MAX_BACKUPS: usize = 20;

fn prune_backups(dir: &PathBuf) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((p, mtime))
        })
        .collect();
    if entries.len() <= MAX_BACKUPS {
        return;
    }
    // Newest first; everything past MAX_BACKUPS is deleted.
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in entries.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_file(path);
    }
}

fn backup_to_dir(app: &AppHandle, settings: &PathBuf) -> Result<String, String> {
    let dir = backups_dir(app)?;
    // Use the file's own modified time to derive a stable, sortable name.
    let stamp = file_stamp(settings);
    let target = dir.join(format!("settings-{stamp}.json"));
    fs::copy(settings, &target).map_err(|e| format!("备份失败: {e}"))?;
    prune_backups(&dir);
    Ok(paths::to_string(&target))
}

/// Derive a sortable timestamp string from a file's modified time.
fn file_stamp(path: &PathBuf) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Fall back to a monotonic-ish unique suffix when metadata is unavailable.
    if secs == 0 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        now.to_string()
    } else {
        secs.to_string()
    }
}

/// Explicitly back up the current settings file.
#[tauri::command]
pub fn backup_config(app: AppHandle) -> Result<String, String> {
    let path = paths::settings_path().ok_or("无法定位用户主目录")?;
    if !path.exists() {
        return Err("配置文件不存在，无需备份".to_string());
    }
    backup_to_dir(&app, &path)
}

/// List previously created backups, newest first.
#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupEntry>, String> {
    let dir = backups_dir(&app)?;
    let mut entries: Vec<BackupEntry> = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let created_at = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                let dt = chrono::DateTime::<chrono::Local>::from(
                    std::time::UNIX_EPOCH + std::time::Duration::from_secs(d.as_secs()),
                );
                dt.to_rfc3339()
            })
            .unwrap_or_default();

        entries.push(BackupEntry {
            file_name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: paths::to_string(&path),
            created_at,
            size,
        });
    }

    entries.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(entries)
}

/// Restore a previously created backup back onto the live settings file.
#[tauri::command]
pub fn restore_config(app: AppHandle, file_name: String) -> Result<String, String> {
    let dir = backups_dir(&app)?;
    let source = dir.join(&file_name);
    if !source.exists() {
        return Err("备份文件不存在".to_string());
    }
    let target = paths::settings_path().ok_or("无法定位用户主目录")?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录: {e}"))?;
    }
    // Safety net: back up the current file before overwriting it.
    if target.exists() {
        let _ = backup_to_dir(&app, &target);
    }
    fs::copy(&source, &target).map_err(|e| format!("恢复失败: {e}"))?;
    Ok(paths::to_string(&target))
}
