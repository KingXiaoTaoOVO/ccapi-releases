use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::models::{InstallDone, InstallLog};
use crate::sys;

/// Holds the PID of the in-flight install so `cancel_install` can stop it.
#[derive(Default)]
pub struct InstallState {
    pub pid: Arc<Mutex<Option<u32>>>,
}

/// Map a method id to the actual command line that performs the install.
fn install_command(method: &str) -> Result<Command, String> {
    let pkg = "@anthropic-ai/claude-code";
    let cmd = match method {
        "npm" => sys::shell_command("npm", &["install", "-g", pkg]),
        "pnpm" => sys::shell_command("pnpm", &["add", "-g", pkg]),
        "bun" => sys::shell_command("bun", &["add", "-g", pkg]),
        "yarn" => sys::shell_command("yarn", &["global", "add", pkg]),
        "native" => {
            if cfg!(windows) {
                // Official PowerShell installer.
                sys::shell_command(
                    "powershell",
                    &[
                        "-NoProfile",
                        "-Command",
                        "irm https://claude.ai/install.ps1 | iex",
                    ],
                )
            } else {
                let mut c = Command::new("sh");
                c.arg("-c")
                    .arg("curl -fsSL https://claude.ai/install.sh | bash");
                sys::hidden(&mut c);
                c
            }
        }
        other => return Err(format!("未知的安装方式: {other}")),
    };
    Ok(cmd)
}

/// Read a child stream line-by-line and forward each line to the frontend.
fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    reader: R,
    stream: &'static str,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(line) => {
                    let _ = app.emit(
                        "install://log",
                        InstallLog {
                            stream: stream.to_string(),
                            line,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    })
}

/// Kick off an installation. Returns once the child has spawned; progress is
/// streamed via `install://log` events and completion via `install://done`.
#[tauri::command]
pub fn install_claude(
    app: AppHandle,
    state: State<InstallState>,
    method: String,
) -> Result<(), String> {
    // Guard against concurrent installs.
    {
        let guard = state.pid.lock().map_err(|_| "状态锁定失败".to_string())?;
        if guard.is_some() {
            return Err("已有安装任务正在进行中".to_string());
        }
    }

    let mut cmd = install_command(&method)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动安装进程 ({method}): {e}"))?;

    let pid = child.id();
    {
        let mut guard = state.pid.lock().map_err(|_| "状态锁定失败".to_string())?;
        *guard = Some(pid);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid_slot = state.pid.clone();

    let _ = app.emit(
        "install://log",
        InstallLog {
            stream: "system".to_string(),
            line: format!("开始安装 Claude Code (方式: {method}) ..."),
        },
    );

    std::thread::spawn(move || {
        let mut handles = Vec::new();
        if let Some(out) = stdout {
            handles.push(spawn_reader(app.clone(), out, "stdout"));
        }
        if let Some(err) = stderr {
            handles.push(spawn_reader(app.clone(), err, "stderr"));
        }

        let status = child.wait();
        for h in handles {
            let _ = h.join();
        }

        // Clear the active PID.
        if let Ok(mut guard) = pid_slot.lock() {
            *guard = None;
        }

        let (success, code, message) = match status {
            Ok(s) if s.success() => (true, s.code(), "安装完成".to_string()),
            Ok(s) => (
                false,
                s.code(),
                format!("安装失败，退出码: {:?}", s.code()),
            ),
            Err(e) => (false, None, format!("安装进程异常: {e}")),
        };

        let _ = app.emit("install://done", InstallDone { success, code, message });
    });

    Ok(())
}

/// Auto-pick the best available package manager and install Claude Code.
/// Preference order: bun > pnpm > npm > yarn > native (PowerShell / shell).
/// The `native` fallback uses Anthropic's official installer script and works
/// even on machines with no package manager.
///
/// Returns the chosen install method id (matches `install_command`). The
/// caller still gets `install://log` + `install://done` events as usual.
#[tauri::command]
pub fn install_claude_smart(
    app: AppHandle,
    state: State<InstallState>,
) -> Result<String, String> {
    // Preference order: bun > pnpm > npm > yarn (then native fallback).
    let preferred = ["bun", "pnpm", "npm", "yarn"];
    let mut method: Option<&str> = None;
    for pm in preferred {
        if sys::try_version(pm).is_some() {
            method = Some(pm);
            break;
        }
    }
    let method = method.unwrap_or("native");
    install_claude(app, state, method.to_string())?;
    Ok(method.to_string())
}

/// Terminate the running installation, if any.
#[tauri::command]
pub fn cancel_install(state: State<InstallState>) -> Result<(), String> {
    let pid = {
        let guard = state.pid.lock().map_err(|_| "状态锁定失败".to_string())?;
        *guard
    };
    let Some(pid) = pid else {
        return Err("当前没有正在进行的安装任务".to_string());
    };

    let mut cmd = if cfg!(windows) {
        sys::shell_command("taskkill", &["/F", "/T", "/PID", &pid.to_string()])
    } else {
        let mut c = Command::new("kill");
        c.arg("-TERM").arg(pid.to_string());
        sys::hidden(&mut c);
        c
    };
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.status().map_err(|e| format!("无法终止安装进程: {e}"))?;
    Ok(())
}
