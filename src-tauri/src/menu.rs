//! Native menus: pop-up menus requested by the UI.
//!
//! The UI describes the menu (labels, check marks, separators); each entry
//! carries a `verb:argument` id. A single handler, installed at startup, sends
//! the chosen id back to the webview as the `menu` event.

use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, Runtime, Window};

/// An entry described by the UI. Without `id`, it is a separator.
#[derive(Deserialize)]
pub struct Entry {
    id: Option<String>,
    #[serde(default)]
    label: String,
    checked: Option<bool>,
    #[serde(default = "yes")]
    enabled: bool,
    accel: Option<String>,
}

fn yes() -> bool {
    true
}

fn build<R: Runtime>(app: &AppHandle<R>, items: &[Entry]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for e in items {
        match &e.id {
            None => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Some(id) => match e.checked {
                Some(c) => menu.append(&CheckMenuItem::with_id(app, id, &e.label, e.enabled, c, e.accel.as_deref())?)?,
                None => menu.append(&MenuItem::with_id(app, id, &e.label, e.enabled, e.accel.as_deref())?)?,
            },
        }
    }
    Ok(menu)
}

/// Last pop-up menu shown. On Linux display is asynchronous: the menu must
/// outlive the command until the user chooses.
fn last_popup() -> &'static Mutex<Option<Menu<tauri::Wry>>> {
    static LAST: OnceLock<Mutex<Option<Menu<tauri::Wry>>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// Shows a native menu at page coordinates (logical points).
#[tauri::command]
pub fn popup_menu(window: Window, items: Vec<Entry>, x: f64, y: f64) -> Result<(), String> {
    let menu = build(window.app_handle(), &items).map_err(crate::util::ui_err)?;
    window.popup_menu_at(&menu, LogicalPosition::new(x, y)).map_err(crate::util::ui_err)?;
    *last_popup().lock().unwrap() = Some(menu);
    Ok(())
}

/// Single handler: every chosen entry goes to the webview.
pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("menu", id.to_string());
}

/// Application menu bar (macOS). Shortcuts live here, as accelerators, not in
/// the UI's JavaScript. Rebuilt whenever the language changes.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use crate::t;
    use tauri::menu::{AboutMetadata, Submenu};
    let item = |id: &str, key: &str, accel: Option<&str>| MenuItem::with_id(app, id, t!(key), true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let tr = |key: &str| Some(t!(key));

    let about =
        AboutMetadata { name: Some("Snap Studio".into()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    let app_sub = Submenu::with_items(
        app,
        "Snap Studio",
        true,
        &[
            &PredefinedMenuItem::about(app, tr("menu.about").as_deref(), Some(about))?,
            &item("app:update", "menu.update", None)?,
            &sep()?,
            &item("nav:settings", "menu.settings", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, tr("menu.services").as_deref())?,
            &sep()?,
            &PredefinedMenuItem::hide(app, tr("menu.hide").as_deref())?,
            &PredefinedMenuItem::hide_others(app, tr("menu.hide_others").as_deref())?,
            &PredefinedMenuItem::show_all(app, tr("menu.show_all").as_deref())?,
            &sep()?,
            &PredefinedMenuItem::quit(app, tr("menu.quit").as_deref())?,
        ],
    )?;
    let file_sub = Submenu::with_items(
        app,
        t!("menu.file"),
        true,
        &[
            &item("files:open", "menu.file.open", Some("CmdOrCtrl+O"))?,
            &item("files:refresh", "menu.file.refresh", Some("CmdOrCtrl+R"))?,
            &sep()?,
            &item("file:prepare", "nav.prepare", None)?,
            &item("file:reveal", "menu.file.reveal", Some("CmdOrCtrl+Shift+R"))?,
            &item("file:delete", "menu.file.trash", Some("CmdOrCtrl+Backspace"))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, tr("menu.file.close").as_deref())?,
        ],
    )?;
    let edit_sub = Submenu::with_items(
        app,
        t!("menu.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, tr("menu.edit.undo").as_deref())?,
            &PredefinedMenuItem::redo(app, tr("menu.edit.redo").as_deref())?,
            &sep()?,
            &PredefinedMenuItem::cut(app, tr("menu.edit.cut").as_deref())?,
            &PredefinedMenuItem::copy(app, tr("menu.edit.copy").as_deref())?,
            &PredefinedMenuItem::paste(app, tr("menu.edit.paste").as_deref())?,
            // Native selection: fields, Library pages, terminal. The Files view
            // intercepts ⌘A to select its files.
            &PredefinedMenuItem::select_all(app, tr("menu.edit.select_all").as_deref())?,
            &sep()?,
            &item("edit:find", "menu.edit.find", Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let view_sub = Submenu::with_items(
        app,
        t!("menu.view"),
        true,
        &[
            &item("view:grid", "menu.view.grid", Some("CmdOrCtrl+1"))?,
            &item("view:list", "menu.view.list", Some("CmdOrCtrl+2"))?,
            &sep()?,
            &item("nav:library", "nav.library", Some("Alt+CmdOrCtrl+1"))?,
            &item("nav:ia", "nav.ia", Some("Alt+CmdOrCtrl+2"))?,
            &item("nav:files", "nav.files", Some("Alt+CmdOrCtrl+3"))?,
            &item("nav:prepare", "nav.prepare", Some("Alt+CmdOrCtrl+4"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, tr("menu.view.fullscreen").as_deref())?,
        ],
    )?;
    let window_sub = Submenu::with_items(
        app,
        t!("menu.window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, tr("menu.window.minimize").as_deref())?,
            &PredefinedMenuItem::maximize(app, tr("menu.window.zoom").as_deref())?,
        ],
    )?;
    let help_sub = Submenu::with_items(
        app,
        t!("menu.help"),
        true,
        &[
            &item("welcome:open", "menu.help.welcome", None)?,
            &sep()?,
            &item("help:bug", "menu.help.bug", None)?,
            &item("help:idea", "menu.help.idea", None)?,
            &item("help:github", "menu.help.github", None)?,
        ],
    )?;
    let _ = window_sub.set_as_windows_menu_for_nsapp();
    let _ = help_sub.set_as_help_menu_for_nsapp();

    Menu::with_items(app, &[&app_sub, &file_sub, &edit_sub, &view_sub, &window_sub, &help_sub])
}
