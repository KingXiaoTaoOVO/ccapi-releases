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
