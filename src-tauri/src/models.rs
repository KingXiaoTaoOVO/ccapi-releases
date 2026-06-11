use serde::{Deserialize, Serialize};

/// Result of probing the local machine for a Claude Code installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEnvInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    /// "npm" | "pnpm" | "bun" | "native" | "system" | "brew" | "unknown"
    pub install_method: Option<String>,
    pub config_dir: String,
    pub config_dir_exists: bool,
    pub settings_path: String,
    pub settings_exists: bool,
    pub legacy_config_path: String,
    pub legacy_config_exists: bool,
    pub package_managers: Vec<PackageManager>,
    pub checked_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManager {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
}

/// Snapshot of the relevant pieces of `~/.claude/settings.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeConfig {
    pub settings_path: String,
    pub exists: bool,
    pub raw: String,
    pub current_key: Option<String>,
    pub current_base_url: Option<String>,
    pub current_auth_field: Option<String>,
}

/// Outcome of a live health-check against an API key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheckResult {
    pub ok: bool,
    /// "active" | "cooling" | "invalid" | "exhausted" | "error"
    pub status: String,
    pub http_status: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
    pub retry_after_secs: Option<u64>,
    pub checked_at: String,
}

/// A single backup of the Claude settings file managed by CCAPI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub file_name: String,
    pub path: String,
    pub created_at: String,
    pub size: u64,
}

/// Emitted line-by-line to the frontend while an installation runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallLog {
    pub stream: String,
    pub line: String,
}

/// Emitted once when an installation process finishes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallDone {
    pub success: bool,
    pub code: Option<i32>,
    pub message: String,
}

/// Options for [`uninstall_claude`] — tells the backend which surfaces to wipe.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOptions {
    /// Run `npm/pnpm/bun/yarn uninstall -g @anthropic-ai/claude-code` for every
    /// detected package manager that has the package installed.
    pub remove_global_package: bool,
    /// Delete `~/.claude/local` (the native PowerShell installer's drop point).
    pub remove_native_install_dir: bool,
    /// Delete `~/.claude/` entirely (config, agents/, skills/, projects/, etc.).
    pub remove_config_dir: bool,
    /// Delete the legacy `~/.claude.json` file.
    pub remove_legacy_config: bool,
    /// Take a timestamped tar/zip backup of `~/.claude/` first.
    pub backup_first: bool,
    /// Kill any running `claude` processes before touching files.
    #[serde(default)]
    pub kill_processes: bool,
    /// (Windows) Strip `Uninstall\Claude*` keys + `HKCU\Software\Anthropic\Claude`
    /// from the registry.
    #[serde(default)]
    pub clean_registry: bool,
    /// (Windows) Remove any `claude` / `.bun/bin` / `.claude/local` entries from
    /// the per-user PATH (HKCU\Environment\Path).
    #[serde(default)]
    pub clean_path_env: bool,
    /// Empty the OS recycle bin AFTER all delete operations succeed.
    #[serde(default)]
    pub empty_recycle_bin: bool,
}

/// Per-target outcome returned to the UI so the user can see exactly what
/// happened (and what was skipped because it didn't exist).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UninstallStep {
    pub target: String,
    pub action: String,
    /// "ok" | "skipped" | "failed"
    pub status: String,
    pub detail: Option<String>,
}

/// Aggregated result of a one-shot Claude Code uninstall.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    pub success: bool,
    /// Absolute path of the pre-uninstall backup archive if `backup_first` was set.
    pub backup_path: Option<String>,
    pub steps: Vec<UninstallStep>,
    pub bytes_removed: u64,
}
