// Set the Windows AppUserModelID so toast notifications are attributed to the
// CCAPI app (and show "CCAPI" in the popup header) rather than the host process
// — which in `tauri dev` is the parent PowerShell / cmd.

#[cfg(target_os = "windows")]
pub fn set_app_user_model_id(id: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let h = HSTRING::from(id);
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&h);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_app_user_model_id(_id: &str) {}
