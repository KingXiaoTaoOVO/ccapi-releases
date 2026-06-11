//! 用户头像本地存储：所有头像存在 `<app_data>/avatars/<user_id>.<ext>`，不入数据库。
//! 前端通过 `save_user_avatar` 写入、`read_user_avatar` 读回（作为 data URL）。

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const ALLOWED_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];

fn avatars_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("avatars");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建头像目录: {e}"))?;
    Ok(dir)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// 保存头像。`bytes` 是原始二进制（前端从 canvas 输出的 PNG/JPEG）。
/// 同一 user_id 的旧头像会先被删除，保证不会留下不同扩展名的孤儿文件。
#[tauri::command]
pub fn save_user_avatar(
    app: AppHandle,
    user_id: i64,
    mime: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "头像太大（{} 字节），上限 {} MB",
            bytes.len(),
            MAX_BYTES / 1024 / 1024
        ));
    }
    let ext = ext_for_mime(&mime).ok_or_else(|| format!("不支持的 MIME 类型: {mime}"))?;
    let dir = avatars_dir(&app)?;

    // 清理可能存在的旧版本（不同扩展名）
    for e in ALLOWED_EXTS {
        let p = dir.join(format!("{user_id}.{e}"));
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
    }

    let path = dir.join(format!("{user_id}.{ext}"));
    fs::write(&path, &bytes).map_err(|e| format!("写入头像失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取头像并以 data URL 形式返回。找不到返回 `None`。
#[tauri::command]
pub fn read_user_avatar(app: AppHandle, user_id: i64) -> Result<Option<String>, String> {
    let dir = avatars_dir(&app)?;
    for ext in ALLOWED_EXTS {
        let path = dir.join(format!("{user_id}.{ext}"));
        if path.exists() {
            let bytes = fs::read(&path).map_err(|e| format!("读取头像失败: {e}"))?;
            let mime = mime_for_ext(ext);
            let b64 = base64_encode(&bytes);
            return Ok(Some(format!("data:{mime};base64,{b64}")));
        }
    }
    Ok(None)
}

/// 删除用户的所有本地头像。
#[tauri::command]
pub fn delete_user_avatar(app: AppHandle, user_id: i64) -> Result<(), String> {
    let dir = avatars_dir(&app)?;
    for ext in ALLOWED_EXTS {
        let path = dir.join(format!("{user_id}.{ext}"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除头像失败: {e}"))?;
        }
    }
    Ok(())
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
