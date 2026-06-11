//! 软件版本号 + GitHub release 比对。
//!
//! `get_app_version()` 来自 Cargo.toml 编译时常量；
//! `check_github_release()` 调用 GitHub API 拉取最新 release，做 semver 简单比对。

use serde::{Deserialize, Serialize};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 默认 GitHub repo（仅 fallback；管理员可在 site_info.updateRepo 改）。
const DEFAULT_REPO: &str = "KingXiaoTaoOVO/ccapi-releases";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub current: String,
    pub latest: Option<String>,
    pub has_update: bool,
    pub release_url: Option<String>,
    pub release_name: Option<String>,
    pub release_body: Option<String>,
    pub published_at: Option<String>,
    /// 如果检查失败，前端展示
    pub error: Option<String>,
}

#[tauri::command]
pub fn get_app_version() -> String {
    APP_VERSION.to_string()
}

#[derive(Deserialize)]
struct GithubReleaseResp {
    tag_name: Option<String>,
    name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[tauri::command]
pub async fn check_github_release(repo: Option<String>) -> VersionInfo {
    // 优先用前端从 server.site_info.updateRepo 拿到的；否则 fallback default
    let repo = repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.contains('/'))
        .unwrap_or(DEFAULT_REPO);
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("CCAPI-update-checker")
        .build()
    {
        Ok(c) => c,
        Err(e) => return err(format!("HTTP client: {e}")),
    };
    let resp = match client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err(format!("请求 GitHub 失败: {e}")),
    };
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        // 仓库存在但还没发布过 release —— 视为"暂无更新"
        return VersionInfo {
            current: APP_VERSION.into(),
            latest: None,
            has_update: false,
            release_url: None,
            release_name: None,
            release_body: None,
            published_at: None,
            error: Some("尚未发布过 Release".into()),
        };
    }
    if !status.is_success() {
        return err(format!("GitHub 返回 HTTP {status}"));
    }
    let parsed: GithubReleaseResp = match resp.json().await {
        Ok(v) => v,
        Err(e) => return err(format!("解析 GitHub 响应失败: {e}")),
    };
    if parsed.draft || parsed.prerelease {
        // 草稿/预发布跳过
        return VersionInfo {
            current: APP_VERSION.into(),
            latest: None,
            has_update: false,
            release_url: None,
            release_name: None,
            release_body: None,
            published_at: None,
            error: None,
        };
    }
    let latest = parsed
        .tag_name
        .as_ref()
        .map(|s| s.trim_start_matches('v').to_string());
    let has_update = match &latest {
        Some(l) => is_newer(l, APP_VERSION),
        None => false,
    };
    VersionInfo {
        current: APP_VERSION.into(),
        latest,
        has_update,
        release_url: parsed.html_url,
        release_name: parsed.name,
        release_body: parsed.body,
        published_at: parsed.published_at,
        error: None,
    }
}

fn err(message: String) -> VersionInfo {
    VersionInfo {
        current: APP_VERSION.into(),
        latest: None,
        has_update: false,
        release_url: None,
        release_name: None,
        release_body: None,
        published_at: None,
        error: Some(message),
    }
}

/// 简单 semver 比较：a > b 时返回 true。不支持 `-beta` 之类的 pre-release tag。
fn is_newer(a: &str, b: &str) -> bool {
    let pa = parse_version(a);
    let pb = parse_version(b);
    pa > pb
}

fn parse_version(s: &str) -> (u32, u32, u32) {
    let cleaned: String = s
        .trim_start_matches('v')
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let parts: Vec<u32> = cleaned
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or(0))
        .collect();
    let major = *parts.first().unwrap_or(&0);
    let minor = *parts.get(1).unwrap_or(&0);
    let patch = *parts.get(2).unwrap_or(&0);
    (major, minor, patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semver() {
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("v1.3.0", "1.2.99"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        assert!(is_newer("2.0.0", "1.99.99"));
    }
}
