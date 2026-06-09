use std::path::PathBuf;

/// `~`
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `~/.claude`
pub fn claude_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".claude"))
}

/// `~/.claude/settings.json` — the file Claude Code reads on startup.
pub fn settings_path() -> Option<PathBuf> {
    claude_dir().map(|d| d.join("settings.json"))
}

/// `~/.claude.json` — legacy / auxiliary config some versions keep.
pub fn legacy_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".claude.json"))
}

/// Best-effort string form of a path (lossy on non-UTF8 paths).
pub fn to_string(p: &PathBuf) -> String {
    p.to_string_lossy().to_string()
}
