//! Title bar on Windows and Linux.
//!
//! macOS overlays its traffic lights on the interface (tauri.macos.conf.json).
//! Elsewhere the window has no system decorations (tauri.windows.conf.json,
//! tauri.linux.conf.json) and the interface draws its own buttons in the same
//! 52 px band (ui/window-controls.js). Tauri resizes such a window from its
//! edges on Windows; on Linux `edge_resize` does.
//!
//! On Linux the window has the three standard buttons, on the side of the
//! desktop's layout (GTK's `gtk-decoration-layout`), and rounded corners
//! (`round_corners`); the system title bar can be put back from the
//! settings — tiling window managers and some desktops are better served by
//! it.

use serde::Serialize;

/// Key of the Linux preference in the settings file.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const SYSTEM_KEY: &str = "systemTitleBar";

/// What the interface needs to draw the title bar.
#[derive(Serialize)]
pub struct Info {
    /// "macos", "windows", "linux".
    os: &'static str,
    /// The interface draws the buttons (no system decorations).
    custom: bool,
    /// The system title bar can be chosen instead (Linux).
    switchable: bool,
    /// Buttons ("minimize", "maximize", "close") on each side, in order.
    left: Vec<&'static str>,
    right: Vec<&'static str>,
}

/// Linux: the user asked for the system title bar.
#[cfg(target_os = "linux")]
pub fn system_bar() -> bool {
    crate::i18n::stored_value(SYSTEM_KEY).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Buttons on each side for a GTK decoration layout
/// (`"appmenu:minimize,maximize,close"`, `"close,minimize,maximize:"`,
/// `":close"`): always the three of them, on the side where the layout puts
/// close (else its first button; the right when it has none, GNOME's
/// `"appmenu:close"` included). Left in the order macOS and elementary use,
/// right in Windows'.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_layout(layout: &str) -> (Vec<&'static str>, Vec<&'static str>) {
    let has = |s: &str, names: &[&str]| s.split(',').map(str::trim).any(|n| names.contains(&n));
    // Without a colon, everything is on the left (GTK's reading).
    let (l, r) = layout.split_once(':').unwrap_or((layout, ""));
    let buttons = ["minimize", "maximize", "close"];
    let left = has(l, &["close"]) || (!has(r, &["close"]) && has(l, &buttons) && !has(r, &buttons));
    if left {
        (vec!["close", "minimize", "maximize"], Vec::new())
    } else {
        (Vec::new(), windows_layout())
    }
}

fn windows_layout() -> Vec<&'static str> {
    vec!["minimize", "maximize", "close"]
}

/// Linux: the desktop's layout, read from GTK (main thread).
#[cfg(target_os = "linux")]
fn desktop_layout() -> (Vec<&'static str>, Vec<&'static str>) {
    use gtk::prelude::*;
    let layout = gtk::Settings::default().and_then(|s| s.gtk_decoration_layout()).map(|s| s.to_string()).unwrap_or_default();
    parse_layout(&layout)
}

fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

/// `custom`: the window is without system decorations.
fn info(custom: bool) -> Info {
    let os = os();
    let custom = custom && os != "macos";
    #[cfg(target_os = "linux")]
    let (left, right) = if custom { desktop_layout() } else { (Vec::new(), Vec::new()) };
    #[cfg(not(target_os = "linux"))]
    let (left, right) = if custom { (Vec::new(), windows_layout()) } else { (Vec::new(), Vec::new()) };
    Info { os, custom, switchable: os == "linux", left, right }
}

/// The title bar to draw. Synchronous: runs on the main thread, where GTK
/// can be read.
#[tauri::command]
pub fn titlebar_info(window: tauri::Window) -> Info {
    info(!window.is_decorated().unwrap_or(true))
}

/// Linux: system title bar or the interface's, at once and at next launch.
#[tauri::command]
pub fn titlebar_system_set(window: tauri::Window, on: bool) -> Result<Info, String> {
    #[cfg(target_os = "linux")]
    {
        // Applied first: a preference that could not take effect is not kept.
        window.set_decorations(on).map_err(crate::util::ui_err)?;
        crate::i18n::store(SYSTEM_KEY, serde_json::Value::Bool(on)).map_err(crate::util::ui_err)?;
        // What was asked: `is_decorated` may still give the former state.
        Ok(info(!on))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, on);
        Err("system title bar: Linux only".into())
    }
}

/// Linux: resizing an undecorated window from its edges.
///
/// Tauri has a handler for it on the main view, which finds the window as the
/// view's grandparent: not where the view sits in this app's window (it never
/// fires, checked under X11), let alone once the Library tabs have moved it
/// into a `gtk::Overlay` (library.rs, `gtk_layer`); the tabs' own views, over
/// the window's right and bottom edges, have none. This one works from any
/// view: the window is the widget's toplevel, the pointer read in screen
/// coordinates. Should Tauri's handler fire, it claims the event first.
#[cfg(target_os = "linux")]
pub mod edge_resize {
    use gtk::gdk::{CursorType, WindowEdge};
    use gtk::glib::Propagation;
    use gtk::prelude::*;

    /// Width of the band along the edges, in logical pixels (Tauri's: 5).
    const INSET: f64 = 5.0;

    /// The undecorated, resizable, not maximized window holding `w`.
    fn resizable(w: &gtk::Widget) -> Option<gtk::Window> {
        let win = w.toplevel()?.downcast::<gtk::Window>().ok()?;
        (!win.is_decorated() && win.is_resizable() && !win.is_maximized()).then_some(win)
    }

    /// The edge under a point of the screen, if any.
    fn edge_at(win: &gtk::Window, root_x: f64, root_y: f64) -> Option<WindowEdge> {
        let gw = win.window()?;
        let (_, ox, oy) = gw.origin();
        let (x, y) = (root_x - ox as f64, root_y - oy as f64);
        let (w, h) = (gw.width() as f64, gw.height() as f64);
        // GDK sizes and positions are logical already.
        let b = INSET;
        let (l, r, t, bt) = (x < b, x >= w - b, y < b, y >= h - b);
        Some(match (l, r, t, bt) {
            (true, _, true, _) => WindowEdge::NorthWest,
            (_, true, true, _) => WindowEdge::NorthEast,
            (true, _, _, true) => WindowEdge::SouthWest,
            (_, true, _, true) => WindowEdge::SouthEast,
            (true, ..) => WindowEdge::West,
            (_, true, ..) => WindowEdge::East,
            (_, _, true, _) => WindowEdge::North,
            (.., true) => WindowEdge::South,
            _ => return None,
        })
    }

    fn cursor(edge: WindowEdge) -> CursorType {
        match edge {
            WindowEdge::NorthWest => CursorType::TopLeftCorner,
            WindowEdge::NorthEast => CursorType::TopRightCorner,
            WindowEdge::SouthWest => CursorType::BottomLeftCorner,
            WindowEdge::SouthEast => CursorType::BottomRightCorner,
            WindowEdge::West => CursorType::LeftSide,
            WindowEdge::East => CursorType::RightSide,
            WindowEdge::North => CursorType::TopSide,
            _ => CursorType::BottomSide,
        }
    }

    /// Watches the pointer over a view: resize cursor along the edges, resize
    /// on a press there. Elsewhere the view gets its events as usual.
    pub fn attach(view: &gtk::Widget) {
        view.add_events(gtk::gdk::EventMask::POINTER_MOTION_MASK | gtk::gdk::EventMask::BUTTON_PRESS_MASK);
        // Our resize cursor is on the view: taken back when the pointer
        // leaves the edge (the view only sets its own when it changes).
        let shown = std::rc::Rc::new(std::cell::Cell::new(false));
        view.connect_motion_notify_event(move |view, event| {
            let edge = resizable(view).and_then(|win| {
                let (rx, ry) = event.root();
                edge_at(&win, rx, ry)
            });
            let Some(gw) = view.window() else { return Propagation::Proceed };
            let Some(edge) = edge else {
                if shown.replace(false) {
                    gw.set_cursor(None);
                }
                return Propagation::Proceed;
            };
            let c = gtk::gdk::Cursor::for_display(&gw.display(), cursor(edge));
            gw.set_cursor(c.as_ref());
            shown.set(true);
            Propagation::Stop
        });
        view.connect_button_press_event(|view, event| {
            if event.button() != 1 {
                return Propagation::Proceed;
            }
            let Some(win) = resizable(view) else { return Propagation::Proceed };
            let (rx, ry) = event.root();
            let Some(edge) = edge_at(&win, rx, ry) else { return Propagation::Proceed };
            win.begin_resize_drag(edge, 1, rx as i32, ry as i32, event.time());
            Propagation::Stop
        });
    }
}

/// Linux: rounded corners for the undecorated window, as GNOME's.
///
/// The window is transparent (tauri.linux.conf.json); each web view over it
/// (the main one, the Library tabs') clears, once it has drawn, what it
/// covers of the window's corners outside a rounded rectangle. Clipping in
/// the window's own `draw` would not do: GTK draws the views, which have GDK
/// windows of their own, in passes of their own, after it; and the page's
/// CSS cannot round the tabs' views. Square when the window fills its place
/// (maximized, tiled, fullscreen) or has the system title bar, whose own
/// decorations then draw it.
#[cfg(target_os = "linux")]
pub mod round_corners {
    use gtk::cairo::{Context, FillRule, Operator};
    use gtk::gdk::WindowState;
    use gtk::glib::Propagation;
    use gtk::prelude::*;
    use std::f64::consts::{FRAC_PI_2, PI};

    /// libadwaita's window radius, in logical pixels.
    const RADIUS: f64 = 12.0;

    fn rounded(win: &gtk::Window) -> bool {
        if win.is_decorated() {
            return false;
        }
        let Some(gw) = win.window() else { return false };
        let full = WindowState::MAXIMIZED | WindowState::FULLSCREEN | WindowState::TILED;
        !gw.state().intersects(full)
    }

    /// Clears the window's corners where `view` covers them.
    fn clear(view: &gtk::Widget, cr: &Context) {
        let Some(win) = view.toplevel().and_then(|t| t.downcast::<gtk::Window>().ok()) else { return };
        if !rounded(&win) {
            return;
        }
        let Some((x, y)) = view.translate_coordinates(&win, 0, 0) else { return };
        let (w, h) = (win.allocated_width() as f64, win.allocated_height() as f64);
        let r = RADIUS.min(w / 2.0).min(h / 2.0);
        let _ = cr.save();
        cr.translate(-x as f64, -y as f64);
        // The whole window less the rounded rectangle: the corners.
        cr.rectangle(0.0, 0.0, w, h);
        cr.new_sub_path();
        cr.arc(w - r, r, r, -FRAC_PI_2, 0.0);
        cr.arc(w - r, h - r, r, 0.0, FRAC_PI_2);
        cr.arc(r, h - r, r, FRAC_PI_2, PI);
        cr.arc(r, r, r, PI, 3.0 * FRAC_PI_2);
        cr.close_path();
        cr.set_fill_rule(FillRule::EvenOdd);
        cr.set_operator(Operator::Clear);
        let _ = cr.fill();
        let _ = cr.restore();
    }

    /// A web view over the window: its corners cleared after it draws.
    pub fn attach(view: &gtk::Widget) {
        view.connect_local("draw", true, |args| {
            let view = args[0].get::<gtk::Widget>().ok()?;
            let cr = args[1].get::<Context>().ok()?;
            clear(&view, &cr);
            Some(false.to_value())
        });
    }

    /// The window: drawn again when it gets maximized, tiled or back.
    pub fn attach_window(win: &gtk::Window) {
        win.connect_window_state_event(|win, _| {
            win.queue_draw();
            Propagation::Proceed
        });
    }
}

#[cfg(test)]
mod tests {
    use super::parse_layout;

    #[test]
    fn layouts() {
        let left = || (vec!["close", "minimize", "maximize"], vec![]);
        let right = || (vec![], vec!["minimize", "maximize", "close"]);
        // GNOME's default, close alone on the right: all three there.
        assert_eq!(parse_layout("appmenu:close"), right());
        assert_eq!(parse_layout("icon:minimize,maximize,close"), right());
        // On the left (elementary, old Ubuntu), with or without the others.
        assert_eq!(parse_layout("close,minimize,maximize:"), left());
        assert_eq!(parse_layout("close:maximize"), left());
        // No colon: all on the left.
        assert_eq!(parse_layout("close"), left());
        // Close decides the side; spaces and spacers ignored.
        assert_eq!(parse_layout("minimize, spacer:maximize ,close"), right());
        // No close: the side of the other buttons.
        assert_eq!(parse_layout("minimize:"), left());
        assert_eq!(parse_layout(":maximize"), right());
        // Nothing usable: the right.
        for l in ["", "appmenu:", "icon"] {
            assert_eq!(parse_layout(l), right());
        }
    }
}
