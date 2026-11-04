//! Claude sign-in for the AI conversations.
//!
//! Locally, Claude uses the Mac's own login (macOS Keychain, "Claude Code-
//! credentials"). In the container, yolobox copies that login in at every
//! start — a frozen copy of a rotating refresh token: whichever side renews
//! it second holds a dead one, and the Mac ends up signed out. So the sandbox
//! can get a token of its own: `claude setup-token` makes a long-lived one
//! (a year, tied to the subscription) that never renews. It is kept in the
//! Keychain under Snap Studio's name and handed to yolobox as
//! `CLAUDE_CODE_OAUTH_TOKEN`, which yolobox forwards and which takes
//! precedence over the copied login (checked against yolobox 0.19.7 and
//! Claude Code 2.1.286).
//!
//! `claude auth status` does not ask the server anything — it says "signed
//! in" even with a bogus token — so a real check makes one tiny model call.

use crate::pty::Tools;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::io::Write;
use tauri::{AppHandle, Emitter};

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Keychain item of the sandbox token: Snap Studio's, apart from Claude's.
#[cfg(target_os = "macos")]
const SERVICE: &str = "fr.carlini.snapstudio.claude-sandbox";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "sandbox";

/// Width of the `setup-token` terminal: a token is about 110 characters.
pub const SETUP_COLS: u16 = 140;

/// Key of the sign-in terminal among the app's terminals (`pty.rs`).
pub const TERM_KEY: &str = "auth";

// ------------------------------------------------------------ sandbox token

/// A token as `claude setup-token` prints it.
pub fn is_token(s: &str) -> bool {
    s.starts_with("sk-ant-oat") && s.len() > 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Outside macOS there is no `security`: a file only its owner can read.
#[cfg(not(target_os = "macos"))]
fn token_file() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("fr.carlini.snapstudio").join("claude-sandbox-token")
}

/// Runs `security` in interactive mode with `command` on its input: the
/// secret never shows in the process list, unlike an argument.
#[cfg(target_os = "macos")]
fn security(command: &str) -> Result<()> {
    let mut child =
        Command::new("/usr/bin/security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
    child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?.write_all(format!("{command}\n").as_bytes())?;
    let out = child.wait_with_output()?;
    let err = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || err.contains("could not be") {
        return Err(anyhow!(err.trim().to_string()));
    }
    Ok(())
}

pub fn sandbox_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && is_token(&t)).then_some(t)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let t = std::fs::read_to_string(token_file()).ok()?.trim().to_string();
        is_token(&t).then_some(t)
    }
}

pub fn set_sandbox_token(token: &str) -> Result<()> {
    let token = token.trim();
    if !is_token(token) {
        return Err(anyhow!(crate::t!("err.auth_bad_token")));
    }
    #[cfg(target_os = "macos")]
    {
        security(&format!("add-generic-password -U -s {SERVICE} -a {ACCOUNT} -w {token}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let p = token_file();
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        // Created readable by its owner only, from the first byte: a file
        // written then chmod'ed is readable by all in between.
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&p)?;
            f.write_all(token.as_bytes())?;
            // An existing file keeps its old mode on open: set anyway.
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))]
        std::fs::write(&p, token)?;
        Ok(())
    }
}

pub fn clear_sandbox_token() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Nothing to delete is fine.
        let _ = security(&format!("delete-generic-password -s {SERVICE} -a {ACCOUNT}"));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = std::fs::remove_file(token_file());
        Ok(())
    }
}

/// Environment for Claude in a conversation: the sandbox token in container
/// mode when there is one. yolobox forwards it to the container.
pub fn sandbox_env(engine: &str) -> Vec<(String, String)> {
    if engine != "container" {
        return Vec::new();
    }
    sandbox_token().map(|t| vec![("CLAUDE_CODE_OAUTH_TOKEN".to_string(), t)]).unwrap_or_default()
}

// ------------------------------------------------------------ status, check

/// Sign-in as Claude reports it, for one side (this Mac or the sandbox).
#[derive(Serialize, Default)]
pub struct Status {
    pub logged_in: bool,
    /// "claude.ai" (subscription login), "oauth_token" (a token such as the
    /// sandbox's), "api_key"…
    pub method: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    /// Container mode: the sandbox uses Snap Studio's own token.
    pub sandbox_token: bool,
    pub error: Option<String>,
}

/// The command for a side: Claude itself, or Claude through yolobox.
fn argv(engine: &str, tools: &Tools, claude_args: &[&str]) -> Result<Vec<String>> {
    let claude = tools.claude.as_ref().ok_or_else(|| anyhow!(crate::t!("err.no_claude")))?.to_string_lossy().to_string();
    if engine != "container" {
        let mut v = vec![claude];
        v.extend(claude_args.iter().map(|s| s.to_string()));
        return Ok(v);
    }
    let yolobox = tools.yolobox.as_ref().ok_or_else(|| anyhow!(crate::t!("err.no_yolobox")))?.to_string_lossy().to_string();
    let mut v = vec![yolobox, "run".into(), "--claude-config".into()];
    v.extend(crate::setup::runtime_args());
    v.push("claude".into());
    v.extend(claude_args.iter().map(|s| s.to_string()));
    Ok(v)
}

/// Runs a command with a deadline; returns its standard output, up to the
/// line for which `enough` says so (the command is then stopped).
fn run(argv: &[String], envs: &[(String, String)], deadline: Duration, enough: impl Fn(&str) -> bool) -> Result<String> {
    // An empty folder of our own, not the home: in container mode yolobox
    // mounts the working directory into the sandbox, and a sign-in check
    // has no business seeing the user's files (nor a stray CLAUDE.md).
    let cwd = crate::ia::root().join(".auth-check");
    std::fs::create_dir_all(&cwd)?;
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(p) = crate::pty::child_path() {
        cmd.env("PATH", p);
    }
    for k in crate::pty::inherited_markers(std::env::vars().map(|(k, _)| k)) {
        cmd.env_remove(k);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // A group of its own, so that stopping it stops what it started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufRead::lines(std::io::BufReader::new(stdout)).map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let end = Instant::now() + deadline;
    let mut out = String::new();
    loop {
        let left = end.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(line) => {
                out.push_str(&line);
                out.push('\n');
                if enough(&line) {
                    stop(&mut child);
                    return Ok(out);
                }
            }
            // Output closed: the command is over.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.wait();
                return Ok(out);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if left.is_zero() => {
                stop(&mut child);
                return Err(anyhow!(crate::t!("err.auth_timeout")));
            }
            Err(_) => {}
        }
    }
}

/// Stops a command and what it started: asked first (yolobox passes it on
/// to the container), forced after a moment.
fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: plain signal to the process group we created.
        unsafe { libc::killpg(pgid, libc::SIGTERM) };
    }
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The first JSON object of an output (yolobox may print a line before it).
fn first_json(out: &str) -> Option<Value> {
    let start = out.find('{')?;
    serde_json::Deserializer::from_str(&out[start..]).into_iter::<Value>().next()?.ok()
}

/// What Claude says about its sign-in, without asking the server.
pub fn status(engine: &str) -> Status {
    let tools = Tools::detect();
    let envs = sandbox_env(engine);
    let mut s = Status { sandbox_token: engine == "container" && !envs.is_empty(), ..Default::default() };
    let deadline = Duration::from_secs(if engine == "container" { 180 } else { 20 });
    match argv(engine, &tools, &["auth", "status", "--json"]).and_then(|a| run(&a, &envs, deadline, |_| false)) {
        Ok(out) => match first_json(&out) {
            Some(v) => {
                s.logged_in = v["loggedIn"] == true;
                s.method = v["authMethod"].as_str().map(String::from);
                s.email = v["email"].as_str().map(String::from);
                s.plan = v["subscriptionType"].as_str().map(String::from);
            }
            None => s.error = Some(crate::t!("err.auth_unreadable")),
        },
        Err(e) => s.error = Some(crate::util::ui_err(e)),
    }
    s
}

#[derive(Serialize)]
pub struct Check {
    pub ok: bool,
    pub message: String,
}

/// A real check: one tiny call to the model. `auth status` cannot tell a
/// dead token from a good one. Streamed, so that a refused sign-in ends the
/// check at once instead of after Claude's ten retries.
pub fn verify(engine: &str) -> Check {
    let tools = Tools::detect();
    let envs = sandbox_env(engine);
    let args = ["-p", "Reply with the single word OK.", "--model", "haiku", "--output-format", "stream-json", "--verbose"];
    let deadline = Duration::from_secs(if engine == "container" { 240 } else { 90 });
    let decisive = |line: &str| serde_json::from_str::<Value>(line).is_ok_and(|v| v["type"] == "result" || crate::chat::auth_failed(&v));
    let out = match argv(engine, &tools, &args).and_then(|a| run(&a, &envs, deadline, decisive)) {
        Ok(out) => out,
        Err(e) => return Check { ok: false, message: crate::util::ui_err(e) },
    };
    check_of(&out)
}

/// The verdict of a streamed check: its result, or the refused sign-in
/// that cut it short.
fn check_of(out: &str) -> Check {
    let last = out.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok());
    match last {
        Some(v) if v["type"] == "result" && v["is_error"] == false => Check { ok: true, message: crate::t!("auth.check_ok") },
        Some(v) if v["type"] == "result" => Check { ok: false, message: v["result"].as_str().unwrap_or("?").to_string() },
        Some(v) if crate::chat::auth_failed(&v) => {
            Check { ok: false, message: format!("API Error: {} {}", v["error_status"], v["error"].as_str().unwrap_or_default()) }
        }
        _ => Check { ok: false, message: crate::t!("err.auth_unreadable") },
    }
}

/// Whether a message from Claude says it could not sign in.
pub fn is_auth_failure(text: &str) -> bool {
    const SIGNS: [&str; 5] =
        ["Failed to authenticate", "Invalid API key", "OAuth token has expired", "Please run /login", "OAuth access token is invalid"];
    SIGNS.iter().any(|s| text.contains(s))
}

// ------------------------------------------------------------ sign-in terminal

/// Finds a token in what `claude setup-token` prints, colors and cursor
/// moves aside. The terminal is wide enough for it never to be wrapped.
#[derive(Default)]
pub struct TokenCatcher {
    seen: String,
    pub found: Option<String>,
}

impl TokenCatcher {
    pub fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        if self.found.is_some() {
            return None;
        }
        self.seen.push_str(&strip_ansi(&String::from_utf8_lossy(bytes)));
        // Only the tail matters: a token is a hundred-odd characters.
        if self.seen.len() > 8192 {
            let cut = self.seen.len() - 4096;
            let cut = (cut..self.seen.len()).find(|i| self.seen.is_char_boundary(*i)).unwrap_or(0);
            self.seen.drain(..cut);
        }
        let start = self.seen.find("sk-ant-oat")?;
        let rest = &self.seen[start..];
        let len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))?;
        let token = &rest[..len];
        if is_token(token) {
            self.found = Some(token.to_string());
        }
        self.found.clone()
    }
}

/// Removes ANSI escape sequences (colors, cursor moves).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                // Parameters, then one final byte in @–~.
                for d in chars.by_ref() {
                    if ('@'..='~').contains(&d) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: up to BEL or ESC \.
                chars.next();
                while let Some(d) = chars.next() {
                    if d == '\u{7}' {
                        break;
                    }
                    if d == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

/// The sign-in commands the app runs in its terminal: a new login of this
/// Mac, or a token for the sandbox.
pub fn term_argv(kind: &str) -> Result<Vec<String>> {
    let tools = Tools::detect();
    let claude = tools.claude.ok_or_else(|| anyhow!(crate::t!("err.no_claude")))?.to_string_lossy().to_string();
    match kind {
        "login" => Ok(vec![claude, "auth".into(), "login".into()]),
        "setup" => Ok(vec![claude, "setup-token".into()]),
        _ => Err(anyhow!("unknown sign-in: {kind}")),
    }
}

/// Opens the sign-in terminal for `kind` ("login" or "setup"). With
/// "setup", the token is caught as it is printed, stored, and announced by
/// an `auth-token` event: nothing to copy by hand.
pub fn term_open(app: &AppHandle, kind: &str, cols: u16, rows: u16) -> Result<()> {
    let argv = term_argv(kind)?;
    crate::pty::close(TERM_KEY);
    let tap: Option<crate::pty::Tap> = (kind == "setup").then(|| {
        let app = app.clone();
        let mut catcher = TokenCatcher::default();
        Box::new(move |bytes: &[u8]| {
            if let Some(token) = catcher.feed(bytes) {
                let error = set_sandbox_token(&token).err().map(crate::util::ui_err);
                let _ = app.emit("auth-token", serde_json::json!({ "ok": error.is_none(), "error": error }));
            }
        }) as crate::pty::Tap
    });
    // `setup-token` prints the token on one line: wide enough not to wrap it
    // (the view scrolls sideways at this width).
    let cols = if kind == "setup" { cols.max(SETUP_COLS) } else { cols };
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    crate::pty::spawn_terminal(app, TERM_KEY, &argv, &home, &[], cols, rows, tap)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwxyz";

    #[test]
    fn tokens_are_recognized() {
        assert!(is_token(TOKEN));
        assert!(!is_token("sk-ant-oat01-short"));
        assert!(!is_token("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"));
        assert!(!is_token(&format!("{TOKEN} x")));
    }

    #[test]
    fn the_token_is_caught_through_colors_and_chunks() {
        let mut c = TokenCatcher::default();
        let printed = format!("\u{1b}[32m✓ Long-lived token created:\u{1b}[0m\r\n\u{1b}[1m{TOKEN}\u{1b}[22m\r\nStore it");
        let (a, b) = printed.as_bytes().split_at(60);
        assert!(c.feed(a).is_none(), "not complete yet");
        assert_eq!(c.feed(b).as_deref(), Some(TOKEN));
        assert!(c.feed(b"more").is_none(), "only once");
    }

    #[test]
    fn a_token_cut_by_the_chunk_end_waits_for_the_rest() {
        let mut c = TokenCatcher::default();
        assert!(c.feed(&TOKEN.as_bytes()[..50]).is_none());
        assert_eq!(c.feed(format!("{}\n", &TOKEN[50..]).as_bytes()).as_deref(), Some(TOKEN));
    }

    #[test]
    fn auth_failures_are_recognized() {
        assert!(is_auth_failure("Failed to authenticate. API Error: 401 OAuth access token is invalid."));
        assert!(is_auth_failure("Invalid API key · Please run /login"));
        assert!(!is_auth_failure("The file contains hello"));
    }

    #[test]
    fn checks_end_on_a_result_or_a_refused_sign_in() {
        let ok = "→ Syncing\n{\"type\":\"system\",\"subtype\":\"init\"}\n{\"type\":\"result\",\"is_error\":false,\"result\":\"OK\"}\n";
        assert!(check_of(ok).ok);
        let refused = "{\"type\":\"system\",\"subtype\":\"api_retry\",\"error_status\":401,\"error\":\"authentication_failed\"}\n";
        let c = check_of(refused);
        assert!(!c.ok && c.message.contains("401"));
        assert!(!check_of("").ok);
    }

    #[test]
    fn json_is_found_after_a_banner() {
        let v = first_json("→ Syncing host Claude config\n{\"loggedIn\": true}\n").unwrap();
        assert_eq!(v["loggedIn"], true);
        assert!(first_json("nothing").is_none());
    }

    /// Against the real Claude: `AUTH_REAL=1 cargo test --lib real_sign_in -- --ignored --nocapture`.
    /// Prints no secret, only what the window would show.
    /// The built-in sandbox signs in as this computer: Claude itself, no
    /// token of its own.
    #[test]
    fn the_builtin_sandbox_uses_this_computers_sign_in() {
        assert!(sandbox_env("sandbox").is_empty());
        let tools = Tools { claude: Some("/usr/local/bin/claude".into()), yolobox: Some("/usr/local/bin/yolobox".into()) };
        let a = argv("sandbox", &tools, &["auth", "status"]).unwrap();
        assert_eq!(a, ["/usr/local/bin/claude", "auth", "status"]);
    }

    #[test]
    #[ignore]
    fn real_sign_in() {
        if std::env::var("AUTH_REAL").is_err() {
            return;
        }
        for engine in ["local", "container"] {
            let s = status(engine);
            println!(
                "{engine}: logged_in={} method={:?} plan={:?} own_token={} error={:?}",
                s.logged_in, s.method, s.plan, s.sandbox_token, s.error
            );
            let c = verify(engine);
            println!("{engine}: check ok={} {}", c.ok, c.message);
        }
    }

    /// A dead sandbox token is used in the container, and fails there:
    /// `AUTH_REAL=1 cargo test --lib real_dead_token -- --ignored --nocapture`.
    /// Only when no real sandbox token is stored: it is removed afterwards.
    #[test]
    #[ignore]
    fn real_dead_token() {
        if std::env::var("AUTH_REAL").is_err() || sandbox_token().is_some() {
            return;
        }
        set_sandbox_token(TOKEN).unwrap();
        let s = status("container");
        let c = verify("container");
        clear_sandbox_token().unwrap();
        assert!(sandbox_token().is_none());
        println!("method={:?} check ok={} {}", s.method, c.ok, c.message);
        assert_eq!(s.method.as_deref(), Some("oauth_token"), "the token takes precedence");
        assert!(!c.ok && c.message.contains("401"));
    }

    #[test]
    fn only_the_container_gets_the_sandbox_token() {
        assert!(sandbox_env("local").is_empty());
    }
}
