use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, PhysicalPosition, Runtime,
};

/// Bring the main window to the foreground (restoring & focusing it).
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Toggle the main window between shown/focused and hidden.
fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => show_main(app),
        }
    }
}

/// Pop up the custom (HTML/glass) tray menu window anchored to the cursor.
fn show_menu<R: Runtime>(app: &AppHandle<R>, cursor: PhysicalPosition<f64>) {
    let Some(win) = app.get_webview_window("tray-menu") else {
        return;
    };
    // Anchor the menu so its bottom-right corner sits at the cursor (the tray
    // lives at the bottom-right of the screen, so the menu opens up-and-left).
    let size = win
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(240, 320));
    let x = (cursor.x as i32 - size.width as i32).max(0);
    let y = (cursor.y as i32 - size.height as i32).max(0);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.show();
    let _ = win.set_focus();
}

/// Run a tray-menu action. Window/lifecycle actions are handled natively;
/// view/rotation actions are forwarded to the main window via `tray://action`.
pub fn handle_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    // Always dismiss the popup first.
    if let Some(menu) = app.get_webview_window("tray-menu") {
        let _ = menu.hide();
    }
    match action {
        "show" => show_main(app),
        "quit" => app.exit(0),
        "nav:dashboard" | "nav:settings" => {
            show_main(app);
            let _ = app.emit("tray://action", action);
        }
        "rotate" => {
            let _ = app.emit("tray://action", "rotate");
        }
        "checkAll" => {
            let _ = app.emit("tray://action", "checkAll");
        }
        _ => {}
    }
}

/// Command invoked by the custom tray-menu window when an item is clicked.
#[tauri::command]
pub fn tray_action<R: Runtime>(app: AppHandle<R>, action: String) {
    handle_action(&app, &action);
}

/// Build the system tray icon. Left-click toggles the main window; right-click
/// opens the custom glass menu window (built in the frontend).
pub fn setup_tray<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("CCAPI · Claude Code")
        // No native menu — we render our own styled popup window instead.
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let app = tray.app_handle();
                match button {
                    MouseButton::Left => toggle_main(app),
                    MouseButton::Right => show_menu(app, position),
                    _ => {}
                }
            }
        })
        .build(app)?;

    Ok(())
}
