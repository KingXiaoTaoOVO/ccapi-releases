use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Show a native OS notification (Windows toast / macOS Notification Center /
/// Linux libnotify). Called from the frontend for important events such as an
/// automatic key switch or "all keys unusable". Failures are returned as a
/// string so the UI can fall back to the in-app toast silently.
#[tauri::command]
pub fn notify_system(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("系统通知发送失败: {e}"))
}
