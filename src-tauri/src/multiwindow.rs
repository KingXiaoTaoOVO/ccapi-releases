use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 在新窗口打开客户端模式（仅用于让管理员同机测试客户端体验）。
/// 新窗口的 URL 带 `?window=client` query param —— 前端识别后强制走 client 流程，
/// 不读 mode.json，避免和服务端窗口的模式选择互相覆盖。
#[tauri::command]
pub async fn open_client_window(app: AppHandle) -> Result<(), String> {
    let label = "ccapi-client";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = WebviewUrl::App("index.html?window=client".into());
    let window = WebviewWindowBuilder::new(&app, label, url)
        .title("CCAPI · 客户端")
        .inner_size(1080.0, 760.0)
        .min_inner_size(900.0, 640.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| format!("打开客户端窗口失败: {e}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}
