use std::path::PathBuf;

use crate::models::{ClaudeEnvInfo, PackageManager};
use crate::paths;
use crate::sys;

/// Candidate locations for the `claude` executable, tagged with the install
/// method they imply. The first one that exists wins.
fn candidate_binaries() -> Vec<(PathBuf, &'static str)> {
    let mut v: Vec<(PathBuf, &'static str)> = Vec::new();
    let exe = |name: &str| {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    };
    let cmd_shim = |name: &str| {
        if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        }
    };

    if let Some(h) = paths::home_dir() {
        v.push((h.join(".bun/bin").join(exe("claude")), "bun"));
        v.push((h.join(".claude/local").join(exe("claude")), "native"));
        v.push((h.join(".claude/local").join(cmd_shim("claude")), "native"));
        v.push((h.join(".local/bin").join(exe("claude")), "native"));
        v.push((h.join(".npm-global/bin").join(cmd_shim("claude")), "npm"));
    }

    if cfg!(windows) {
        // npm global bin lives in %APPDATA%\npm
        if let Some(roaming) = dirs::config_dir() {
            v.push((roaming.join("npm").join("claude.cmd"), "npm"));
        }
        if let Some(local) = dirs::data_local_dir() {
            v.push((
                local.join("Programs").join("claude").join("claude.exe"),
                "native",
            ));
        }
    } else {
        v.push((PathBuf::from("/usr/local/bin/claude"), "npm"));
        v.push((PathBuf::from("/usr/bin/claude"), "system"));
        v.push((PathBuf::from("/opt/homebrew/bin/claude"), "brew"));
    }

    v
}

fn detect_package_managers() -> Vec<PackageManager> {
    ["npm", "pnpm", "bun", "yarn"]
        .iter()
        .map(|name| {
            let version = sys::try_version(name);
            PackageManager {
                name: name.to_string(),
                available: version.is_some(),
                version,
            }
        })
        .collect()
}

/// Detect whether Claude Code is installed and surface everything the UI needs
/// to decide between the "guided install" and "already configured" flows.
#[tauri::command]
pub fn detect_claude() -> ClaudeEnvInfo {
    let mut checked_paths: Vec<String> = Vec::new();

    // 1. Try resolving `claude` on PATH (covers shims we don't hard-code).
    let version = sys::try_version("claude");

    // 2. Locate the binary among well-known install locations.
    let mut binary_path: Option<String> = None;
    let mut install_method: Option<String> = None;
    for (path, method) in candidate_binaries() {
        checked_paths.push(paths::to_string(&path));
        if path.exists() {
            binary_path = Some(paths::to_string(&path));
            install_method = Some(method.to_string());
            break;
        }
    }

    if version.is_some() && install_method.is_none() {
        install_method = Some("unknown".to_string());
    }

    // 3. Inspect the config directory & files.
    let config_dir = paths::claude_dir();
    let config_dir_exists = config_dir.as_ref().map(|p| p.exists()).unwrap_or(false);
    let settings = paths::settings_path();
    let settings_exists = settings.as_ref().map(|p| p.exists()).unwrap_or(false);
    let legacy = paths::legacy_config_path();
    let legacy_exists = legacy.as_ref().map(|p| p.exists()).unwrap_or(false);

    let installed = version.is_some() || binary_path.is_some();

    ClaudeEnvInfo {
        installed,
        version,
        binary_path,
        install_method,
        config_dir: config_dir.as_ref().map(paths::to_string).unwrap_or_default(),
        config_dir_exists,
        settings_path: settings.as_ref().map(paths::to_string).unwrap_or_default(),
        settings_exists,
        legacy_config_path: legacy.as_ref().map(paths::to_string).unwrap_or_default(),
        legacy_config_exists: legacy_exists,
        package_managers: detect_package_managers(),
        checked_paths,
    }
}
