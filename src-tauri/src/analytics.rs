//! Anonymous usage count (docs/privacy.md, docs/plans/usage-analytics.md).
//!
//! One event, `app_started`, once per launch, with no properties of ours:
//! the Aptabase plugin adds its own fields (app version, system and its
//! version, web view and its version, locale, a debug flag, the plugin's
//! version, a random session id and a timestamp). Nothing else is ever
//! sent, and adding anything needs a plan and `docs/privacy.md` first.
//!
//! - The app key comes from the build environment (`APTABASE_APP_KEY`, a
//!   secret of the release workflow): local and fork builds have none, and a
//!   dev build never sends, even with one. Without a key the plugin is not
//!   registered at all.
//! - On by default, but nothing goes out before the user has answered the
//!   notice (`analytics.noticed`); turned off there or in Settings ›
//!   Application (`analytics.enabled`), nothing is sent.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Runtime};

/// The only event.
const EVENT: &str = "app_started";
const ENABLED: &str = "analytics.enabled";
const NOTICED: &str = "analytics.noticed";

/// The app key of this build: a release build with the CI secret only.
fn app_key() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        return None;
    }
    option_env!("APTABASE_APP_KEY").map(str::trim).filter(|k| !k.is_empty())
}

/// The plugin, for a build that can send; none otherwise (it is then not
/// registered: nothing in the app can send).
pub fn plugin<R: Runtime>() -> Option<tauri::plugin::TauriPlugin<R>> {
    app_key().map(|k| tauri_plugin_aptabase::Builder::new(k).build())
}

fn stored_bool(key: &str, default: bool) -> bool {
    crate::i18n::stored_value(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// What the interface shows: whether this build can send, the choice, and
/// whether the notice was answered.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Status {
    pub available: bool,
    pub enabled: bool,
    pub noticed: bool,
}

pub fn status() -> Status {
    Status { available: app_key().is_some(), enabled: stored_bool(ENABLED, true), noticed: stored_bool(NOTICED, false) }
}

/// This launch's event, sent at most once.
static SENT: AtomicBool = AtomicBool::new(false);

/// Whether this launch's event goes out now: a build that can send, the
/// notice answered, the count on, and not sent yet this launch.
fn should_send(s: Status, sent: bool) -> bool {
    s.available && s.noticed && s.enabled && !sent
}

/// Sends this launch's `app_started` if it should (at start, once the
/// notice is answered, or when switched back on), at once rather than at
/// the plugin's next flush: switched off a moment later, nothing is left
/// waiting to go.
pub fn start(app: &AppHandle) {
    send_once(status(), &SENT, || {
        use tauri_plugin_aptabase::EventTracker;
        let _ = app.track_event(EVENT, None);
        let app = app.clone();
        std::thread::spawn(move || app.flush_events_blocking());
    });
}

fn send_once(s: Status, sent: &AtomicBool, send: impl FnOnce()) {
    if should_send(s, sent.load(Ordering::SeqCst)) && !sent.swap(true, Ordering::SeqCst) {
        send();
    }
}

/// The notice answered: the choice kept, then this launch's event if on.
pub fn answer(app: &AppHandle, enabled: bool) -> anyhow::Result<Status> {
    crate::i18n::store(ENABLED, serde_json::Value::Bool(enabled))?;
    crate::i18n::store(NOTICED, serde_json::Value::Bool(true))?;
    start(app);
    Ok(status())
}

/// Switched in Settings › Application: at once (switched back on, this
/// launch's event goes if it has not).
pub fn set_enabled(app: &AppHandle, enabled: bool) -> anyhow::Result<Status> {
    crate::i18n::store(ENABLED, serde_json::Value::Bool(enabled))?;
    start(app);
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(available: bool, enabled: bool, noticed: bool) -> Status {
        Status { available, enabled, noticed }
    }

    /// Counts what a launch sends, through `send_once`.
    fn launch(s: Status, tries: usize) -> usize {
        let sent = AtomicBool::new(false);
        let mut n = 0;
        for _ in 0..tries {
            send_once(s, &sent, || n += 1);
        }
        n
    }

    #[test]
    fn nothing_is_sent_when_off_unanswered_or_without_a_key() {
        assert_eq!(launch(st(true, false, true), 3), 0, "switched off");
        assert_eq!(launch(st(true, true, false), 3), 0, "the notice not answered yet");
        assert_eq!(launch(st(false, true, true), 3), 0, "a dev build, or no key");
        assert_eq!(launch(st(true, false, false), 3), 0);
    }

    #[test]
    fn one_app_started_per_launch() {
        assert_eq!(launch(st(true, true, true), 1), 1);
        // Asked again (the notice answered, switched back on): still one.
        assert_eq!(launch(st(true, true, true), 5), 1);
    }

    #[test]
    fn switched_on_later_sends_that_launch_once() {
        let sent = AtomicBool::new(false);
        let mut n = 0;
        send_once(st(true, false, true), &sent, || n += 1);
        assert_eq!(n, 0, "off at start");
        send_once(st(true, true, true), &sent, || n += 1);
        send_once(st(true, true, true), &sent, || n += 1);
        assert_eq!(n, 1, "switched on: this launch counted once");
    }

    /// Tests are dev builds: never a key, whatever the environment.
    #[test]
    fn a_dev_build_has_no_key() {
        assert!(app_key().is_none());
        assert!(!status().available);
        assert!(plugin::<tauri::Wry>().is_none());
    }

    #[test]
    fn the_only_event_is_app_started() {
        assert_eq!(EVENT, "app_started");
    }
}
