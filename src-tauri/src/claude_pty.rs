//! The shared Claude launch engine: Create's object conversations and
//! Snappy both talk to Claude Code through here.
//!
//! Claude runs in its normal interactive mode, in a pseudo-terminal — never
//! `claude -p`, which bills API credits instead of the subscription, skips
//! the folder trust prompt, ignores an invalid settings file, and inherits
//! nothing (permissions, hooks, safeguards) from a piloted session.
//!
//! Its stdout is never read for the conversation: the screen is only a view
//! (Create's Terminal tab). Two hooks drop sentinel files — SessionStart
//! (session id, transcript path) and Stop (the turn is complete) — and the
//! reply is read from Claude's JSONL transcript, polled. Its records are
//! re-emitted as the stream-json events the chat views already know, in
//! order (`seq`).
//!
//! The CLI stays at its prompt between messages: the next one is typed into
//! the terminal ([`inject_prompt`]). Closing the app stops the turn in
//! flight; the next launch resumes the session with `--resume`.
//!
//! Follows workspaces-manager's `claude_pty::run_claude_via_pty`.

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// Longest prompt passed as one `execve` argument (Linux's
/// `MAX_ARG_STRLEN`). Longer, the app refuses before launching.
pub const MAX_PROMPT_ARG_BYTES: usize = 128 * 1024;

/// Transcript reading cadence: during a turn, and at rest.
const POLL_TURN: Duration = Duration::from_millis(400);
const POLL_IDLE: Duration = Duration::from_millis(1500);

/// Bytes hashed before the read offset to tell the file is still the same.
const TAIL_CHECK: u64 = 4096;

/// Screen bytes kept for a Terminal view opened late.
const SCREEN_KEEP: usize = 512 * 1024;

/// How long a question or permission request waits for its answer (the
/// hook's own deadline is a little longer).
pub const ASK_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// After Stop is asked, how long to wait for Claude's interrupt record
/// before the turn is closed as stopped anyway.
const STOP_GRACE: Duration = Duration::from_secs(4);

/// Time left to Claude to leave on its own, then to its group after SIGTERM
/// (yolobox relays it to stop its container).
const GRACE: Duration = Duration::from_millis(2500);
const TERM_GRACE: Duration = Duration::from_millis(1500);

/// The text Claude Code records when a turn is interrupted (also "… for
/// tool use").
pub const INTERRUPTED: &str = "[Request interrupted by user";

/// Events for a conversation's view, in stream-json form.
pub type Listener = Arc<dyn Fn(Value) + Send + Sync>;
/// Raw terminal output, for a Terminal view.
pub type Screen = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// One Claude to start.
pub struct Launch {
    /// Registry key: a conversation id, or "snappy".
    pub key: String,
    /// What runs Claude, before its own arguments: `[claude]`, or yolobox
    /// and its flags.
    pub program: Vec<String>,
    /// Claude's own arguments (permission mode, model, system prompt…).
    pub args: Vec<String>,
    /// Settings passed with `--settings`; the hooks are merged in, never
    /// replacing what is there. `Value::Null`: the hooks only.
    pub settings: Value,
    /// Claude's session id: imposed on a new session, resumed otherwise.
    pub session_id: String,
    pub resume: bool,
    /// The first message, submitted at launch as a positional argument.
    pub prompt: String,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
    /// Only `envs` (and the terminal's own variables): the inherited
    /// environment is dropped (the built-in sandbox's allowlist).
    pub clean_env: bool,
    /// Where the hooks drop their files; must be reachable from where
    /// Claude runs (inside the workspace for a container).
    pub sentinel_dir: PathBuf,
    /// Where the transcript will be, as seen from here.
    pub transcript: PathBuf,
    /// Permission requests and questions go to the app (PermissionRequest
    /// and PreToolUse hooks), rather than to the terminal screen.
    pub ask: bool,
}

// ------------------------------------------------------------ hooks

/// A path quoted for `sh`.
fn sh_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"))
}

/// A hook that writes its input to `file`, whole or not at all.
fn drop_hook(file: &Path) -> Value {
    let tmp = file.with_extension("tmp");
    json!({ "type": "command", "command": format!("cat > {} && mv {} {}", sh_quote(&tmp), sh_quote(&tmp), sh_quote(file)) })
}

/// The script a question or permission hook runs: its request written
/// whole for the app, then the app's answer awaited and printed. Past the
/// deadline it prints the prepared refusal: anything that is not an
/// answer is a no.
const ASK_SH: &str = r#"#!/bin/sh
# Snap Studio: hands one hook request to the app and prints its answer.
d="$1"; k="$2"; n="$k-$$"
cat > "$d/$n.tmp" && mv "$d/$n.tmp" "$d/$n.req" || exit 0
i=0
while [ ! -f "$d/$n.ans" ]; do
  i=$((i+1))
  if [ "$i" -gt 4500 ]; then cat "$d/$k.deny"; rm -f "$d/$n.req"; exit 0; fi
  sleep 0.2
done
cat "$d/$n.ans"
rm -f "$d/$n.req" "$d/$n.ans"
"#;

fn ask_hook(dir: &Path, kind: &str) -> Value {
    json!({
        "type": "command",
        "command": format!("sh {} {} {kind}", sh_quote(&dir.join("ask.sh")), sh_quote(dir)),
        // Seconds; a little past the script's own deadline.
        "timeout": ASK_TIMEOUT.as_secs() + 60,
    })
}

/// The hooks of a run.
pub fn hooks(dir: &Path, ask: bool) -> Value {
    let mut h = json!({
        "SessionStart": [{ "hooks": [drop_hook(&dir.join("start.json"))] }],
        "Stop": [{ "hooks": [drop_hook(&dir.join("done.json"))] }],
    });
    if ask {
        h["PermissionRequest"] = json!([{ "hooks": [ask_hook(dir, "perm")] }]);
        h["PreToolUse"] = json!([{ "matcher": "AskUserQuestion", "hooks": [ask_hook(dir, "question")] }]);
    }
    h
}

/// `settings` with `hooks` added to its own, event by event.
pub fn with_hooks(settings: &Value, hooks: &Value) -> Value {
    let mut s = if settings.is_object() { settings.clone() } else { json!({}) };
    if !s["hooks"].is_object() {
        s["hooks"] = json!({});
    }
    for (event, entries) in hooks.as_object().into_iter().flatten() {
        let slot = &mut s["hooks"][event];
        if !slot.is_array() {
            *slot = json!([]);
        }
        if let (Some(list), Some(add)) = (slot.as_array_mut(), entries.as_array()) {
            list.extend(add.iter().cloned());
        }
    }
    s
}

/// The answer a permission request hook prints.
pub fn permission_decision(allow: bool, updated_input: Option<&Value>, permissions: Option<&Value>, message: &str) -> Value {
    let decision = if allow {
        let mut d = json!({ "behavior": "allow" });
        if let Some(i) = updated_input {
            d["updatedInput"] = i.clone();
        }
        if let Some(p) = permissions {
            d["updatedPermissions"] = p.clone();
        }
        d
    } else {
        json!({ "behavior": "deny", "message": message })
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

/// The answer to a question Claude asks (AskUserQuestion): the tool is
/// answered by its refusal's reason, which Claude reads as the reply.
pub fn question_reply(reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason } })
}

// ------------------------------------------------------------ the command line

/// The full command line: the pid wrapper, the program, Claude's arguments,
/// the settings with the hooks, the session, then the prompt.
pub fn argv(l: &Launch, pidfile: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // The wrapper's pid is the terminal's process group: one
    // `kill -TERM -<pid>` stops Claude, its agents and its shells.
    #[cfg(unix)]
    out.extend(["/bin/sh".into(), "-c".into(), r#"echo $$ > "$0"; exec "$@""#.into(), pidfile.to_string_lossy().to_string()]);
    #[cfg(not(unix))]
    let _ = pidfile;
    out.extend(l.program.iter().cloned());
    out.extend(l.args.iter().cloned());
    out.push("--settings".into());
    out.push(with_hooks(&l.settings, &hooks(&l.sentinel_dir, l.ask)).to_string());
    out.push(if l.resume { "--resume" } else { "--session-id" }.into());
    out.push(l.session_id.clone());
    if !l.prompt.is_empty() {
        out.push(as_message(&l.prompt));
    }
    out
}

/// A message as the CLI must read it: text, never a command. A leading
/// `/` (slash command), `!` (shell mode) or `#` would be run by the CLI
/// instead of reaching the model; a space before it keeps it a message
/// (checked against Claude Code 2.1.286, which sends it as typed).
pub fn as_message(text: &str) -> String {
    if text.trim_start().starts_with(['/', '!', '#']) {
        format!(" {}", text.trim_start())
    } else {
        text.to_string()
    }
}

/// Refuses a prompt over the argument limit, before anything starts.
pub fn check_prompt(text: &str) -> Result<()> {
    if text.len() > MAX_PROMPT_ARG_BYTES {
        return Err(anyhow!(crate::t!("err.prompt_too_long", kb = MAX_PROMPT_ARG_BYTES / 1024)));
    }
    Ok(())
}

// ------------------------------------------------------------ folder trust

/// Claude Code's own settings file (where folder trust is kept).
fn claude_json() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from) {
        Some(d) if d.is_absolute() => Some(d.join(".claude.json")),
        _ => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// Marks `dir` as trusted in Claude's settings, so the interactive CLI does
/// not stop on its trust prompt (whose default answer exits). Only folders
/// the app created: an object's workspace, Snappy's folder — never the
/// user's home.
pub fn pretrust(dir: &Path) -> Result<()> {
    let dir = dir.canonicalize()?;
    // Create's conversations and Snappy both live under
    // `~/.config/snap-studio`.
    let ours = crate::ia::root().parent().and_then(|r| r.canonicalize().ok()).is_some_and(|r| dir.starts_with(&r) && dir != r);
    if !ours || dirs::home_dir().and_then(|h| h.canonicalize().ok()).is_some_and(|h| h == dir) {
        return Err(anyhow!("not a folder of the app: {}", dir.display()));
    }
    let Some(file) = claude_json() else { return Ok(()) };
    // Claude itself (the user's own sessions too) rewrites this file: it is
    // read, changed and put back only if nobody wrote it meanwhile, else
    // read again — never one write over another's.
    for _ in 0..3 {
        let Ok(before) = std::fs::metadata(&file) else {
            // No settings yet: Claude writes them on its first start, and asks.
            return Ok(());
        };
        let mut cfg: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
        if !trust_in(&mut cfg, &dir) {
            return Ok(());
        }
        let tmp = file.with_extension(format!("snapstudio-{}", std::process::id()));
        write_private(&tmp, &serde_json::to_vec_pretty(&cfg)?)?;
        let now = std::fs::metadata(&file)?;
        if now.len() == before.len() && now.modified().ok() == before.modified().ok() {
            std::fs::rename(&tmp, &file)?;
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(anyhow!("Claude's settings kept changing"))
}

/// Marks `dir` trusted in Claude's settings; false when it already is
/// (itself or an ancestor: trusting a folder trusts what is under it).
fn trust_in(cfg: &mut Value, dir: &Path) -> bool {
    if dir.ancestors().any(|a| cfg["projects"][a.to_string_lossy().as_ref()]["hasTrustDialogAccepted"] == true) {
        return false;
    }
    let key = dir.to_string_lossy().to_string();
    if !cfg["projects"].is_object() {
        cfg["projects"] = json!({});
    }
    if !cfg["projects"][&key].is_object() {
        cfg["projects"][&key] = json!({});
    }
    cfg["projects"][&key]["hasTrustDialogAccepted"] = json!(true);
    true
}

/// A file only its owner reads, from its creation on (Claude's settings may
/// hold its sign-in).
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}

// ------------------------------------------------------------ reading the transcript

/// Incremental reading of a growing JSONL file: only complete lines, each
/// once, past a baseline.
pub struct Tail {
    path: PathBuf,
    /// Byte offset read up to (always after a line end), and the lines
    /// before it.
    offset: u64,
    line_no: usize,
    /// Lines from the file's start already accounted for — the baseline,
    /// then each line emitted: a reread from the start skips them.
    emitted: usize,
    seen: Option<(u64, Option<SystemTime>)>,
    hash: Option<[u8; 32]>,
}

/// Lines of a file (0 when it does not exist): the baseline of a resumed
/// session, whose transcript holds the whole conversation.
pub fn count_lines(path: &Path) -> usize {
    std::fs::read(path).map(|b| b.iter().filter(|&&c| c == b'\n').count()).unwrap_or(0)
}

impl Tail {
    pub fn new(path: PathBuf, baseline_lines: usize) -> Tail {
        Tail { path, offset: 0, line_no: 0, emitted: baseline_lines, seen: None, hash: None }
    }

    /// Follows another file (the one SessionStart names), past the same
    /// lines.
    pub fn set_path(&mut self, path: PathBuf) {
        if path != self.path {
            self.path = path;
            self.offset = 0;
            self.line_no = 0;
            self.seen = None;
            self.hash = None;
        }
    }

    fn hash_before(f: &mut std::fs::File, end: u64) -> Option<[u8; 32]> {
        use std::io::Seek;
        let start = end.saturating_sub(TAIL_CHECK);
        f.seek(std::io::SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; (end - start) as usize];
        f.read_exact(&mut buf).ok()?;
        Some(Sha256::digest(&buf).into())
    }

    /// The complete lines written since the last call. Nothing is read when
    /// (size, mtime) did not change; otherwise from the last offset, once
    /// the 4 KiB before it are checked to be the same, else from the start.
    pub fn read_new(&mut self) -> Vec<String> {
        use std::io::Seek;
        let Ok(meta) = std::fs::metadata(&self.path) else { return Vec::new() };
        let stamp = (meta.len(), meta.modified().ok());
        if self.seen == Some(stamp) {
            return Vec::new();
        }
        let Ok(mut f) = std::fs::File::open(&self.path) else { return Vec::new() };
        let same = self.offset == 0 || (meta.len() >= self.offset && Self::hash_before(&mut f, self.offset) == self.hash);
        if !same {
            self.offset = 0;
            self.line_no = 0;
        }
        let mut buf = Vec::new();
        if f.seek(std::io::SeekFrom::Start(self.offset)).is_err() || f.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.seen = Some(stamp);
        let Some(end) = buf.iter().rposition(|&c| c == b'\n') else { return Vec::new() };
        let complete = &buf[..=end];
        self.offset += complete.len() as u64;
        self.hash = Self::hash_before(&mut f, self.offset);
        let mut out = Vec::new();
        for line in complete[..complete.len() - 1].split(|&c| c == b'\n') {
            if self.line_no >= self.emitted {
                self.emitted = self.line_no + 1;
                if !line.is_empty() {
                    out.push(String::from_utf8_lossy(line).into_owned());
                }
            }
            self.line_no += 1;
        }
        out
    }
}

// ------------------------------------------------------------ records → events

/// The order of every event emitted, across sessions.
fn next_seq() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// What one transcript record says, for the turn.
#[derive(Debug, PartialEq)]
pub enum Record {
    /// To show: an answer, or tool results.
    Show(Value),
    /// A prompt was submitted (its `promptId`).
    Prompt(String),
    /// Claude's own proof that the turn ended (`system/turn_duration`).
    TurnEnd {
        duration_ms: Option<u64>,
    },
    /// The turn was interrupted.
    Interrupted,
    /// The API refused (sign-in, overload…): the turn ends on it.
    ApiError(String),
    Nothing,
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(b) => b.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

/// One transcript record, read for the view. Prompts are not shown again
/// (the view and the log have them from the send); sub-agents' turns and
/// meta records stay out.
pub fn record(line: &str, slim: &dyn Fn(&Value) -> Value) -> Record {
    let Ok(r) = serde_json::from_str::<Value>(line) else { return Record::Nothing };
    if r["isSidechain"] == true || r["isMeta"] == true {
        return Record::Nothing;
    }
    match r["type"].as_str() {
        Some("system") if r["subtype"] == "turn_duration" => Record::TurnEnd { duration_ms: r["durationMs"].as_u64() },
        Some("assistant") => {
            let content = &r["message"]["content"];
            if r["isApiErrorMessage"] == true {
                return Record::ApiError(text_of(content));
            }
            Record::Show(json!({
                "type": "assistant",
                "message": { "id": r["message"]["id"], "content": slim(content), "usage": r["message"]["usage"] },
            }))
        }
        // Claude's own summary when it compacts a long conversation: not a
        // prompt of the user's, and not to show.
        Some("user") if r["isCompactSummary"] == true || r["isVisibleInTranscriptOnly"] == true => Record::Nothing,
        Some("user") => {
            let content = &r["message"]["content"];
            if text_of(content).starts_with(INTERRUPTED) {
                return Record::Interrupted;
            }
            let results: Vec<Value> = content.as_array().into_iter().flatten().filter(|b| b["type"] == "tool_result").cloned().collect();
            if results.is_empty() {
                return match r["promptId"].as_str() {
                    Some(id) => Record::Prompt(id.to_string()),
                    None => Record::Nothing,
                };
            }
            Record::Show(json!({ "type": "user", "message": { "content": slim(&Value::Array(results)) } }))
        }
        _ => Record::Nothing,
    }
}

/// A hook file, when it really is that hook's, for this session.
pub fn sentinel(text: &str, event: &str, session_id: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(text).ok()?;
    (v["hook_event_name"] == event && v["session_id"] == session_id).then_some(v)
}

// ------------------------------------------------------------ sessions

/// Which prompt the end-of-turn proofs belong to. Claude writes each
/// prompt's `promptId` in the transcript and the Stop hook names it: a
/// proof is taken only for the latest prompt, once — a late Stop or
/// `turn_duration` of the previous message cannot end the next one.
#[derive(Default, Debug)]
pub struct Proofs {
    /// The latest prompt read in the transcript.
    current: Option<String>,
    /// The last prompt whose turn was delivered.
    delivered: Option<String>,
}

impl Proofs {
    pub fn prompt(&mut self, id: &str) {
        self.current = Some(id.to_string());
    }

    /// Whether a proof (of `prompt`, when it says) may end the turn.
    pub fn accepts(&self, prompt: Option<&str>) -> bool {
        match &self.current {
            // Before any prompt id (an older Claude): every proof counts.
            None => true,
            Some(c) => prompt.is_none_or(|p| p == c) && self.delivered.as_ref() != Some(c),
        }
    }

    pub fn delivered(&mut self) {
        self.delivered = self.current.clone();
    }
}

#[derive(Default)]
struct Turn {
    /// Messages submitted and not yet answered.
    pending: u32,
    started: Option<Instant>,
    stop_asked: Option<Instant>,
    /// Token use summed over the turn's answers.
    usage: HashMap<String, u64>,
    /// A Stop said agents still run: the turn waits for the next one.
    team: bool,
}

struct Shared {
    turn: Turn,
    /// Requests waiting for the user, by id: the hook's input.
    requests: HashMap<String, Value>,
    screen: Vec<u8>,
    /// Exit code once the process ended.
    exited: Option<Option<i32>>,
    closing: bool,
}

struct Session {
    token: u64,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    shared: Mutex<Shared>,
    dir: PathBuf,
    pidfile: PathBuf,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static S: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session(key: &str) -> Option<Arc<Session>> {
    sessions().lock().unwrap().get(key).cloned()
}

fn next_token() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// A Claude that runs and is not being closed.
pub fn is_open(key: &str) -> bool {
    session(key).is_some_and(|s| !s.shared.lock().unwrap().closing)
}

/// Waits until a closing Claude under `key` is gone (or `d` passed).
fn gone_within(key: &str, d: Duration) -> bool {
    let end = Instant::now() + d;
    while session(key).is_some() {
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// True while a message waits for its answer.
pub fn is_busy(key: &str) -> bool {
    session(key).is_some_and(|s| s.shared.lock().unwrap().turn.pending > 0)
}

/// Where a run's hook files go on this machine (a container's go in its
/// workspace instead): a folder of the app's, `~/.config/snap-studio/run`,
/// only its owner's (0700). Not the system's temporary folder: commands in
/// Claude's built-in sandbox may write there, and an answer file written
/// by an agent would answer its own permission request. The hooks run
/// outside the sandbox (Claude runs them), so they reach this folder.
pub fn host_sentinel_dir(run: &str) -> PathBuf {
    let base = crate::ia::root().parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir).join("run");
    let _ = std::fs::create_dir_all(&base);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }
    base.join(run)
}

/// Starts Claude. `listener` gets the view events, then
/// `{"type":"exited"}`; `screen` the terminal's bytes.
pub fn start(mut l: Launch, listener: Listener, screen: Option<Screen>) -> Result<()> {
    check_prompt(&l.prompt)?;
    if is_open(&l.key) {
        return Err(anyhow!("already running: {}", l.key));
    }
    // One being closed (a model switch, a sign-in restart): its end first,
    // so two Claudes never write the same session.
    if !gone_within(&l.key, GRACE + TERM_GRACE + Duration::from_secs(2)) {
        return Err(anyhow!("still closing: {}", l.key));
    }
    let run = uuid::Uuid::new_v4().simple().to_string();
    // A folder of its own per run: the one before may still be cleaning up.
    l.sentinel_dir = l.sentinel_dir.join(&run[..12]);
    let dir = l.sentinel_dir.clone();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    std::fs::write(dir.join("ask.sh"), ASK_SH)?;
    let refusal = crate::t!("chat.denied_by_user");
    std::fs::write(dir.join("perm.deny"), permission_decision(false, None, None, &refusal).to_string())?;
    std::fs::write(dir.join("question.deny"), question_reply(&crate::t!("chat.question_unanswered")).to_string())?;
    // Beside the hook files, out of the agents' reach.
    let pidfile = dir.join(format!("claude-turn-{run}.pid"));
    let argv = argv(&l, &pidfile);
    // A resumed transcript holds the whole conversation: only what comes
    // after its current end is this run's.
    let baseline = if l.resume { count_lines(&l.transcript) } else { 0 };

    let pair = native_pty_system().openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.cwd(&l.cwd);
    if l.clean_env {
        cmd.env_clear();
    } else {
        if let Some(p) = crate::pty::child_path() {
            cmd.env("PATH", p);
        }
        for k in crate::pty::inherited_markers(std::env::vars().map(|(k, _)| k)) {
            cmd.env_remove(k);
        }
    }
    for (k, v) in &l.envs {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    let sess = Arc::new(Session {
        token: next_token(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        shared: Mutex::new(Shared {
            turn: Turn { pending: u32::from(!l.prompt.is_empty()), started: Some(Instant::now()), ..Turn::default() },
            requests: HashMap::new(),
            screen: Vec::new(),
            exited: None,
            closing: false,
        }),
        dir: dir.clone(),
        pidfile,
    });
    sessions().lock().unwrap().insert(l.key.clone(), sess.clone());

    // The terminal: kept for a late view, passed on, and its end noted.
    let s = sess.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Looked for until the session started: the prompt comes before.
        let mut trusting = true;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if trusting && s.dir.join("start.json").exists() {
                        trusting = false;
                    }
                    // A trust prompt despite `pretrust` (a container's own
                    // settings): the folder is the app's, it is trusted.
                    if trusting && trust_prompt(&s.shared.lock().unwrap().screen, &buf[..n]) {
                        trusting = false;
                        let _ = write_raw(&s, b"\x1b[B");
                        std::thread::sleep(Duration::from_millis(100));
                        let _ = write_raw(&s, b"\r");
                    }
                    {
                        let mut sh = s.shared.lock().unwrap();
                        sh.screen.extend_from_slice(&buf[..n]);
                        // Trimmed by large steps, not at every redraw.
                        if sh.screen.len() > SCREEN_KEEP + SCREEN_KEEP / 4 {
                            let cut = sh.screen.len() - SCREEN_KEEP;
                            sh.screen.drain(..cut);
                        }
                    }
                    if let Some(f) = &screen {
                        f(&buf[..n]);
                    }
                }
            }
        }
        let code = s.child.lock().unwrap().wait().ok().map(|st| st.exit_code() as i32);
        s.shared.lock().unwrap().exited = Some(code);
    });

    let key = l.key.clone();
    let session_id = l.session_id.clone();
    let tail = Tail::new(l.transcript.clone(), baseline);
    std::thread::spawn(move || poll(key, sess, session_id, tail, listener));
    Ok(())
}

/// Whether the screen shows Claude's folder trust prompt, whose first
/// choice ("No, exit") is the default.
fn trust_prompt(before: &[u8], new: &[u8]) -> bool {
    let mut end = before[before.len().saturating_sub(4096)..].to_vec();
    end.extend_from_slice(new);
    let text: String = screen_text(&end).chars().filter(|c| !c.is_whitespace()).collect();
    text.contains("Itrustthisfolder") && text.contains("No,exit")
}

/// Emits an event with its place in the order.
fn emit(listener: &Listener, mut event: Value) {
    event["seq"] = json!(next_seq());
    listener(event);
}

/// The text left on the screen, without its escapes: why a start failed.
pub fn screen_text(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(d) = chars.next() {
                        if d == '\x07' || (d == '\x1b' && chars.peek() == Some(&'\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c == '\n' || !c.is_control() {
            out.push(c);
        }
    }
    out.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

/// Ends the turn: delivered once, whatever proof comes first.
fn finish(sess: &Session, listener: &Listener, result: Value) {
    let (deliver, usage, ms) = {
        let mut sh = sess.shared.lock().unwrap();
        let t = &mut sh.turn;
        let deliver = t.pending > 0;
        t.pending = t.pending.saturating_sub(1);
        t.stop_asked = None;
        t.team = false;
        let usage = std::mem::take(&mut t.usage);
        let ms = t.started.take().map(|s| s.elapsed().as_millis() as u64);
        (deliver, usage, ms)
    };
    if deliver {
        let mut r = result;
        r["type"] = json!("result");
        if r["duration_ms"].is_null() {
            r["duration_ms"] = json!(ms);
        }
        r["usage"] = json!(usage);
        emit(listener, r);
    }
}

/// The poller: transcript, hook files, end of turn, end of process.
fn poll(key: String, sess: Arc<Session>, session_id: String, mut tail: Tail, listener: Listener) {
    let slim = |c: &Value| crate::chat::slim_content(c);
    let mut announced: HashSet<String> = HashSet::new();
    let mut proofs = Proofs::default();
    loop {
        let (busy, exited, closing) = {
            let sh = sess.shared.lock().unwrap();
            (sh.turn.pending > 0, sh.exited, sh.closing)
        };
        std::thread::sleep(if busy { POLL_TURN } else { POLL_IDLE });

        // The session as SessionStart names it.
        if let Some(v) = std::fs::read_to_string(sess.dir.join("start.json")).ok().and_then(|t| sentinel(&t, "SessionStart", &session_id)) {
            // A container names its own path: ours stays then.
            if let Some(p) = v["transcript_path"].as_str().map(PathBuf::from).filter(|p| p.is_file()) {
                tail.set_path(p);
            }
        }

        let mut ended: Option<Value> = None;
        for line in tail.read_new() {
            match record(&line, &slim) {
                Record::Prompt(id) => proofs.prompt(&id),
                Record::Show(ev) => {
                    if ev["type"] == "assistant" {
                        let mut sh = sess.shared.lock().unwrap();
                        for (k, v) in ev["message"]["usage"].as_object().into_iter().flatten() {
                            if let Some(n) = v.as_u64() {
                                *sh.turn.usage.entry(k.clone()).or_default() += n;
                            }
                        }
                    }
                    let mut ev = ev;
                    if let Some(m) = ev["message"].as_object_mut() {
                        m.remove("usage");
                    }
                    emit(&listener, ev);
                }
                Record::TurnEnd { duration_ms } => {
                    let team = sess.shared.lock().unwrap().turn.team;
                    if !team && proofs.accepts(None) {
                        ended.get_or_insert(json!({ "subtype": "success", "is_error": false, "duration_ms": duration_ms }));
                    }
                }
                Record::Interrupted if proofs.accepts(None) => {
                    ended = Some(json!({ "subtype": "error_during_execution", "is_error": true }));
                }
                Record::Interrupted => {}
                Record::ApiError(text) => {
                    if crate::auth::is_auth_failure(&text) {
                        emit(&listener, json!({ "type": "auth_failed" }));
                    }
                    if proofs.accepts(None) {
                        ended = Some(json!({ "subtype": "error", "is_error": true, "result": text }));
                    }
                }
                Record::Nothing => {}
            }
        }

        // Stop: the message is complete, unless agents still run.
        let done = sess.dir.join("done.json");
        if let Some(v) = std::fs::read_to_string(&done).ok().and_then(|t| sentinel(&t, "Stop", &session_id)) {
            let _ = std::fs::remove_file(&done);
            let team = v["background_tasks"].as_array().is_some_and(|a| !a.is_empty());
            sess.shared.lock().unwrap().turn.team = team;
            if !team && ended.is_none() && proofs.accepts(v["prompt_id"].as_str()) {
                ended = Some(json!({ "subtype": "success", "is_error": false, "result": v["last_assistant_message"] }));
            }
        }

        // Requests from the question and permission hooks. An answered one
        // leaves (its script removes it): its id, a shell's pid, may come
        // back with a later request.
        announced.retain(|id| sess.dir.join(format!("{id}.req")).exists());
        let mut fresh = Vec::new();
        for e in std::fs::read_dir(&sess.dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".req") else { continue };
            if announced.contains(id) {
                continue;
            }
            let Some(input) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
            announced.insert(id.to_string());
            fresh.push((id.to_string(), input));
        }
        fresh.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, input) in fresh {
            sess.shared.lock().unwrap().requests.insert(id.clone(), input.clone());
            emit(&listener, request_event(&id, &input));
        }

        // Stop asked and no interrupt record: closed as stopped all the same.
        let overdue = sess.shared.lock().unwrap().turn.stop_asked.is_some_and(|t| t.elapsed() > STOP_GRACE);
        if overdue && ended.is_none() {
            ended = Some(json!({ "subtype": "error_during_execution", "is_error": true }));
        }
        if let Some(r) = ended {
            proofs.delivered();
            finish(&sess, &listener, r);
        }

        if exited.is_some() || closing {
            // Wait for the process itself before saying it ended.
            let code = loop {
                if let Some(c) = sess.shared.lock().unwrap().exited {
                    break c;
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            {
                let mut s = sessions().lock().unwrap();
                if s.get(&key).is_some_and(|x| x.token == sess.token) {
                    s.remove(&key);
                }
            }
            let text = screen_text(&sess.shared.lock().unwrap().screen);
            let tail_text: String = {
                let lines: Vec<&str> = text.lines().collect();
                lines[lines.len().saturating_sub(12)..].join("\n")
            };
            let failed = code.is_some_and(|c| c != 0) && !closing;
            eprintln!("[claude] ended for {key}: code {code:?}");
            emit(&listener, json!({ "type": "exited", "code": code, "stderr": if failed { tail_text } else { String::new() } }));
            let _ = std::fs::remove_dir_all(&sess.dir);
            let _ = std::fs::remove_file(&sess.pidfile);
            return;
        }
    }
}

/// A hook request as the view's permission card.
fn request_event(id: &str, input: &Value) -> Value {
    let tool = input["tool_name"].as_str().unwrap_or_default();
    let suggestions = &input["permission_suggestions"];
    json!({
        "type": "control_request",
        "request_id": id,
        "request": {
            "subtype": "can_use_tool",
            "tool_name": tool,
            "input": input["tool_input"],
            "description": input["tool_input"]["description"],
            "interactive": tool == "AskUserQuestion",
            "can_always": suggestions.as_array().is_some_and(|s| !s.is_empty()),
        },
    })
}

/// The hook request waiting under `id`, as Claude sent it.
pub fn request(key: &str, id: &str) -> Option<Value> {
    session(key)?.shared.lock().unwrap().requests.get(id).cloned()
}

/// Answers a hook request: the hook prints `answer` back to Claude.
pub fn answer(key: &str, id: &str, answer: &Value) -> Result<()> {
    let sess = session(key).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
    if sess.shared.lock().unwrap().requests.remove(id).is_none() {
        return Err(anyhow!(crate::t!("err.request_gone")));
    }
    let file = sess.dir.join(format!("{id}.ans"));
    let tmp = sess.dir.join(format!("{id}.anstmp"));
    std::fs::write(&tmp, answer.to_string())?;
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

/// Refuses every request still waiting (a stop, a close).
fn refuse_all(key: &str) {
    let Some(sess) = session(key) else { return };
    let ids: Vec<(String, Value)> = sess.shared.lock().unwrap().requests.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let deny = crate::t!("chat.denied_by_user");
    for (id, input) in ids {
        let a = if input["hook_event_name"] == "PreToolUse" {
            question_reply(&crate::t!("chat.question_unanswered"))
        } else {
            permission_decision(false, None, None, &deny)
        };
        let _ = answer(key, &id, &a);
    }
}

fn write_raw(sess: &Session, bytes: &[u8]) -> Result<()> {
    let mut w = sess.writer.lock().unwrap();
    w.write_all(bytes)?;
    w.flush()?;
    Ok(())
}

/// Types the next message into the CLI waiting at its prompt. The Stop file
/// of the message already answered goes first, so it cannot close this one.
pub fn inject_prompt(key: &str, text: &str) -> Result<()> {
    check_prompt(text)?;
    let sess = session(key).filter(|_| is_open(key)).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
    {
        let mut sh = sess.shared.lock().unwrap();
        sh.turn.pending += 1;
        sh.turn.started = Some(Instant::now());
        sh.turn.stop_asked = None;
    }
    let _ = std::fs::remove_file(sess.dir.join("done.json"));
    // A paste, so line ends stay in the message, then Enter on its own.
    let clean = as_message(&text.replace("\x1b[201~", ""));
    let sent = write_raw(&sess, format!("\x1b[200~{clean}\x1b[201~").as_bytes()).and_then(|_| {
        std::thread::sleep(Duration::from_millis(150));
        write_raw(&sess, b"\r")
    });
    if sent.is_err() {
        let mut sh = sess.shared.lock().unwrap();
        sh.turn.pending = sh.turn.pending.saturating_sub(1);
    }
    sent
}

/// Interrupts the turn (Esc, as at the keyboard); the CLI stays for the
/// next message. Requests still waiting are refused.
pub fn interrupt(key: &str) -> Result<()> {
    let sess = session(key).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
    sess.shared.lock().unwrap().turn.stop_asked = Some(Instant::now());
    refuse_all(key);
    write_raw(&sess, b"\x1b")
}

/// What the terminal showed so far, for a view opened late.
pub fn screen(key: &str) -> Vec<u8> {
    session(key).map(|s| s.shared.lock().unwrap().screen.clone()).unwrap_or_default()
}

pub fn resize(key: &str, cols: u16, rows: u16) -> Result<()> {
    let sess = session(key).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
    let m = sess.master.lock().unwrap();
    m.resize(PtySize { rows: rows.max(4), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })?;
    Ok(())
}

/// True once the child ended, false past `d`.
fn ended_within(sess: &Session, d: Duration) -> bool {
    let deadline = Instant::now() + d;
    loop {
        if sess.shared.lock().unwrap().exited.is_some() {
            return true;
        }
        match sess.child.lock().unwrap().try_wait() {
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

/// Marks a Claude as closing, at once: no message goes into it any more
/// (the next one starts a new Claude, which waits for this one's end). The
/// close itself may then run elsewhere.
pub fn retire(key: &str) {
    if let Some(s) = session(key) {
        s.shared.lock().unwrap().closing = true;
    }
}

/// Ends a Claude: Esc and two Ctrl-C first, then its whole group. Nothing
/// is lost: the next start resumes from the transcript.
pub fn close(key: &str) {
    let Some(sess) = session(key) else { return };
    refuse_all(key);
    // From now on it is not open: a message starts a new one, which waits
    // for this one's end.
    sess.shared.lock().unwrap().closing = true;
    let _ = write_raw(&sess, b"\x1b");
    std::thread::sleep(Duration::from_millis(100));
    let _ = write_raw(&sess, b"\x03\x03");
    if ended_within(&sess, GRACE) {
        return;
    }
    #[cfg(unix)]
    {
        // The group of the process this terminal started (the pid wrapper):
        // never a number read back from a file another process could write.
        let pid = sess.child.lock().unwrap().process_id().and_then(|p| libc::pid_t::try_from(p).ok());
        if let Some(pid) = pid.filter(|p| *p > 1) {
            // SAFETY: a plain signal to the group the terminal created.
            unsafe { libc::killpg(pid, libc::SIGTERM) };
        }
        if ended_within(&sess, TERM_GRACE) {
            return;
        }
    }
    let _ = sess.child.lock().unwrap().kill();
}

/// Ends every Claude — when the app closes — all at once.
pub fn close_all() {
    let keys: Vec<String> = sessions().lock().map(|s| s.keys().cloned().collect()).unwrap_or_default();
    let closing: Vec<_> = keys.into_iter().map(|k| std::thread::spawn(move || close(&k))).collect();
    for c in closing {
        let _ = c.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapstudio-cpty-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn launch(dir: &Path) -> Launch {
        Launch {
            key: "k".into(),
            program: vec!["/usr/local/bin/claude".into()],
            args: vec!["--permission-mode".into(), "acceptEdits".into()],
            settings: Value::Null,
            session_id: "11111111-2222-3333-4444-555555555555".into(),
            resume: false,
            prompt: "hello".into(),
            cwd: dir.to_path_buf(),
            envs: vec![],
            clean_env: false,
            sentinel_dir: dir.join("run"),
            transcript: dir.join("t.jsonl"),
            ask: true,
        }
    }

    #[test]
    fn the_command_line_never_prints() {
        let d = tmp("argv");
        let mut l = launch(&d);
        let a = argv(&l, Path::new("/tmp/claude-turn-x.pid"));
        assert!(!a.iter().any(|x| x == "-p" || x == "--print"), "{a:?}");
        let at = a.iter().position(|x| x == "/usr/local/bin/claude").unwrap();
        #[cfg(unix)]
        assert_eq!(&a[..4], ["/bin/sh", "-c", r#"echo $$ > "$0"; exec "$@""#, "/tmp/claude-turn-x.pid"]);
        assert!(a[at..].windows(2).any(|w| w == ["--session-id", "11111111-2222-3333-4444-555555555555"]));
        assert_eq!(a.last().unwrap(), "hello", "the prompt is the last, positional argument");
        l.resume = true;
        l.prompt.clear();
        let a = argv(&l, Path::new("/p"));
        assert!(a.windows(2).any(|w| w[0] == "--resume") && !a.iter().any(|x| x == "--session-id"));
        assert_eq!(a.last().unwrap(), "11111111-2222-3333-4444-555555555555", "no empty prompt argument");
    }

    #[test]
    fn hooks_are_merged_into_existing_settings() {
        let d = Path::new("/run/x");
        let base =
            json!({ "sandbox": { "enabled": true }, "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine" }] }] } });
        let s = with_hooks(&base, &hooks(d, true));
        assert_eq!(s["sandbox"]["enabled"], true, "the sandbox stays");
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "the existing Stop hook is kept");
        assert_eq!(stop[0]["hooks"][0]["command"], "mine");
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains("done.json"));
        assert!(s["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str().unwrap().contains("start.json"));
        assert_eq!(s["hooks"]["PreToolUse"][0]["matcher"], "AskUserQuestion");
        assert!(s["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"].as_u64().unwrap() > ASK_TIMEOUT.as_secs());
        let quiet = with_hooks(&Value::Null, &hooks(d, false));
        assert!(quiet["hooks"].get("PermissionRequest").is_none() && quiet["hooks"].get("PreToolUse").is_none());
    }

    #[test]
    fn hook_paths_are_quoted() {
        let h = drop_hook(Path::new("/a b/it's/done.json"));
        assert_eq!(h["command"], r"cat > '/a b/it'\''s/done.tmp' && mv '/a b/it'\''s/done.tmp' '/a b/it'\''s/done.json'");
    }

    #[test]
    fn a_prompt_over_the_argument_limit_is_refused() {
        assert!(check_prompt(&"x".repeat(MAX_PROMPT_ARG_BYTES)).is_ok());
        assert!(check_prompt(&"x".repeat(MAX_PROMPT_ARG_BYTES + 1)).is_err());
        // Bytes, not characters.
        assert!(check_prompt(&"é".repeat(MAX_PROMPT_ARG_BYTES / 2 + 1)).is_err());
    }

    #[test]
    fn sentinels_must_be_the_hooks_own() {
        let sid = "s-1";
        assert!(sentinel(r#"{"hook_event_name":"Stop","session_id":"s-1","last_assistant_message":"ok"}"#, "Stop", sid).is_some());
        assert!(sentinel(r#"{"hook_event_name":"Stop","session_id":"other"}"#, "Stop", sid).is_none(), "another session");
        assert!(sentinel(r#"{"hook_event_name":"SessionStart","session_id":"s-1"}"#, "Stop", sid).is_none(), "another hook");
        assert!(sentinel(r#"{"hook_event_name":"Stop","session_id":"s-1""#, "Stop", sid).is_none(), "half written");
        assert!(sentinel("", "Stop", sid).is_none());
    }

    #[test]
    fn records_become_view_events() {
        let id = |c: &Value| c.clone();
        assert_eq!(
            record(r#"{"type":"system","subtype":"turn_duration","durationMs":3336}"#, &id),
            Record::TurnEnd { duration_ms: Some(3336) }
        );
        assert_eq!(
            record(r#"{"type":"user","message":{"content":"[Request interrupted by user for tool use]"}}"#, &id),
            Record::Interrupted
        );
        assert_eq!(
            record(r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#, &id),
            Record::Interrupted
        );
        assert_eq!(record(r#"{"type":"user","message":{"content":"the prompt"}}"#, &id), Record::Nothing, "prompts are not shown again");
        let Record::Show(r) = record(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"},{"type":"text","text":"x"}]}}"#,
            &id,
        ) else {
            panic!("tool results are shown")
        };
        assert_eq!(r["message"]["content"].as_array().unwrap().len(), 1);
        let Record::Show(a) = record(r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"DONE1"}]}}"#, &id)
        else {
            panic!()
        };
        assert_eq!(a["message"]["content"][0]["text"], "DONE1");
        assert_eq!(record(r#"{"type":"assistant","isSidechain":true,"message":{"content":[]}}"#, &id), Record::Nothing);
        assert_eq!(record(r#"{"type":"user","isMeta":true,"message":{"content":"<meta>"}}"#, &id), Record::Nothing);
        assert!(matches!(
            record(r#"{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"Invalid API key · Please run /login"}]}}"#, &id),
            Record::ApiError(t) if crate::auth::is_auth_failure(&t)
        ));
        for other in ["file-history-snapshot", "attachment", "last-prompt", "ai-title", "mode"] {
            assert_eq!(record(&format!(r#"{{"type":"{other}"}}"#), &id), Record::Nothing);
        }
        assert_eq!(record("{not json", &id), Record::Nothing);
    }

    #[test]
    fn the_transcript_is_read_incrementally() {
        let d = tmp("tail");
        let p = d.join("t.jsonl");
        std::fs::write(&p, "old1\nold2\n").unwrap();
        let mut t = Tail::new(p.clone(), count_lines(&p));
        assert!(t.read_new().is_empty(), "the baseline is skipped");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"a\nb").unwrap();
        assert_eq!(t.read_new(), ["a"], "only complete lines");
        assert!(t.read_new().is_empty(), "unchanged: nothing");
        f.write_all(b"c\nd\n").unwrap();
        assert_eq!(t.read_new(), ["bc", "d"]);
        // Rewritten with the same start and more: only the new line.
        std::fs::write(&p, "old1\nold2\na\nbc\nd\ne\n").unwrap();
        assert_eq!(t.read_new(), ["e"]);
        // Truncated: what is left is all known.
        std::fs::write(&p, "old1\n").unwrap();
        assert!(t.read_new().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_changed_prefix_is_detected_by_its_hash() {
        let d = tmp("hash");
        let p = d.join("t.jsonl");
        std::fs::write(&p, "one\ntwo\n").unwrap();
        let mut t = Tail::new(p.clone(), 0);
        assert_eq!(t.read_new(), ["one", "two"]);
        // Same length, other bytes, then more: reread, the two first lines
        // counted as seen.
        std::fs::write(&p, "ONE\nTWO\nthree\n").unwrap();
        assert_eq!(t.read_new(), ["three"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_baseline_longer_than_the_file_waits() {
        let d = tmp("base");
        let p = d.join("t.jsonl");
        let mut t = Tail::new(p.clone(), 3);
        std::fs::write(&p, "1\n2\n").unwrap();
        assert!(t.read_new().is_empty());
        std::fs::write(&p, "1\n2\n3\n4\n").unwrap();
        assert_eq!(t.read_new(), ["4"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn screen_text_drops_escapes() {
        let s = b"\x1b[1mBold\x1b[0m line\r\n\x1b]0;title\x07Error: sandbox unavailable\n\n";
        assert_eq!(screen_text(s), "Bold line\nError: sandbox unavailable");
    }

    #[test]
    fn trust_is_added_once_and_kept_private() {
        let mut cfg =
            json!({ "projects": { "/Users/a/.config/snap-studio": { "hasTrustDialogAccepted": true } }, "oauthAccount": { "x": 1 } });
        assert!(!trust_in(&mut cfg, Path::new("/Users/a/.config/snap-studio/ia/1/workspace")), "an ancestor trusted");
        let mut cfg = json!({ "oauthAccount": { "x": 1 } });
        assert!(trust_in(&mut cfg, Path::new("/w")));
        assert_eq!(cfg["projects"]["/w"]["hasTrustDialogAccepted"], true);
        assert_eq!(cfg["oauthAccount"]["x"], 1, "the rest kept");
        assert!(!trust_in(&mut cfg, Path::new("/w")), "once");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let d = tmp("private");
            let p = d.join("cfg.tmp");
            write_private(&p, b"{}").unwrap();
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn a_late_proof_never_ends_the_next_turn() {
        let mut p = Proofs::default();
        assert!(p.accepts(None), "an older Claude without prompt ids: every proof counts");
        p.prompt("a");
        assert!(p.accepts(Some("a")) && p.accepts(None));
        p.delivered();
        // The previous turn's Stop or turn_duration, read late.
        assert!(!p.accepts(Some("a")) && !p.accepts(None), "turn a was delivered already");
        p.prompt("b");
        assert!(!p.accepts(Some("a")), "a's Stop does not end b");
        assert!(p.accepts(Some("b")) && p.accepts(None));
        p.delivered();
        assert!(!p.accepts(None), "once");
    }

    #[test]
    fn messages_are_never_commands() {
        assert_eq!(as_message("/clear the support"), " /clear the support");
        assert_eq!(as_message("  !rm -rf x"), " !rm -rf x");
        assert_eq!(as_message("#note"), " #note");
        assert_eq!(as_message("make it 2 mm thicker / wider"), "make it 2 mm thicker / wider");
        let d = tmp("cmd");
        let mut l = launch(&d);
        l.prompt = "/exit".into();
        assert_eq!(argv(&l, Path::new("/p")).last().unwrap(), " /exit");
    }

    #[test]
    fn a_prompt_record_carries_its_id() {
        let id = |c: &Value| c.clone();
        assert_eq!(record(r#"{"type":"user","promptId":"p1","message":{"content":"hi"}}"#, &id), Record::Prompt("p1".into()));
        // A compaction's summary, as Claude Code 2.1.286 writes it: no prompt.
        let summary = r#"{"type":"user","promptId":"p2","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"content":"This session is being continued…"}}"#;
        assert_eq!(record(summary, &id), Record::Nothing);
        assert_eq!(record(r#"{"type":"system","subtype":"compact_boundary"}"#, &id), Record::Nothing);
    }

    #[test]
    fn the_trust_prompt_is_recognized() {
        // As Claude Code 2.1.286 draws it: words placed by cursor moves.
        let screen = b"\x1b[2KAccessing\x1b[1Cworkspace:\r\n\x1b[1C\xe2\x9d\xaf\x1b[1CNo,\x1b[1Cexit\r\n Yes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder";
        assert!(trust_prompt(b"", screen));
        assert!(trust_prompt(&screen[..40], &screen[40..]), "split across reads");
        assert!(!trust_prompt(b"", b"I trust this folder, said the user"));
    }

    #[test]
    fn decisions_have_the_hooks_shape() {
        let allow = permission_decision(true, None, Some(&json!([{ "type": "addRules" }])), "no");
        assert_eq!(allow["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(allow["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(allow["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["type"], "addRules");
        let deny = permission_decision(false, None, None, "no");
        assert_eq!(deny["hookSpecificOutput"]["decision"], json!({ "behavior": "deny", "message": "no" }));
        let q = question_reply("The user answered: Blue");
        assert_eq!(q["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    /// The whole engine against a fake Claude: a script that writes a
    /// transcript and the hook files as the real one does, keeps reading its
    /// terminal for the next message, and asks one permission through the
    /// hook script.
    #[cfg(unix)]
    #[test]
    fn a_session_runs_against_a_fake_claude() {
        let d = tmp("fake");
        let fake = d.join("claude");
        // Arguments: … --settings <json> --session-id <id> <prompt>. The
        // script finds the run folder from the settings' Stop command.
        std::fs::write(
            &fake,
            r#"#!/bin/sh
set -e
for a in "$@"; do last="$a"; done
while [ "$#" -gt 0 ]; do
  case "$1" in --session-id) sid="$2"; shift 2;; --settings) settings="$2"; shift 2;; *) shift;; esac
done
run=$(printf '%s' "$settings" | sed -n "s/.*cat > '\([^']*\)\/done.tmp'.*/\1/p")
t="$PWD/t.jsonl"
printf '{"hook_event_name":"SessionStart","session_id":"%s","transcript_path":"%s"}' "$sid" "$t" > "$run/start.json"
turn() {
  printf '{"type":"user","message":{"content":"%s"}}\n' "$1" >> "$t"
  printf '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}\n' >> "$t"
  printf '{"tool_name":"Bash","tool_input":{"command":"ls"},"hook_event_name":"PermissionRequest","permission_suggestions":[]}' | sh "$run/ask.sh" "$run" perm > "$PWD/answer.json"
  printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"files"}]}}\n' >> "$t"
  printf '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"pong: %s"}]}}\n' "$1" >> "$t"
  printf '{"hook_event_name":"Stop","session_id":"%s","last_assistant_message":"pong"}' "$sid" > "$run/done.tmp"
  mv "$run/done.tmp" "$run/done.json"
  printf '{"type":"system","subtype":"turn_duration","durationMs":5}\n' >> "$t"
}
turn "$last"
stty -echo 2>/dev/null || true
while IFS= read -r line; do
  msg=$(printf '%s' "$line" | tr -d '\033\r' | sed 's/\[200~//; s/\[201~//')
  [ -n "$msg" ] && turn "$msg"
done
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut l = launch(&d);
        l.key = format!("fake-{}", std::process::id());
        l.program = vec![fake.to_string_lossy().to_string()];
        l.args = vec![];
        l.sentinel_dir = d.join("run");
        l.prompt = "ping".into();
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = got.clone();
        start(l, Arc::new(move |e| sink.lock().unwrap().push(e)), None).unwrap();
        let key = format!("fake-{}", std::process::id());
        let wait = |pred: &dyn Fn(&[Value]) -> bool| {
            let end = Instant::now() + Duration::from_secs(10);
            while !pred(&got.lock().unwrap()) && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        wait(&|e| e.iter().any(|x| x["type"] == "control_request"));
        let rid = got.lock().unwrap().iter().find(|x| x["type"] == "control_request").unwrap()["request_id"].as_str().unwrap().to_string();
        assert_eq!(request(&key, &rid).unwrap()["tool_name"], "Bash");
        answer(&key, &rid, &permission_decision(true, None, None, "")).unwrap();
        wait(&|e| e.iter().any(|x| x["type"] == "result"));
        assert!(!is_busy(&key));
        let first: Vec<Value> = got.lock().unwrap().clone();
        let results: Vec<&Value> = first.iter().filter(|e| e["type"] == "result").collect();
        assert_eq!(results.len(), 1, "one delivery, though Stop and turn_duration both prove it: {first:?}");
        assert_eq!(results[0]["subtype"], "success");
        let texts: Vec<&str> = first.iter().filter_map(|e| e["message"]["content"][0]["text"].as_str()).collect();
        assert_eq!(texts, ["pong: ping"]);
        let seqs: Vec<u64> = first.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "in order");
        let answered = std::fs::read_to_string(d.join("answer.json")).unwrap();
        assert!(answered.contains(r#""behavior":"allow""#), "{answered}");

        // The next message goes into the same CLI.
        inject_prompt(&key, "again").unwrap();
        assert!(is_busy(&key));
        wait(&|e| e.iter().filter(|x| x["type"] == "control_request").count() == 2);
        let rid2 = got.lock().unwrap().iter().filter(|x| x["type"] == "control_request").nth(1).unwrap()["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        answer(&key, &rid2, &permission_decision(false, None, None, "no")).unwrap();
        wait(&|e| e.iter().filter(|x| x["type"] == "result").count() == 2);
        let texts: Vec<String> =
            got.lock().unwrap().iter().filter_map(|e| e["message"]["content"][0]["text"].as_str().map(String::from)).collect();
        assert_eq!(texts, ["pong: ping", "pong: again"]);
        assert!(answer(&key, &rid2, &json!({})).is_err(), "answered once");

        // Retired: not open any more at once, the process still there.
        retire(&key);
        assert!(!is_open(&key));
        assert!(inject_prompt(&key, "late").is_err(), "nothing goes into a closing Claude");
        close(&key);
        wait(&|e| e.last().is_some_and(|x| x["type"] == "exited"));
        assert_eq!(got.lock().unwrap().last().unwrap()["type"], "exited");
        assert!(!is_open(&key));
        let _ = std::fs::remove_dir_all(&d);
    }
}
