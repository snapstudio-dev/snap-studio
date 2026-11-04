//! Pseudo-terminals: the Claude sign-in (`claude auth login`, the sandbox
//! setup) runs in one, shown by the UI as is, which sends it the
//! keystrokes. The conversations themselves no longer go through here:
//! they talk to Claude in JSON (`chat.rs`).
//!
//! Bytes go up in base64: split when read, they may cut an accented character
//! in two, and only the emulator on the UI side can glue the pieces back.

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Chunk {
    id: String,
    b64: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: String,
    code: i32,
}

struct Session {
    /// Kept: dropping the master would close the terminal.
    #[allow(dead_code)]
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// The write channel has its own lock: writing may block if the terminal
    /// does not consume, and that must not freeze everything else.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Which process this is: a reader thread only ends its own session,
    /// never the one opened after it under the same key.
    token: u64,
}

fn next_token() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Executables found on the machine.
pub struct Tools {
    pub claude: Option<PathBuf>,
    pub yolobox: Option<PathBuf>,
}

impl Tools {
    pub fn detect() -> Tools {
        Tools { claude: crate::util::which("claude"), yolobox: crate::util::which("yolobox") }
    }
}

/// Removes the inherited session markers from the environment.
///
/// An app launched from a Claude Code terminal inherits them, and Claude Code,
/// seeing them, **stops recording the conversation**: there is then nothing
/// to resume the next time. Only `CLAUDE_CONFIG_DIR` is kept, a deliberate
/// user setting, and nothing else is touched — above all not the API
/// credentials.
fn purge_markers(cmd: &mut CommandBuilder, names: impl Iterator<Item = String>) {
    for k in inherited_markers(names) {
        cmd.env_remove(&k);
    }
}

/// The inherited variables to remove (see [`purge_markers`]).
pub fn inherited_markers(names: impl Iterator<Item = String>) -> Vec<String> {
    names.filter(|k| k.starts_with("CLAUDE") && k != "CLAUDE_CONFIG_DIR").collect()
}

/// `PATH` for Claude and the checks: launched from the Finder, the app does
/// not inherit the terminal's, so the usual locations come before the
/// system's (`util::search_path`) — the same `python3` the checks find.
pub fn child_path() -> Option<std::ffi::OsString> {
    std::env::join_paths(crate::util::search_path()).ok()
}

/// True if a terminal is already running for this conversation.
/// Bytes read from a terminal, for a caller that watches its output.
pub type Tap = Box<dyn FnMut(&[u8]) + Send>;

/// Runs `argv` in a pseudo-terminal registered under `key`: its output goes
/// to the UI as `ia-pty` events (and to `tap` when given), its end as
/// `ia-exit`. Keystrokes come back through [`write`].
#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    app: &AppHandle,
    key: &str,
    argv: &[String],
    cwd: &std::path::Path,
    envs: &[(String, String)],
    cols: u16,
    rows: u16,
    mut tap: Option<Tap>,
) -> Result<()> {
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(4), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })?;

    let mut cmd = CommandBuilder::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(p) = child_path() {
        cmd.env("PATH", p);
    }
    purge_markers(&mut cmd, std::env::vars().map(|(k, _)| k));
    for (k, v) in envs {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    let token = next_token();
    sessions().lock().unwrap().insert(key.to_string(), Session { master: pair.master, writer: Arc::new(Mutex::new(writer)), child, token });

    let id = key.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(t) = tap.as_mut() {
                        t(&buf[..n]);
                    }
                    let _ = app.emit("ia-pty", Chunk { id: id.clone(), b64: crate::util::b64_encode(&buf[..n]) });
                }
            }
        }
        // Only this process's session: the key may since hold a newer one
        // (the auth terminal reopened), which must neither be closed nor
        // reported as exited.
        let mine = sessions().lock().unwrap().get(&id).is_some_and(|s| s.token == token);
        if !mine {
            return;
        }
        let code = close_and_wait(&id);
        let _ = app.emit("ia-exit", Exit { id, code });
    });
    Ok(())
}

pub fn write(id: &str, data: &str) -> Result<()> {
    // Take the channel, then release the global lock before writing: a large
    // paste may block for several seconds.
    let w = {
        let s = sessions().lock().unwrap();
        s.get(id).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?.writer.clone()
    };
    let mut w = w.lock().unwrap();
    w.write_all(data.as_bytes())?;
    w.flush()?;
    Ok(())
}

/// Time left to Claude to leave on its own.
const GRACE: std::time::Duration = std::time::Duration::from_millis(2500);

/// Removes the session and waits for the process to end.
///
/// Ask politely first. An interactive tool has some tidying to do on its way
/// out — if only writing its conversation to disk — and killing it outright
/// prevents that. The hard way remains, but as a last resort.
fn close_and_wait(id: &str) -> i32 {
    crate::ia::watch_stop(id);
    let Some(mut sess) = sessions().lock().unwrap().remove(id) else {
        return 0;
    };

    // Esc closes a possible dialog, then two quick interrupts make Claude Code
    // exit.
    if let Ok(mut w) = sess.writer.lock() {
        let _ = w.write_all(b"\x1b");
        let _ = w.flush();
        let _ = w.write_all(b"\x03\x03");
        let _ = w.flush();
    }

    let deadline = std::time::Instant::now() + GRACE;
    let mut code = None;
    while std::time::Instant::now() < deadline {
        match sess.child.try_wait() {
            Ok(Some(st)) => {
                code = Some(st.exit_code() as i32);
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(80)),
            Err(_) => break,
        }
    }

    code.unwrap_or_else(|| {
        let _ = sess.child.kill();
        sess.child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1)
    })
}

pub fn close(id: &str) {
    close_and_wait(id);
}

/// Closes all terminals — when the app closes.
pub fn close_all() {
    let ids: Vec<String> = sessions().lock().map(|s| s.keys().cloned().collect()).unwrap_or_default();
    for id in ids {
        close_and_wait(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A terminal on a trivial command: write, read back.
    #[test]
    fn a_terminal_carries_bytes_both_ways() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("/bin/cat");
        cmd.env("TERM", "dumb");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"bonjour\n").unwrap();
        writer.flush().unwrap();

        let mut seen = String::new();
        let mut buf = [0u8; 256];
        for _ in 0..20 {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if seen.contains("bonjour") {
                        break;
                    }
                }
            }
        }
        let _ = child.kill();
        assert!(seen.contains("bonjour"), "lu : {seen:?}");
    }
}

#[cfg(test)]
mod env_tests {
    /// Inherited session markers must disappear from the environment passed to
    /// Claude Code.
    ///
    /// It is the exact cause of unrecoverable conversations: seeing
    /// `CLAUDE_CODE_CHILD_SESSION`, Claude shows "Transcript saving is off" and
    /// writes no session — `--resume` and `/resume` then find nothing.
    #[test]
    fn inherited_markers_are_dropped() {
        use super::*;
        let planted = [
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_CHILD_SESSION", "oui"),
            ("CLAUDE_CODE_SESSION_ID", "abc"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_PID", "123"),
            ("CLAUDE_CONFIG_DIR", "/tmp/conf"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/x"),
        ];
        let mut cmd = CommandBuilder::new("/bin/echo");
        for (k, v) in planted {
            cmd.env(k, v);
        }
        purge_markers(&mut cmd, planted.iter().map(|(k, _)| k.to_string()));

        let left: std::collections::HashMap<&str, &str> = cmd.iter_full_env_as_str().collect();
        for k in ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID"] {
            assert!(!left.contains_key(k), "“{k}” should have disappeared");
        }
        assert_eq!(left.get("CLAUDE_CONFIG_DIR"), Some(&"/tmp/conf"), "intended setting");
        assert_eq!(left.get("ANTHROPIC_API_KEY"), Some(&"secret"), "left untouched");
        assert_eq!(left.get("PATH"), Some(&"/usr/bin"));
        assert_eq!(left.get("HOME"), Some(&"/Users/x"));
    }
}
