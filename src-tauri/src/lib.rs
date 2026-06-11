mod appid;
mod avatar;
mod codex;
mod config;
mod env_detect;
mod fsio;
mod installer;
mod mode;
mod models;
mod monitor;
mod multiwindow;
mod notify;
mod paths;
mod proxy;
mod quota;
mod server;
mod storage;
mod sys;
mod tray;
mod uninstaller;
mod version;

use std::sync::Arc;

use installer::InstallState;
use tauri::{Manager, WindowEvent};

/// AppUserModelID — must match `tauri.conf.json` `identifier`. Used by Windows
/// to attribute toast notifications (and taskbar grouping) to CCAPI rather than
/// the parent terminal in dev builds.
const APP_USER_MODEL_ID: &str = "com.tauri-app.ccapi";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pin the AppUserModelID before any window/notification is created so the
    // first toast already lands under "CCAPI" instead of "Windows PowerShell".
    appid::set_app_user_model_id(APP_USER_MODEL_ID);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(InstallState::default())
        .manage(Arc::new(server::ServerState::new()))
        .setup(|app| {
            app.manage(Arc::new(proxy::ProxyState::new(app.handle().clone())));
            tray::setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it to the tray instead of quitting,
            // so background monitoring keeps running. Quit via the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            env_detect::detect_claude,
            avatar::save_user_avatar,
            avatar::read_user_avatar,
            avatar::delete_user_avatar,
            installer::install_claude,
            installer::install_claude_smart,
            installer::cancel_install,
            uninstaller::uninstall_claude,
            config::read_claude_config,
            config::apply_key_to_config,
            config::backup_config,
            config::list_backups,
            config::restore_config,
            storage::load_app_state,
            storage::save_app_state,
            fsio::read_text_file,
            fsio::save_bytes_to_file,
            version::get_app_version,
            version::check_github_release,
            monitor::check_key_status,
            quota::query_key_quota,
            notify::notify_system,
            proxy::start_proxy,
            proxy::stop_proxy,
            proxy::proxy_status,
            proxy::proxy_metrics,
            proxy::set_proxy_keys,
            proxy::set_proxy_token,
            proxy::set_proxy_official_mode,
            proxy::check_port_available,
            proxy::set_proxy_active_user,
            proxy::fetch_models_for_key,
            config::migrate_to_proxy,
            codex::configure_codex,
            codex::read_codex_config,
            storage::clear_app_caches,
            tray::tray_action,
            // ---- server mode ----
            mode::get_mode,
            mode::set_mode,
            server::local_config::read_server_local_config,
            server::local_config::write_server_local_config,
            server::local_config::verify_entry_password,
            server::local_config::change_entry_password,
            server::test_mysql_connection,
            server::test_redis_connection,
            server::init_database,
            server::reset_database,
            server::start_admin_server,
            server::stop_admin_server,
            server::admin_server_status,
            server::probe_remote_server,
            multiwindow::open_client_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        // CCAPI always routes through the local proxy, so there's nothing to
        // restore on exit — `~/.claude/settings.json` already points at the
        // proxy address + proxy key, which is invalid once we shut down but
        // never contains a real third-party credential. (Re-launching CCAPI
        // makes Claude Code work again.)
    });
}
