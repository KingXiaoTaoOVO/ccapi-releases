use std::fs;
use std::path::PathBuf;

/// Read a UTF-8 text file selected via the dialog plugin. Used by the batch
/// importer to load .txt / .csv / .json files chosen by the user.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024; // 8 MB safety cap for import files.

    let meta = fs::metadata(&path).map_err(|e| format!("无法访问文件: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err("文件过大（超过 8MB），请拆分后再导入".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}

/// 把 base64 编码的字节内容保存到指定路径。前端用 dialog plugin 拿到 path
/// 后调用本命令落盘 —— 比 `<a download>` 在 Tauri webview 里更可靠。
#[tauri::command]
pub fn save_bytes_to_file(path: String, content_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    fs::write(&p, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path)
}
