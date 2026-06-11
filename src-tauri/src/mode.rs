use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// `<app_data>/mode.json` — stores which mode the user picked at startup.
fn mode_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    Ok(dir.join("mode.json"))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModeState {
    /// `null` -> 未选择；`"server"` 或 `"client"`
    pub mode: Option<String>,
    /// 客户端模式下连接的服务端 URL
    pub server_url: Option<String>,
}

impl Default for ModeState {
    fn default() -> Self {
        Self {
            mode: None,
            server_url: None,
        }
    }
}

#[tauri::command]
pub fn get_mode(app: AppHandle) -> Result<ModeState, String> {
    let path = mode_file(&app)?;
    if !path.exists() {
        return Ok(ModeState::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取模式文件失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析模式文件失败: {e}"))
}

#[tauri::command]
pub fn set_mode(app: AppHandle, state: ModeState) -> Result<(), String> {
    let path = mode_file(&app)?;
    let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入模式文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存模式文件失败: {e}"))?;
    Ok(())
}
