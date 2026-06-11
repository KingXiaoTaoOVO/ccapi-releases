use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use chrono::Local;
use tauri::AppHandle;
use tauri::Emitter;

use crate::models::{InstallLog, UninstallOptions, UninstallReport, UninstallStep};
use crate::paths;
use crate::sys;

const PACKAGE_NAME: &str = "@anthropic-ai/claude-code";
/// Package managers we know how to uninstall the global package through.
/// Each tuple is `(binary, uninstall-args-without-pkg-name)` so we can iterate
/// uniformly. The package name is appended at call-time.
const UNINSTALL_VECTORS: &[(&str, &[&str])] = &[
    ("npm", &["uninstall", "-g"]),
    ("pnpm", &["remove", "-g"]),
    ("bun", &["remove", "-g"]),
    ("yarn", &["global", "remove"]),
];

/// Stream a single line into the UI's install-log feed so the user sees
/// progress in real time. Re-uses the existing event channel that
/// `installer.rs` already drives — frontends listening for install logs
/// pick uninstall output up for free.
fn log(app: &AppHandle, stream: &str, message: impl Into<String>) {
    let _ = app.emit(
        "install://log",
        InstallLog {
            stream: stream.to_string(),
            line: message.into(),
        },
    );
}

/// `du -s` equivalent — walks a directory and sums file sizes. Errors are
/// silently ignored so a single unreadable file doesn't poison the total.
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(path) else {
        if let Ok(meta) = fs::metadata(path) {
            return meta.len();
        }
        return 0;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = fs::metadata(&p) {
            if meta.is_dir() {
                total = total.saturating_add(dir_size(&p));
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn try_size(p: &Path) -> u64 {
    if p.is_dir() {
        dir_size(p)
    } else {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }
}

/// Best-effort recursive remove. Captures the error message so we can surface
/// it instead of panicking — partial failure is acceptable, the UI shows what
/// did and didn't work.
fn remove_path(p: &Path) -> Result<(), String> {
    let res = if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    };
    res.map_err(|e| format!("{e}"))
}

/// ZIP one directory (with stored compression, deflate is overkill for a
/// safety backup) so users can recover after `remove_config_dir` is a mistake.
/// Returns the absolute path of the created archive.
fn zip_directory(src: &Path, dst: &Path) -> Result<(), String> {
    let file = fs::File::create(dst).map_err(|e| format!("无法创建备份文件: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    fn walk(
        zip: &mut zip::ZipWriter<fs::File>,
        opts: &zip::write::FileOptions<'_, ()>,
        root: &Path,
        cur: &Path,
    ) -> Result<(), String> {
        let entries = fs::read_dir(cur).map_err(|e| format!("读取目录失败 {cur:?}: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let name = rel.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                zip.add_directory(&name, *opts)
                    .map_err(|e| format!("写入目录条目失败: {e}"))?;
                walk(zip, opts, root, &path)?;
            } else {
                zip.start_file(&name, *opts)
                    .map_err(|e| format!("写入文件条目失败: {e}"))?;
                let mut f =
                    fs::File::open(&path).map_err(|e| format!("打开文件失败 {path:?}: {e}"))?;
                let mut buf = Vec::with_capacity(8192);
                f.read_to_end(&mut buf)
                    .map_err(|e| format!("读取文件失败 {path:?}: {e}"))?;
                zip.write_all(&buf)
                    .map_err(|e| format!("写入压缩流失败: {e}"))?;
            }
        }
        Ok(())
    }

    walk(&mut zip, &opts, src, src)?;
    zip.finish().map_err(|e| format!("收尾备份失败: {e}"))?;
    Ok(())
}

/// Runs `pm uninstall -g @anthropic-ai/claude-code` for every detected
/// package manager. Each invocation is hidden (no console flash on Windows).
fn uninstall_global_package(app: &AppHandle) -> Vec<UninstallStep> {
    let mut steps = Vec::new();
    for (pm, base_args) in UNINSTALL_VECTORS {
        if sys::try_version(pm).is_none() {
            steps.push(UninstallStep {
                target: format!("{pm} global"),
                action: format!("{pm} {} {PACKAGE_NAME}", base_args.join(" ")),
                status: "skipped".into(),
                detail: Some(format!("未检测到 {pm}")),
            });
            continue;
        }
        let mut args: Vec<&str> = base_args.to_vec();
        args.push(PACKAGE_NAME);
        log(app, "system", format!("$ {pm} {}", args.join(" ")));

        let mut cmd = sys::shell_command(pm, &args);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let out = cmd.output();

        let step = match out {
            Ok(o) if o.status.success() => {
                log(app, "stdout", String::from_utf8_lossy(&o.stdout).into_owned());
                UninstallStep {
                    target: format!("{pm} global"),
                    action: format!("{pm} {} {PACKAGE_NAME}", base_args.join(" ")),
                    status: "ok".into(),
                    detail: None,
                }
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
                log(app, "stderr", stderr.clone());
                UninstallStep {
                    target: format!("{pm} global"),
                    action: format!("{pm} {} {PACKAGE_NAME}", base_args.join(" ")),
                    status: "failed".into(),
                    detail: Some(format!("exit {:?}: {stderr}", o.status.code())),
                }
            }
            Err(e) => UninstallStep {
                target: format!("{pm} global"),
                action: format!("{pm} {} {PACKAGE_NAME}", base_args.join(" ")),
                status: "failed".into(),
                detail: Some(format!("无法启动: {e}")),
            },
        };
        steps.push(step);
    }
    steps
}

/// Build a backup file path next to the user's home directory under
/// `claude-uninstall-backup-<timestamp>.zip`.
fn backup_target() -> Option<PathBuf> {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    paths::home_dir().map(|h| h.join(format!("claude-uninstall-backup-{stamp}.zip")))
}

// ============================================================================
// Process killing
// ============================================================================

/// Kill any running `claude` / `claude-code` processes. On Windows uses
/// `taskkill /F /IM`, elsewhere uses `pkill -f`. Silent if nothing to kill.
fn kill_claude_processes(app: &AppHandle) -> Vec<UninstallStep> {
    let names = if cfg!(windows) {
        vec!["claude.exe", "claude-code.exe"]
    } else {
        vec!["claude", "claude-code"]
    };
    let mut steps = Vec::new();
    for name in names {
        let action = if cfg!(windows) {
            format!("taskkill /F /T /IM {name}")
        } else {
            format!("pkill -TERM -f {name}")
        };
        log(app, "system", format!("$ {action}"));
        let mut cmd = if cfg!(windows) {
            sys::shell_command("taskkill", &["/F", "/T", "/IM", name])
        } else {
            let mut c = std::process::Command::new("pkill");
            c.args(["-TERM", "-f", name]);
            sys::hidden(&mut c);
            c
        };
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let out = cmd.output();
        let step = match out {
            Ok(o) if o.status.success() => UninstallStep {
                target: name.to_string(),
                action: action.clone(),
                status: "ok".into(),
                detail: None,
            },
            Ok(o) => {
                // "进程没找到" 是常见的非错误返回（taskkill 128 / pkill 1）
                let code = o.status.code().unwrap_or(-1);
                let known_noop_codes = if cfg!(windows) {
                    &[128, 1][..]
                } else {
                    &[1][..]
                };
                let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
                if known_noop_codes.contains(&code) {
                    UninstallStep {
                        target: name.to_string(),
                        action,
                        status: "skipped".into(),
                        detail: Some("未发现运行中的进程".into()),
                    }
                } else {
                    UninstallStep {
                        target: name.to_string(),
                        action,
                        status: "failed".into(),
                        detail: Some(format!("exit {code}: {stderr}")),
                    }
                }
            }
            Err(e) => UninstallStep {
                target: name.to_string(),
                action,
                status: "failed".into(),
                detail: Some(format!("无法启动: {e}")),
            },
        };
        steps.push(step);
    }
    steps
}

// ============================================================================
// Windows registry cleanup
// ============================================================================

#[cfg(windows)]
fn run_reg_delete(key: &str) -> std::io::Result<std::process::Output> {
    let mut cmd = sys::shell_command("reg", &["delete", key, "/f"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.output()
}

#[cfg(windows)]
fn clean_registry(app: &AppHandle) -> Vec<UninstallStep> {
    // 已知会被官方/包管理器写入的注册表项。删除时容错：找不到（exit 1）算 skipped。
    let candidate_keys = [
        // Anthropic 原生安装器
        r"HKCU\Software\Anthropic\Claude",
        r"HKCU\Software\Anthropic",
        // 标准卸载入口（Programs and Features / 添加删除程序）
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Claude",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeCode",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\@anthropic-ai/claude-code",
        // App Paths（PATH 之外的 explorer 启动入口）
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\claude.exe",
    ];
    let mut steps = Vec::new();
    for key in candidate_keys {
        let action = format!("reg delete {key} /f");
        log(app, "system", format!("$ {action}"));
        match run_reg_delete(key) {
            Ok(o) if o.status.success() => steps.push(UninstallStep {
                target: key.to_string(),
                action,
                status: "ok".into(),
                detail: None,
            }),
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
                // reg delete 找不到 key → ERROR_FILE_NOT_FOUND (2) / exit 1。
                if o.status.code() == Some(1) {
                    steps.push(UninstallStep {
                        target: key.to_string(),
                        action,
                        status: "skipped".into(),
                        detail: Some("注册表项不存在".into()),
                    });
                } else {
                    steps.push(UninstallStep {
                        target: key.to_string(),
                        action,
                        status: "failed".into(),
                        detail: Some(format!("exit {:?}: {stderr}", o.status.code())),
                    });
                }
            }
            Err(e) => steps.push(UninstallStep {
                target: key.to_string(),
                action,
                status: "failed".into(),
                detail: Some(format!("无法启动 reg: {e}")),
            }),
        }
    }
    steps
}

#[cfg(not(windows))]
fn clean_registry(_app: &AppHandle) -> Vec<UninstallStep> {
    vec![UninstallStep {
        target: "registry".into(),
        action: "clean_registry".into(),
        status: "skipped".into(),
        detail: Some("仅 Windows 支持".into()),
    }]
}

// ============================================================================
// Windows PATH cleanup
// ============================================================================

#[cfg(windows)]
fn read_user_path() -> Option<String> {
    let mut cmd = sys::shell_command("reg", &["query", r"HKCU\Environment", "/v", "Path"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // 输出形如：    Path    REG_EXPAND_SZ    C:\...;C:\...
    for line in text.lines() {
        if let Some(idx) = line.find("REG_") {
            let rest = &line[idx..];
            if let Some(sp) = rest.find(' ') {
                let val = rest[sp..].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            } else if let Some(tab) = rest.find('\t') {
                let val = rest[tab..].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn write_user_path(new_value: &str) -> Result<(), String> {
    // 用 REG_EXPAND_SZ 以保留 %USERPROFILE% 等环境变量引用
    let mut cmd = sys::shell_command(
        "reg",
        &[
            "add",
            r"HKCU\Environment",
            "/v",
            "Path",
            "/t",
            "REG_EXPAND_SZ",
            "/d",
            new_value,
            "/f",
        ],
    );
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("无法启动 reg: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "reg add 失败 exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn clean_path_env(app: &AppHandle) -> Vec<UninstallStep> {
    let mut steps = Vec::new();
    let Some(current) = read_user_path() else {
        steps.push(UninstallStep {
            target: r"HKCU\Environment\Path".into(),
            action: "scan".into(),
            status: "skipped".into(),
            detail: Some("未找到用户 PATH 或读取失败".into()),
        });
        return steps;
    };

    // 匹配规则：路径段（用 ; 分隔）里包含 "claude" 子串、或 .bun\bin / .claude\local
    // 都视作 Claude Code 相关。比较时大小写不敏感。
    let segments: Vec<&str> = current.split(';').collect();
    let lower_needles = [".claude", "claude-code", "anthropic\\claude", ".bun\\bin"];
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for seg in &segments {
        let s = seg.trim();
        if s.is_empty() {
            continue;
        }
        let lower = s.to_ascii_lowercase().replace('/', "\\");
        let hit = lower_needles.iter().any(|n| lower.contains(n));
        if hit {
            dropped.push(s.to_string());
        } else {
            kept.push(s.to_string());
        }
    }

    if dropped.is_empty() {
        steps.push(UninstallStep {
            target: r"HKCU\Environment\Path".into(),
            action: "scan".into(),
            status: "skipped".into(),
            detail: Some("PATH 中未发现 Claude 相关条目".into()),
        });
        return steps;
    }

    let new_value = kept.join(";");
    log(
        app,
        "system",
        format!("从 PATH 中移除 {} 个条目: {}", dropped.len(), dropped.join(" | ")),
    );
    match write_user_path(&new_value) {
        Ok(()) => steps.push(UninstallStep {
            target: r"HKCU\Environment\Path".into(),
            action: format!("remove {} entries", dropped.len()),
            status: "ok".into(),
            detail: Some(dropped.join(" | ")),
        }),
        Err(e) => steps.push(UninstallStep {
            target: r"HKCU\Environment\Path".into(),
            action: format!("remove {} entries", dropped.len()),
            status: "failed".into(),
            detail: Some(e),
        }),
    }
    steps
}

#[cfg(not(windows))]
fn clean_path_env(_app: &AppHandle) -> Vec<UninstallStep> {
    vec![UninstallStep {
        target: "PATH".into(),
        action: "clean_path_env".into(),
        status: "skipped".into(),
        detail: Some("仅 Windows 支持".into()),
    }]
}

// ============================================================================
// Recycle bin
// ============================================================================

#[cfg(windows)]
fn empty_recycle_bin(app: &AppHandle) -> UninstallStep {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
    };

    log(app, "system", "$ SHEmptyRecycleBinW(NOCONFIRM|NOPROGRESS|NOSOUND)");
    let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
    match unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), flags) } {
        Ok(()) => UninstallStep {
            target: "回收站".into(),
            action: "SHEmptyRecycleBinW".into(),
            status: "ok".into(),
            detail: None,
        },
        Err(e) => {
            // E_FAIL 0x80004005 在回收站已空时也会回；当作 skipped 处理
            let hr = e.code().0 as u32;
            if hr == 0x8000_4005 {
                UninstallStep {
                    target: "回收站".into(),
                    action: "SHEmptyRecycleBinW".into(),
                    status: "skipped".into(),
                    detail: Some("回收站已经是空的".into()),
                }
            } else {
                UninstallStep {
                    target: "回收站".into(),
                    action: "SHEmptyRecycleBinW".into(),
                    status: "failed".into(),
                    detail: Some(format!("HRESULT 0x{hr:08X}: {e}")),
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn empty_recycle_bin(_app: &AppHandle) -> UninstallStep {
    UninstallStep {
        target: "Trash".into(),
        action: "empty_recycle_bin".into(),
        status: "skipped".into(),
        detail: Some("仅 Windows 支持".into()),
    }
}

/// One-shot uninstall command. Returns a structured report instead of
/// printing — the UI renders it.
#[tauri::command]
pub fn uninstall_claude(app: AppHandle, opts: UninstallOptions) -> Result<UninstallReport, String> {
    let mut report = UninstallReport::default();

    log(&app, "system", "开始卸载 Claude Code ...");

    // 0) Kill running processes BEFORE any other step — file deletion and
    //    package uninstall both fail on Windows if claude.exe holds a lock.
    if opts.kill_processes {
        report.steps.extend(kill_claude_processes(&app));
    }

    // 1) Optional safety backup of ~/.claude before anything destructive.
    if opts.backup_first {
        if let Some(dir) = paths::claude_dir() {
            if dir.exists() {
                if let Some(dst) = backup_target() {
                    log(&app, "system", format!("备份 {} → {}", dir.display(), dst.display()));
                    match zip_directory(&dir, &dst) {
                        Ok(()) => {
                            report.backup_path = Some(paths::to_string(&dst));
                            report.steps.push(UninstallStep {
                                target: paths::to_string(&dir),
                                action: "backup".into(),
                                status: "ok".into(),
                                detail: Some(paths::to_string(&dst)),
                            });
                        }
                        Err(e) => {
                            log(&app, "stderr", format!("备份失败: {e}"));
                            report.steps.push(UninstallStep {
                                target: paths::to_string(&dir),
                                action: "backup".into(),
                                status: "failed".into(),
                                detail: Some(e),
                            });
                            // Abort the whole operation — the user asked for a
                            // safety net and we couldn't provide it.
                            report.success = false;
                            return Ok(report);
                        }
                    }
                }
            } else {
                report.steps.push(UninstallStep {
                    target: paths::to_string(&dir),
                    action: "backup".into(),
                    status: "skipped".into(),
                    detail: Some("目录不存在".into()),
                });
            }
        }
    }

    // 2) Global package manager uninstall.
    if opts.remove_global_package {
        report.steps.extend(uninstall_global_package(&app));
    }

    // 3) Native install directory (~/.claude/local).
    if opts.remove_native_install_dir {
        if let Some(dir) = paths::claude_dir().map(|d| d.join("local")) {
            if dir.exists() {
                let size = try_size(&dir);
                log(&app, "system", format!("删除 {} ({} 字节)", dir.display(), size));
                match remove_path(&dir) {
                    Ok(()) => {
                        report.bytes_removed = report.bytes_removed.saturating_add(size);
                        report.steps.push(UninstallStep {
                            target: paths::to_string(&dir),
                            action: "remove".into(),
                            status: "ok".into(),
                            detail: None,
                        });
                    }
                    Err(e) => {
                        report.steps.push(UninstallStep {
                            target: paths::to_string(&dir),
                            action: "remove".into(),
                            status: "failed".into(),
                            detail: Some(e),
                        });
                    }
                }
            } else {
                report.steps.push(UninstallStep {
                    target: paths::to_string(&dir),
                    action: "remove".into(),
                    status: "skipped".into(),
                    detail: Some("目录不存在".into()),
                });
            }
        }
    }

    // 4) Full config directory (~/.claude). Done AFTER local/ so we can
    //    record bytes for sub-dirs that may have already been removed.
    if opts.remove_config_dir {
        if let Some(dir) = paths::claude_dir() {
            if dir.exists() {
                let size = try_size(&dir);
                log(&app, "system", format!("删除 {} ({} 字节)", dir.display(), size));
                match remove_path(&dir) {
                    Ok(()) => {
                        report.bytes_removed = report.bytes_removed.saturating_add(size);
                        report.steps.push(UninstallStep {
                            target: paths::to_string(&dir),
                            action: "remove".into(),
                            status: "ok".into(),
                            detail: None,
                        });
                    }
                    Err(e) => {
                        report.steps.push(UninstallStep {
                            target: paths::to_string(&dir),
                            action: "remove".into(),
                            status: "failed".into(),
                            detail: Some(e),
                        });
                    }
                }
            } else {
                report.steps.push(UninstallStep {
                    target: paths::to_string(&dir),
                    action: "remove".into(),
                    status: "skipped".into(),
                    detail: Some("目录不存在".into()),
                });
            }
        }
    }

    // 5) Legacy ~/.claude.json file.
    if opts.remove_legacy_config {
        if let Some(p) = paths::legacy_config_path() {
            if p.exists() {
                let size = try_size(&p);
                log(&app, "system", format!("删除 {} ({} 字节)", p.display(), size));
                match remove_path(&p) {
                    Ok(()) => {
                        report.bytes_removed = report.bytes_removed.saturating_add(size);
                        report.steps.push(UninstallStep {
                            target: paths::to_string(&p),
                            action: "remove".into(),
                            status: "ok".into(),
                            detail: None,
                        });
                    }
                    Err(e) => {
                        report.steps.push(UninstallStep {
                            target: paths::to_string(&p),
                            action: "remove".into(),
                            status: "failed".into(),
                            detail: Some(e),
                        });
                    }
                }
            } else {
                report.steps.push(UninstallStep {
                    target: paths::to_string(&p),
                    action: "remove".into(),
                    status: "skipped".into(),
                    detail: Some("文件不存在".into()),
                });
            }
        }
    }

    // 6) Registry cleanup (Windows only).
    if opts.clean_registry {
        report.steps.extend(clean_registry(&app));
    }

    // 7) PATH environment variable cleanup (Windows only).
    if opts.clean_path_env {
        report.steps.extend(clean_path_env(&app));
    }

    // 8) Empty recycle bin LAST so it catches anything previous steps put there.
    if opts.empty_recycle_bin {
        report.steps.push(empty_recycle_bin(&app));
    }

    report.success = report.steps.iter().all(|s| s.status != "failed");
    log(
        &app,
        "system",
        format!(
            "卸载完成（{} 步骤，{} 字节）",
            report.steps.len(),
            report.bytes_removed,
        ),
    );
    Ok(report)
}
