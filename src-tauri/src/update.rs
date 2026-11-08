//! Application updates.
//!
//! The official plugin reads `latest.json` on the latest GitHub release,
//! downloads the platform's package and checks its signature with the public
//! key of `tauri.conf.json` before installing it: a tampered file, or one
//! signed by someone else, is refused.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Update found by the last check, awaiting installation.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize, Clone)]
pub struct Available {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    /// False for a package the app cannot replace itself (Linux outside
    /// AppImage): the UI then points to GitHub.
    pub installable: bool,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Installed version.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The system, as a bug report needs it: "macOS 26.0 (arm64)".
#[tauri::command]
pub fn system_name() -> String {
    let arch = std::env::consts::ARCH;
    format!("{} ({arch})", os_version())
}

#[cfg(target_os = "macos")]
fn os_version() -> String {
    let v = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    format!("macOS {v}").trim().to_string()
}

#[cfg(target_os = "linux")]
fn os_version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string())))
        .unwrap_or_else(|| "Linux".into())
}

#[cfg(windows)]
fn os_version() -> String {
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "ver"]);
    crate::util::no_window(&mut cmd);
    cmd.output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Windows".into())
}

/// Queries GitHub; `None` when the app is up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<Available>, String> {
    // `cargo tauri dev`: the local version is always "behind" the releases,
    // and there is no installed package to replace.
    if cfg!(debug_assertions) {
        return Err(crate::t!("err.update_dev"));
    }
    let update = app.updater().map_err(crate::util::ui_err)?.check().await.map_err(crate::util::ui_err)?;
    let out = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        installable: installable(),
    });
    *pending.0.lock().unwrap() = update;
    Ok(out)
}

/// Downloads, checks and installs the update found, then restarts the app.
/// Progress goes to the UI (`update-progress`).
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or_else(|| crate::t!("err.update_none"))?;
    let emitter = app.clone();
    let mut done = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = emitter.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(crate::util::ui_err)?;
    app.restart()
}

/// On Linux only an AppImage can replace itself; its path is given by the
/// launcher in `APPIMAGE`.
fn installable() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}
