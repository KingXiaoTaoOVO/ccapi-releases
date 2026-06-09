use std::process::{Command, Stdio};

/// Windows flag to spawn child processes without flashing a console window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply the no-window flag on Windows; no-op elsewhere.
pub fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Build a command that runs `program args...` through the platform shell so
/// that Windows `.cmd` / `.bat` shims (npm, pnpm, claude, ...) resolve the way
/// a user would expect from a terminal.
pub fn shell_command(program: &str, args: &[&str]) -> Command {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(program).args(args);
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    };
    hidden(&mut cmd);
    cmd
}

/// Run `program --version` and return the trimmed output if it succeeds.
/// Some tools print their version to stderr, so we fall back to that.
pub fn try_version(program: &str) -> Option<String> {
    let mut cmd = shell_command(program, &["--version"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Some(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    (!stderr.is_empty()).then_some(stderr)
}
