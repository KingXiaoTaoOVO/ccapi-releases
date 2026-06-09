use std::fs;

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
