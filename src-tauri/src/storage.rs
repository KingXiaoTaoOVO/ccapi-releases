use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// `<app_data>/state.json` — opaque JSON blob owned by the frontend store
/// (the API-key list + app preferences live here).
fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    Ok(dir.join("state.json"))
}

/// Load persisted application state. Returns `None` on first run.
#[tauri::command]
pub fn load_app_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取应用状态失败: {e}"))?;
    Ok(Some(text))
}

/// Persist application state (atomic-ish: write to a temp file then rename).
#[tauri::command]
pub fn save_app_state(app: AppHandle, data: String) -> Result<(), String> {
    let path = state_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("写入应用状态失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存应用状态失败: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub backups_removed: usize,
    pub logs_removed: usize,
    /// Bytes reclaimed (best-effort — counted before deletion).
    pub bytes_reclaimed: u64,
}

/// Wipe the app's caches: all settings backups + any leftover log files. The
/// persisted `state.json` (key list + settings) is **kept** so the user doesn't
/// lose their configured keys on a routine cleanup.
#[tauri::command]
pub fn clear_app_caches(app: AppHandle) -> Result<ClearReport, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;

    let mut report = ClearReport {
        backups_removed: 0,
        logs_removed: 0,
        bytes_reclaimed: 0,
    };

    // 1. backups/*.json
    let backups = root.join("backups");
    if backups.exists() {
        if let Ok(read) = fs::read_dir(&backups) {
            for entry in read.flatten() {
                let p = entry.path();
                if p.extension().and_then(|x| x.to_str()) == Some("json") {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if fs::remove_file(&p).is_ok() {
                        report.backups_removed += 1;
                        report.bytes_reclaimed = report.bytes_reclaimed.saturating_add(size);
                    }
                }
            }
        }
    }

    // 2. *.log files anywhere directly under the app data dir.
    if let Ok(read) = fs::read_dir(&root) {
        for entry in read.flatten() {
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) == Some("log") {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(&p).is_ok() {
                    report.logs_removed += 1;
                    report.bytes_reclaimed = report.bytes_reclaimed.saturating_add(size);
                }
            }
        }
    }

    // 3. Lingering temp file from an interrupted save_app_state.
    let state_tmp = root.join("state.json.tmp");
    if state_tmp.exists() {
        let _ = fs::remove_file(state_tmp);
    }

    Ok(report)
}
