//! AI conversations as a chat, over the shared Claude engine
//! (`claude_pty.rs`).
//!
//! Claude runs interactively in a pseudo-terminal; its answers are read from
//! its transcript and reach the UI as the `ia-chat` Tauri event, in the
//! stream-json form the view already knows. The first request is the launch
//! prompt; the next messages are typed into the waiting CLI. Permission
//! requests and Claude's questions come back through hooks, as cards. The
//! conversation id stays Claude's session id, so resuming works as before.
//! The terminal itself is only a view (the Terminal tab), as the
//! `ia-screen` event.
//!
//! Each conversation also keeps its own log, `workspace/chat.jsonl`: what the
//! view shows, kept as long as the object lives — Claude Code deletes its own
//! transcripts after `cleanupPeriodDays` — plus what is ours (attachments,
//! versions, permission answers). Claude's transcript stays the source of
//! truth for resuming; we never write into it.
//!
//! The view's protocol was adapted from claude-chat-panel
//! (https://github.com/simscorpbs/claude-chat-panel, MIT License,
//! Copyright (c) 2026 simscorpbs): permission answers, history filtering.

use crate::claude_pty::{self, Launch};
use crate::ia::Conversation;
use crate::ia_attach::StagedModel;
use crate::pty::Tools;
use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Tool results kept in the log and sent to the view, in characters.
const RESULT_CAP: usize = 20_000;

/// Models a conversation may choose; none is the account's default.
pub const MODELS: [&str; 3] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

/// Hook files of a container's run: in the workspace, which yolobox mounts
/// at the same path (the system's temporary folder is the container's own).
const CONTAINER_RUN: &str = ".snapstudio-run";

// ------------------------------------------------------------ launch

/// How a conversation's Claude starts, with `prompt` as its first message.
///
/// As before: `--session-id` on the first run, `--resume` once Claude wrote
/// a transcript; yolobox in front in container mode, its flags after the
/// subcommand and Claude's passed through; Claude itself with its own
/// sandbox's settings in sandbox mode (the hooks are merged into them).
pub fn launch(c: &Conversation, tools: &Tools, resume: bool, prompt: String) -> Result<Launch> {
    let ws = crate::ia::workspace(&c.id);
    let mut args: Vec<String> = Vec::new();
    if let Some(m) = c.model.as_deref().filter(|m| MODELS.contains(m)) {
        args.push("--model".into());
        args.push(m.to_string());
    }
    let mut l = Launch {
        key: c.id.clone(),
        program: Vec::new(),
        args: Vec::new(),
        settings: Value::Null,
        session_id: c.id.clone(),
        resume,
        prompt,
        cwd: ws.clone(),
        envs: crate::auth::sandbox_env(&c.engine),
        clean_env: false,
        sentinel_dir: claude_pty::host_sentinel_dir(&c.id),
        transcript: crate::ia::session_file(&c.id),
        ask: true,
    };

    if c.engine == "container" {
        let yolobox = tools.yolobox.as_ref().ok_or_else(|| anyhow!(crate::t!("err.no_yolobox")))?;
        // yolobox's `claude` alias already skips permission prompts;
        // Claude's questions still come through the hook.
        l.program = vec![
            yolobox.to_string_lossy().to_string(),
            "claude".into(),
            "--claude-config".into(),
            "--customize-file".into(),
            crate::ia::dockerfile().to_string_lossy().to_string(),
        ];
        // The engine found running at the last check (Docker, Podman…).
        l.program.extend(crate::setup::runtime_args());
        l.args = args;
        l.sentinel_dir = run_dir(&ws);
        return Ok(l);
    }

    let claude = tools.claude.as_ref().ok_or_else(|| anyhow!(crate::t!("err.no_claude")))?;
    l.program = vec![claude.to_string_lossy().to_string()];
    // In Claude Code's own sandbox: its settings for this session only,
    // above the user's and any project's, and a reduced environment.
    if c.engine == "sandbox" {
        l.settings = sandbox_settings(&ws, &crate::setup::sandbox_read_paths());
        l.clean_env = true;
        let mut envs = sandbox_env_allowlist(std::env::vars());
        envs.append(&mut l.envs);
        l.envs = envs;
    }
    // Locally, Claude works on your Mac: file edits are accepted outright
    // and commands ask — in the chat, as permission cards. In the sandbox,
    // commands run confined without asking.
    l.args = vec!["--permission-mode".into(), "acceptEdits".into()];
    l.args.extend(args);
    Ok(l)
}

// ------------------------------------------------------------ built-in sandbox

/// The variables Claude's sandboxed commands must never see: Claude keeps
/// them for its own calls (API sign-in), its sandbox unsets them before
/// every command.
const SANDBOX_SECRETS: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

/// The settings of a conversation in Claude Code's built-in sandbox
/// (`--settings`, which ranks above the user's and the project's, and makes
/// the sandbox impossible to loosen from the workspace). Absolute paths
/// only.
///
/// - Its commands are sandboxed (Seatbelt, bubblewrap), every one of them:
///   no unsandboxed retry, no excluded command, and Claude refuses to start
///   when the sandbox cannot (`failIfUnavailable`) rather than run them
///   unconfined. They run without asking (`autoAllowBashIfSandboxed`,
///   `Bash` allowed): that is safe only together with the three above.
/// - They write in the workspace (and the sandbox's temp folder) and read
///   nothing of the home folder (`blockReadsOutsideWorkingDirectories`,
///   which also holds Claude's file tools to the workspace) but `read`, the
///   Python found under it, read only.
/// - No network for them: an empty allowlist, strictly.
pub fn sandbox_settings(ws: &Path, read: &[PathBuf]) -> Value {
    let abs = |p: &Path| p.to_string_lossy().to_string();
    // In permission rules, `//` starts an absolute path.
    let rule = |tool: &str| format!("{tool}(/{}/**)", abs(ws).trim_end_matches('/'));
    json!({
        "sandbox": {
            "enabled": true,
            "failIfUnavailable": true,
            "allowUnsandboxedCommands": false,
            "autoAllowBashIfSandboxed": true,
            "excludedCommands": [],
            "filesystem": { "allowRead": read.iter().map(|p| abs(p)).collect::<Vec<_>>() },
            "network": { "allowedDomains": [], "strictAllowlist": true },
            "credentials": { "envVars": SANDBOX_SECRETS.iter().map(|k| json!({ "name": k, "mode": "deny" })).collect::<Vec<_>>() },
        },
        "permissions": {
            "blockReadsOutsideWorkingDirectories": true,
            "allow": ["Bash", rule("Edit"), rule("Read")],
            "deny": ["Bash(dangerouslyDisableSandbox:true)"],
        },
    })
}

/// File tools that write.
const WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// A write outside the workspace, asked by a sandboxed conversation: denied
/// at once, without a card (the sandbox only confines commands; Claude's
/// file tools ask instead). `..` and symbolic links are resolved first.
/// `None` for everything else: the usual flow.
pub fn sandbox_answer(request: &Value, ws: &Path) -> Option<Value> {
    let tool = request["tool_name"].as_str()?;
    if !WRITE_TOOLS.contains(&tool) {
        return None;
    }
    let input = &request["input"];
    let path = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str())?;
    let target = if Path::new(path).is_absolute() { PathBuf::from(path) } else { ws.join(path) };
    let inside = match (resolved(&target), ws.canonicalize()) {
        (Some(t), Ok(w)) => t.starts_with(&w),
        _ => false,
    };
    (!inside).then(|| json!({ "behavior": "deny", "message": crate::t!("chat.sandbox_outside") }))
}

/// A path with its links and `..` resolved, though its last parts may not
/// exist yet: the deepest existing ancestor canonicalized, the rest added
/// back (a `..` left there means it cannot be told: None).
fn resolved(p: &Path) -> Option<PathBuf> {
    let mut rest = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = cur.canonicalize() {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return Some(out);
        }
        let name = cur.file_name()?.to_os_string();
        if name == ".." {
            return None;
        }
        rest.push(name);
        cur = cur.parent()?.to_path_buf();
    }
}

/// Tools that reach the web from Claude itself, outside the sandbox: asked
/// each time in a sandboxed conversation, never "always".
const WEB_TOOLS: [&str; 2] = ["WebFetch", "WebSearch"];

/// The environment Claude starts with in its sandbox: its commands inherit
/// it, so only what Claude needs is kept — the system's basics, Claude
/// Code's own folders, the network's proxies and certificates, the API
/// sign-in (hidden from commands by `sandbox_settings`). Everything else
/// (tokens, cloud keys, `PYTHONPATH`…) stays out. `PATH` is Claude's own.
pub fn sandbox_env_allowlist(vars: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    const KEEP: [&str; 26] = [
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "TZ",
        "CLAUDE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "https_proxy",
        "http_proxy",
        "no_proxy",
        "all_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
    ];
    let mut out: Vec<(String, String)> = vars.filter(|(k, _)| KEEP.contains(&k.as_str()) || k.starts_with("LC_")).collect();
    if let Some(p) = crate::pty::child_path() {
        out.retain(|(k, _)| k != "PATH");
        out.push(("PATH".into(), p.to_string_lossy().to_string()));
    }
    out
}

// ------------------------------------------------------------ protocol

/// An image attached by the user, as the view sends it.
#[derive(Deserialize, Clone, Debug)]
pub struct Attachment {
    pub name: String,
    pub media_type: String,
    /// Base64, without the `data:` prefix.
    pub data: String,
}

/// The text Claude gets for a message: the user's, the models attached
/// (`ia_attach.rs`), and the images saved under `attachments/` — the
/// interactive prompt is one text argument, so images go by their file.
pub fn prompt_of(text: &str, models: &[StagedModel], images: &[String]) -> String {
    let mut s = crate::ia_attach::with_models(text, models);
    if !images.is_empty() {
        let files: Vec<String> = images.iter().map(|n| format!("attachments/{n}")).collect();
        if !s.is_empty() {
            s.push_str("\n\n");
        }
        s.push_str(&crate::t!("chat.attached_images", files = files.join(", ")));
    }
    s
}

/// The answer to a hook request, from the view's: a permission allowed as
/// asked (and from now on, with Claude's own suggested rules, when
/// `always`), or denied; a question answered by the choices made.
///
/// `input` carries an `AskUserQuestion`'s answers. Sandboxed, the web stays
/// asked each time, whatever the view sends.
pub fn decision(request: &Value, allow: bool, always: bool, input: Option<&Value>, sandbox: bool) -> Value {
    let tool = request["tool_name"].as_str().unwrap_or_default();
    if request["hook_event_name"] == "PreToolUse" {
        let answers: Vec<String> = input
            .and_then(|i| i["answers"].as_object())
            .into_iter()
            .flatten()
            .map(|(q, a)| format!("{q} → {}", a.as_str().unwrap_or_default()))
            .collect();
        return if allow && !answers.is_empty() {
            claude_pty::question_reply(&crate::t!("chat.question_answered", a = answers.join("; ")))
        } else {
            claude_pty::question_reply(&crate::t!("chat.question_unanswered"))
        };
    }
    let always = always && !(sandbox && WEB_TOOLS.contains(&tool));
    let rules = request.get("permission_suggestions").filter(|_| always);
    claude_pty::permission_decision(allow, None, rules, &crate::t!("chat.denied_by_user"))
}

/// Caps a tool result and drops image data, which the view does not need
/// (an image Claude read is a file of the workspace, shown from there).
fn slim_tool_result(content: &Value) -> Value {
    match content {
        Value::String(s) if s.chars().count() > RESULT_CAP => Value::String(s.chars().take(RESULT_CAP).collect::<String>() + "…"),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|c| match c["type"].as_str() {
                    Some("image") => json!({ "type": "image" }),
                    Some("text") => json!({ "type": "text", "text": slim_tool_result(&c["text"]) }),
                    _ => c.clone(),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Message content without what the view never shows: thinking signatures,
/// image data, tool results beyond the cap.
pub(crate) fn slim_content(content: &Value) -> Value {
    match content {
        Value::Array(blocks) => Value::Array(
            blocks
                .iter()
                .map(|b| match b["type"].as_str() {
                    Some("thinking" | "redacted_thinking") => json!({ "type": "thinking" }),
                    Some("image") => json!({ "type": "image" }),
                    Some("tool_result") => {
                        let mut r = b.clone();
                        r["content"] = slim_tool_result(&b["content"]);
                        if let Some(o) = r.as_object_mut() {
                            o.remove("tool_use_result");
                        }
                        r
                    }
                    Some("tool_use") => json!({ "type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"] }),
                    _ => b.clone(),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Whether a view event goes to the log too.
fn logged(view: &Value) -> bool {
    !matches!(view["type"].as_str(), Some("auth_failed" | "exited"))
}

// ------------------------------------------------------------ log and history

pub fn log_path(ws: &Path) -> PathBuf {
    ws.join("chat.jsonl")
}

pub fn attachments_dir(ws: &Path) -> PathBuf {
    ws.join("attachments")
}

/// Where a container's hook files go (see [`CONTAINER_RUN`]).
pub fn run_dir(ws: &Path) -> PathBuf {
    ws.join(CONTAINER_RUN)
}

/// Appends events to a conversation's log.
pub fn log_append(ws: &Path, events: &[Value]) {
    if events.is_empty() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path(ws)) else {
        return;
    };
    let mut buf = String::new();
    for e in events {
        buf.push_str(&e.to_string());
        buf.push('\n');
    }
    let _ = f.write_all(buf.as_bytes());
}

/// A transcript turned into view events: the user's messages and the answers
/// with their tools, without sub-agents (`isSidechain`), meta records
/// (`isMeta`) nor the "No response requested." Claude adds after an
/// interrupt.
pub fn from_transcript(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut after_interrupt = false;
    for record in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let ty = record["type"].as_str().unwrap_or_default();
        if !matches!(ty, "user" | "assistant") || record["isSidechain"] == true || record["isMeta"] == true {
            continue;
        }
        let content = &record["message"]["content"];
        let text_of = |c: &Value| -> String {
            match c {
                Value::String(s) => s.clone(),
                Value::Array(b) => b.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(""),
                _ => String::new(),
            }
        };
        if ty == "user" && text_of(content).starts_with(claude_pty::INTERRUPTED) {
            after_interrupt = true;
            out.push(json!({ "type": "result", "subtype": "error_during_execution", "is_error": true }));
            continue;
        }
        if ty == "assistant" && after_interrupt && text_of(content) == "No response requested." {
            after_interrupt = false;
            continue;
        }
        after_interrupt = false;
        let content = match content {
            Value::String(s) => json!([{ "type": "text", "text": s }]),
            other => slim_content(other),
        };
        out.push(json!({ "type": ty, "message": { "id": record["message"]["id"], "content": content } }));
    }
    out
}

/// Claude's transcript of a session, wherever its project folder is.
fn transcript_path(id: &str) -> Option<PathBuf> {
    let p = crate::ia::session_file(id);
    if p.is_file() {
        return Some(p);
    }
    crate::ia::claude_roots().into_iter().find_map(|root| {
        std::fs::read_dir(root.join("projects"))
            .ok()?
            .filter_map(Result::ok)
            .map(|e| e.path().join(format!("{id}.jsonl")))
            .find(|p| p.is_file())
    })
}

/// The past of a conversation: our log, or — for a conversation from before
/// it — Claude's transcript.
pub fn history_of(ws: &Path, transcript: Option<&Path>) -> Vec<Value> {
    if let Ok(text) = std::fs::read_to_string(log_path(ws)) {
        return text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    }
    transcript.and_then(|p| std::fs::read_to_string(p).ok()).map(|t| from_transcript(&t)).unwrap_or_default()
}

pub fn history(id: &str) -> Vec<Value> {
    history_of(&crate::ia::workspace(id), transcript_path(id).as_deref())
}

/// File name of an attachment in the workspace: numbered, without any path.
/// Also used for the models of `sources/` (ia_attach.rs).
pub(crate) fn attachment_name(dir: &Path, name: &str) -> String {
    let clean: String = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
        .collect();
    let clean = if clean.trim_matches('-').is_empty() { "image.png".to_string() } else { clean };
    // One past the highest number in the folder, not the count of files:
    // after a deletion, a count would give a number already used by an
    // attachment the log still points at (and `seen-*.png` live here too).
    let n = std::fs::read_dir(dir)
        .map(|d| {
            d.flatten().filter_map(|e| e.file_name().to_str().and_then(|s| s.split('-').next()?.parse::<u32>().ok())).max().unwrap_or(0)
        })
        .unwrap_or(0)
        + 1;
    format!("{n:03}-{clean}")
}

/// Saves the attachments and returns the user message as the log keeps it
/// (file names instead of data), with the names of the images saved.
/// Models, already copied into `sources/`, are kept by name with what their
/// chip shows.
fn save_attachments(ws: &Path, text: &str, images: &[Attachment], models: &[StagedModel]) -> (Value, Vec<String>) {
    let dir = attachments_dir(ws);
    let _ = std::fs::create_dir_all(&dir);
    let mut content: Vec<Value> = Vec::new();
    let mut names = Vec::new();
    for a in images {
        let name = attachment_name(&dir, &a.name);
        if let Some(bytes) = crate::util::b64_decode(&a.data) {
            if std::fs::write(dir.join(&name), bytes).is_ok() {
                names.push(name.clone());
            }
        }
        content.push(json!({ "type": "attachment", "name": name, "media_type": a.media_type }));
    }
    for m in models {
        content.push(json!({
            "type": "model",
            "name": m.name,
            "original": m.original,
            "tris": m.tris,
            "parts": m.parts,
            "size_mm": m.size_mm,
        }));
    }
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    (json!({ "type": "user", "message": { "content": content } }), names)
}

// ------------------------------------------------------------ sessions

/// Previews Claude looks at: `Read` calls on `preview/*.png`, by tool id,
/// until their result arrives.
#[derive(Default)]
struct Glances(HashMap<String, PathBuf>);

impl Glances {
    /// Notes the `Read` calls of an assistant event that open a preview.
    fn watch(&mut self, ws: &Path, event: &Value) {
        if event["type"] != "assistant" {
            return;
        }
        for b in event["message"]["content"].as_array().into_iter().flatten() {
            let path = b["input"]["file_path"].as_str().map(PathBuf::from);
            let Some(path) = path.filter(|_| b["type"] == "tool_use" && b["name"] == "Read") else {
                continue;
            };
            let preview = crate::ia::previews_dir_of(ws);
            if path.parent() == Some(preview.as_path()) && path.extension().is_some_and(|e| e == "png") {
                if let Some(id) = b["id"].as_str() {
                    self.0.insert(id.to_string(), path);
                }
            }
        }
    }

    /// For the tool results of a user event: the preview as Claude saw it,
    /// copied into `attachments/` (the preview itself changes with the next
    /// version), as a `seen` event for the view and the log.
    fn seen(&mut self, ws: &Path, event: &Value) -> Vec<Value> {
        if event["type"] != "user" {
            return Vec::new();
        }
        let mut out = Vec::new();
        for b in event["message"]["content"].as_array().into_iter().flatten() {
            let Some(tid) = b["tool_use_id"].as_str() else { continue };
            let Some(src) = self.0.remove(tid) else { continue };
            if b["is_error"] == true {
                continue;
            }
            let safe: String = tid.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            let name = format!("seen-{safe}.png");
            let dir = attachments_dir(ws);
            if std::fs::create_dir_all(&dir).is_ok() && std::fs::copy(&src, dir.join(&name)).is_ok() {
                out.push(json!({ "type": "seen", "tool_use_id": tid, "name": name }));
            }
        }
        out
    }
}

/// Conversations whose Claude restarts once its turn ends: a refused
/// sign-in (the process keeps the credentials it started with), a model
/// changed while it answered.
fn restarts() -> &'static Mutex<HashSet<String>> {
    static R: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Closes a conversation's Claude off the caller's thread (the engine's
/// poller calls the listener).
fn close_later(id: &str) {
    // Closing from now on: a message sent right after starts a new Claude.
    claude_pty::retire(id);
    let id = id.to_string();
    std::thread::spawn(move || close(&id));
}

/// The listener of a conversation in the app: to the view, and to the log.
/// `sandbox`: a write outside the folder is denied before it reaches the
/// view, the web is asked each time.
fn app_listener(app: &AppHandle, id: &str, sandbox: bool) -> claude_pty::Listener {
    let app = app.clone();
    let id = id.to_string();
    let ws = crate::ia::workspace(&id);
    let glances = Mutex::new(Glances::default());
    Arc::new(move |mut event: Value| {
        match event["type"].as_str() {
            Some("control_request") => {
                let rid = event["request_id"].as_str().unwrap_or_default().to_string();
                let req = json!({ "tool_name": event["request"]["tool_name"], "input": event["request"]["input"] });
                if let Some(deny) = sandbox.then(|| sandbox_answer(&req, &ws)).flatten() {
                    let msg = deny["message"].as_str().unwrap_or_default().to_string();
                    let _ = claude_pty::answer(&id, &rid, &claude_pty::permission_decision(false, None, None, &msg));
                    return;
                }
                if sandbox && WEB_TOOLS.contains(&event["request"]["tool_name"].as_str().unwrap_or("")) {
                    event["request"]["can_always"] = json!(false);
                }
            }
            Some("auth_failed") => {
                restarts().lock().unwrap().insert(id.clone());
            }
            Some("result") if restarts().lock().unwrap().remove(&id) => close_later(&id),
            Some("exited") => {
                crate::ia::watch_stop(&id);
                // Ended before its answer: nothing left to restart.
                restarts().lock().unwrap().remove(&id);
                // A sandbox that cannot start (bubblewrap missing, refused by
                // AppArmor…): Claude stops at once, never unsandboxed; said
                // in words.
                let failed = event["code"].as_i64().is_some_and(|c| c != 0);
                if sandbox && failed && event["stderr"].as_str().is_some_and(|s| s.to_ascii_lowercase().contains("sandbox")) {
                    event["message"] = json!(crate::t!("err.sandbox_unavailable"));
                }
            }
            _ => {}
        }
        let mut events = vec![event];
        {
            let mut g = glances.lock().unwrap();
            g.watch(&ws, &events[0]);
            let seen = g.seen(&ws, &events[0]);
            events.extend(seen);
        }
        let kept: Vec<Value> = events.iter().filter(|e| logged(e)).cloned().collect();
        log_append(&ws, &kept);
        let _ = app.emit("ia-chat", json!({ "id": id, "events": events }));
    })
}

/// Conversations whose Terminal tab is shown: only they get the terminal's
/// bytes (Claude redraws its screen many times a second).
fn viewed() -> &'static Mutex<HashSet<String>> {
    static V: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The Terminal tab of `id` shown or left.
pub fn set_viewed(id: &str, on: bool) {
    let mut v = viewed().lock().unwrap();
    if on {
        v.insert(id.to_string());
    } else {
        v.remove(id);
    }
}

/// The terminal's bytes, for the Terminal tab while it is shown.
fn app_screen(app: &AppHandle, id: &str) -> claude_pty::Screen {
    let app = app.clone();
    let id = id.to_string();
    Arc::new(move |bytes: &[u8]| {
        if viewed().lock().unwrap().contains(&id) {
            let _ = app.emit("ia-screen", json!({ "id": id, "b64": crate::util::b64_encode(bytes) }));
        }
    })
}

pub fn is_open(id: &str) -> bool {
    claude_pty::is_open(id)
}

/// Sends a message: typed into the waiting CLI, or — no Claude running —
/// the prompt of a new one (a new session, or the resumed one). The message
/// is logged with its attachments saved in the workspace.
///
/// `models` are paths of the user's files: copied into `sources/` first, so
/// that one that can no longer be read stops the message before anything
/// leaves (the copies already made are removed, as when Claude can't start).
pub fn send(app: &AppHandle, c: &Conversation, text: &str, images: &[Attachment], models: &[PathBuf]) -> Result<()> {
    // Two simultaneous messages would start two Claudes on one session.
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _gate = GATE.get_or_init(|| Mutex::new(())).lock().unwrap();
    let ws = crate::ia::workspace(&c.id);
    if !ws.is_dir() {
        return Err(anyhow!(crate::t!("err.no_workspace")));
    }
    let mut staged: Vec<StagedModel> = Vec::new();
    let mut saved: Vec<String> = Vec::new();
    let undo = |staged: &[StagedModel], saved: &[String]| {
        for m in staged {
            let _ = std::fs::remove_file(ws.join(crate::ia_attach::SOURCES).join(&m.name));
        }
        for n in saved {
            let _ = std::fs::remove_file(attachments_dir(&ws).join(n));
        }
    };
    for p in models {
        match crate::ia_attach::stage_model(&ws, p) {
            Ok(m) => staged.push(m),
            Err(e) => {
                undo(&staged, &saved);
                return Err(e);
            }
        }
    }
    let (logged, names) = save_attachments(&ws, text, images, &staged);
    saved.extend(names.iter().cloned());
    let prompt = prompt_of(text, &staged, &names);
    let sent = if claude_pty::is_open(&c.id) { claude_pty::inject_prompt(&c.id, &prompt) } else { start(app, c, prompt) };
    if let Err(e) = sent {
        undo(&staged, &saved);
        return Err(e);
    }
    log_append(&ws, &[logged]);
    Ok(())
}

/// Starts the conversation's Claude with its first message.
fn start(app: &AppHandle, c: &Conversation, prompt: String) -> Result<()> {
    claude_pty::check_prompt(&prompt)?;
    let ws = crate::ia::workspace(&c.id);
    crate::ia::refresh_workspace(&c.id);
    // The interactive CLI asks to trust a new folder: ours is.
    if let Err(e) = claude_pty::pretrust(&ws) {
        eprintln!("[chat] folder not pre-trusted: {e}");
    }
    let l = launch(c, &Tools::detect(), crate::ia::has_session(&c.id), prompt)?;
    claude_pty::start(l, app_listener(app, &c.id, c.engine == "sandbox"), Some(app_screen(app, &c.id)))?;
    // What Claude writes is watched while it runs.
    let _ = crate::ia::watch_start(app.clone(), &c.id);
    crate::ia::mark_started(&c.id);
    Ok(())
}

/// Interrupts the current turn; the CLI stays for the next message.
pub fn stop(id: &str) -> Result<()> {
    if !claude_pty::is_open(id) {
        return Ok(());
    }
    claude_pty::interrupt(id)
}

/// Answers a permission request or a question, and logs the answer for the
/// history.
pub fn answer(id: &str, request_id: &str, allow: bool, always: bool, input: Option<Value>) -> Result<()> {
    let request = claude_pty::request(id, request_id).ok_or_else(|| anyhow!(crate::t!("err.request_gone")))?;
    let sandbox = crate::ia::get(id).is_ok_and(|c| c.engine == "sandbox");
    let d = decision(&request, allow, always, input.as_ref(), sandbox);
    claude_pty::answer(id, request_id, &d)?;
    let always = d["hookSpecificOutput"]["decision"].get("updatedPermissions").is_some();
    let answers = input.as_ref().map(|i| i["answers"].clone()).unwrap_or(Value::Null);
    log_append(
        &crate::ia::workspace(id),
        &[json!({ "type": "permission_answer", "request_id": request_id, "allow": allow, "always": always, "answers": answers })],
    );
    Ok(())
}

/// The terminal as shown so far, for a Terminal tab opened late (base64).
pub fn screen(id: &str) -> String {
    crate::util::b64_encode(&claude_pty::screen(id))
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<()> {
    claude_pty::resize(id, cols, rows)
}

/// Switches the conversation's model, kept for its next starts. A running
/// CLI is closed so the next message resumes with it — at once when idle,
/// once its turn ends otherwise. `None`: back to the account's default.
pub fn set_model(id: &str, model: Option<&str>) -> Result<()> {
    if let Some(m) = model {
        if !MODELS.contains(&m) {
            return Err(anyhow!("unknown model: {m}"));
        }
    }
    let mut c = crate::ia::get(id)?;
    c.model = model.map(String::from);
    crate::ia::save(&c)?;
    if claude_pty::is_busy(id) {
        restarts().lock().unwrap().insert(id.to_string());
    } else if claude_pty::is_open(id) {
        close(id);
    }
    Ok(())
}

/// Something of ours in the log, such as a new version of the object.
pub fn note(id: &str, event: Value) {
    let ws = crate::ia::workspace(id);
    if ws.is_dir() {
        log_append(&ws, &[event]);
    }
}

/// Ends the conversation's Claude. Nothing is lost: the next message resumes
/// the session from the transcript.
pub fn close(id: &str) {
    crate::ia::watch_stop(id);
    claude_pty::close(id);
}

/// Ends every conversation's Claude — when the app closes.
pub fn close_all() {
    claude_pty::close_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSCRIPT: &str = include_str!("../tests/fixtures/chat-transcript.jsonl");

    fn conv(engine: &str) -> Conversation {
        let mut c = crate::ia::tests_conversation();
        c.engine = engine.into();
        c
    }

    fn tools() -> Tools {
        Tools { claude: Some("/usr/local/bin/claude".into()), yolobox: Some("/usr/local/bin/yolobox".into()) }
    }

    fn argv_of(c: &Conversation, resume: bool) -> Vec<String> {
        let l = launch(c, &tools(), resume, "make it thicker".into()).unwrap();
        claude_pty::argv(&l, Path::new("/tmp/p.pid"))
    }

    #[test]
    fn local_command_line() {
        let argv = argv_of(&conv("local"), false);
        assert!(argv.contains(&"/usr/local/bin/claude".to_string()));
        assert!(!argv.iter().any(|a| a == "-p" || a == "--print" || a == "--input-format"), "never the print mode");
        assert!(argv.windows(2).any(|w| w[0] == "--session-id"));
        assert!(argv.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
        assert_eq!(argv.last().unwrap(), "make it thicker", "the first request is the positional prompt");
        let resumed = argv_of(&conv("local"), true);
        assert!(resumed.windows(2).any(|w| w[0] == "--resume"));
        assert!(!resumed.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn the_chosen_model_is_passed() {
        let mut c = conv("local");
        assert!(!argv_of(&c, false).contains(&"--model".to_string()));
        c.model = Some("claude-sonnet-5-5".into());
        let argv = argv_of(&c, true);
        let at = argv.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(argv[at + 1], "claude-sonnet-5-5");
        // Only known models reach the command line.
        c.model = Some("--dangerously-skip-permissions".into());
        assert!(!argv_of(&c, false).contains(&"--model".to_string()));
    }

    #[test]
    fn container_command_line() {
        let c = conv("container");
        let l = launch(&c, &tools(), false, "x".into()).unwrap();
        assert_eq!(&l.program[..2], ["/usr/local/bin/yolobox", "claude"]);
        assert!(l.program.contains(&"--claude-config".to_string()), "yolobox flags first");
        assert!(!l.args.iter().any(|a| a == "--permission-mode"), "the sandbox grants permissions");
        // Its hook files are where the container can write them.
        assert!(l.sentinel_dir.starts_with(crate::ia::workspace(&c.id)));
        let argv = claude_pty::argv(&l, Path::new("/tmp/p.pid"));
        assert!(!argv.iter().any(|a| a == "--"), "no separator");
    }

    /// Claude Code's built-in sandbox: Claude itself, its sandbox's settings
    /// with the hooks merged in, edits accepted, never the container's flags
    /// nor a skipped permission check.
    #[test]
    fn sandbox_command_line() {
        let l = launch(&conv("sandbox"), &tools(), false, "x".into()).unwrap();
        assert!(l.clean_env, "a reduced environment");
        let argv = claude_pty::argv(&l, Path::new("/tmp/p.pid"));
        assert!(argv.contains(&"/usr/local/bin/claude".to_string()) && !argv.iter().any(|a| a.contains("yolobox")));
        let at = argv.iter().position(|a| a == "--settings").expect("--settings");
        let settings: Value = serde_json::from_str(&argv[at + 1]).expect("valid JSON");
        assert_eq!(settings["sandbox"]["enabled"], true);
        assert!(settings["hooks"]["Stop"].is_array(), "hooks merged into the sandbox's settings");
        assert!(argv.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
        for no in ["--dangerously-skip-permissions", "--claude-config", "--customize-file"] {
            assert!(!argv.iter().any(|a| a == no), "{no}");
        }
        // The other modes carry the hooks only.
        let local = argv_of(&conv("local"), false);
        let at = local.iter().position(|a| a == "--settings").unwrap();
        assert!(serde_json::from_str::<Value>(&local[at + 1]).unwrap().get("sandbox").is_none());
    }

    #[test]
    fn images_go_by_their_file() {
        let p = prompt_of("look at this", &[], &["001-sketch.png".into(), "002-photo.jpg".into()]);
        assert!(p.starts_with("look at this\n\n"));
        assert!(p.contains("attachments/001-sketch.png, attachments/002-photo.jpg"), "{p}");
        assert_eq!(prompt_of("plain", &[], &[]), "plain");
        assert!(prompt_of("", &[], &["001-a.png".into()]).contains("attachments/001-a.png"));
    }

    #[test]
    fn answers_become_hook_decisions() {
        let request = json!({
            "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": { "command": "ls" },
            "permission_suggestions": [{ "type": "addRules" }],
        });
        let allowed = decision(&request, true, false, None, false);
        assert_eq!(allowed["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(allowed["hookSpecificOutput"]["decision"].get("updatedPermissions").is_none());
        let always = decision(&request, true, true, None, false);
        assert_eq!(always["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["type"], "addRules");
        let denied = decision(&request, false, false, None, false);
        assert_eq!(denied["hookSpecificOutput"]["decision"]["behavior"], "deny");
        // Sandboxed, the web stays asked each time, even when "always" is sent.
        let web =
            json!({ "hook_event_name": "PermissionRequest", "tool_name": "WebSearch", "permission_suggestions": [{ "type": "addRules" }] });
        assert!(decision(&web, true, true, None, true)["hookSpecificOutput"]["decision"].get("updatedPermissions").is_none());
        assert!(decision(&web, true, true, None, false)["hookSpecificOutput"]["decision"].get("updatedPermissions").is_some());
        // A question is answered by the choices made.
        let q = json!({ "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion" });
        let answered = decision(&q, true, false, Some(&json!({ "answers": { "Red or blue?": "Blue" } })), false);
        let reason = answered["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("Red or blue? → Blue"), "{reason}");
        let skipped = decision(&q, false, false, None, false);
        assert_ne!(skipped["hookSpecificOutput"]["permissionDecisionReason"], answered["hookSpecificOutput"]["permissionDecisionReason"]);
    }

    #[test]
    fn sandbox_settings_are_strict() {
        let ws = Path::new("/Users/me/.config/snap-studio/ia/abc/workspace");
        let read = vec![PathBuf::from("/Users/me/Library/Python/3.12")];
        let s = sandbox_settings(ws, &read);
        let sb = &s["sandbox"];
        assert_eq!(sb["enabled"], true);
        assert_eq!(sb["failIfUnavailable"], true, "never run commands unsandboxed");
        // `Bash` is allowed only because none of the commands can leave the
        // sandbox: these three go together.
        assert_eq!(sb["allowUnsandboxedCommands"], false);
        assert_eq!(sb["excludedCommands"], json!([]));
        assert!(s["permissions"]["allow"].as_array().unwrap().contains(&json!("Bash")));
        assert!(s["permissions"]["deny"].as_array().unwrap().contains(&json!("Bash(dangerouslyDisableSandbox:true)")));
        assert_eq!(sb["network"], json!({ "allowedDomains": [], "strictAllowlist": true }));
        assert_eq!(s["permissions"]["blockReadsOutsideWorkingDirectories"], true);
        // Every kept Anthropic variable is denied to commands.
        let denied: Vec<&str> = sb["credentials"]["envVars"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["mode"] == "deny")
            .filter_map(|v| v["name"].as_str())
            .collect();
        for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] {
            assert!(denied.contains(&k), "{k}");
        }
        // Extra folders are read, never written.
        assert_eq!(sb["filesystem"]["allowRead"], json!(["/Users/me/Library/Python/3.12"]));
        assert!(sb["filesystem"].get("allowWrite").is_none());
        // The workspace rules, absolute (`//`).
        assert!(s["permissions"]["allow"].as_array().unwrap().contains(&json!("Edit(//Users/me/.config/snap-studio/ia/abc/workspace/**)")));
        // No `~`, no relative path anywhere.
        let text = s.to_string();
        assert!(!text.contains('~'), "{text}");
        for p in sb["filesystem"]["allowRead"].as_array().unwrap() {
            assert!(Path::new(p.as_str().unwrap()).is_absolute());
        }
    }

    #[cfg(unix)]
    #[test]
    fn sandbox_answer_denies_writes_outside() {
        let root = std::env::temp_dir().join(format!("snapstudio-sb-answer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ws = root.join("workspace");
        std::fs::create_dir_all(ws.join("out")).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), ws.join("link")).unwrap();
        let req = |tool: &str, path: &str| json!({ "tool_name": tool, "input": { "file_path": path } });
        let inside = ws.join("out/model.py").to_string_lossy().to_string();
        assert!(sandbox_answer(&req("Write", &inside), &ws).is_none(), "inside: the usual flow");
        assert!(sandbox_answer(&req("Edit", "out/new.py"), &ws).is_none(), "relative, inside");
        for out in [
            root.join("elsewhere/x.py").to_string_lossy().to_string(),
            ws.join("../elsewhere/x.py").to_string_lossy().to_string(),
            ws.join("link/x.py").to_string_lossy().to_string(),
            "/etc/hosts".to_string(),
        ] {
            let a = sandbox_answer(&req("Write", &out), &ws).unwrap_or_else(|| panic!("{out}: allowed"));
            assert_eq!(a["behavior"], "deny", "{out}");
        }
        assert_eq!(
            sandbox_answer(&json!({ "tool_name": "NotebookEdit", "input": { "notebook_path": "/tmp/n.ipynb" } }), &ws).unwrap()["behavior"],
            "deny"
        );
        // Other tools: not this guard's business.
        for tool in ["Bash", "WebSearch", "AskUserQuestion", "Read"] {
            assert!(sandbox_answer(&req(tool, "/etc/hosts"), &ws).is_none(), "{tool}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sandbox_env_is_reduced() {
        let vars = [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "HTTPS_PROXY",
            "CLAUDE_CONFIG_DIR",
            "CLAUDECODE",
            "GITHUB_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "ANTHROPIC_API_KEY",
            "PYTHONPATH",
        ]
        .map(|k| (k.to_string(), format!("value-of-{k}")));
        let out = sandbox_env_allowlist(vars.into_iter());
        let keys: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        for k in ["HOME", "LANG", "LC_ALL", "HTTPS_PROXY", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "PATH"] {
            assert!(keys.contains(&k), "{k} kept");
        }
        for k in ["CLAUDECODE", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "PYTHONPATH"] {
            assert!(!keys.contains(&k), "{k} dropped");
        }
        let path = &out.iter().find(|(k, _)| k == "PATH").unwrap().1;
        assert_eq!(Some(path.as_str()), crate::pty::child_path().as_deref().and_then(|p| p.to_str()), "Claude's own PATH");
        // Every Anthropic variable kept for Claude is hidden from its commands.
        let denied = sandbox_settings(Path::new("/w"), &[]).to_string();
        for k in keys.iter().filter(|k| k.starts_with("ANTHROPIC_")) {
            assert!(denied.contains(&format!("\"{k}\"")), "{k} denied to commands");
        }
    }

    #[test]
    fn the_transcript_becomes_a_history() {
        let h = from_transcript(TRANSCRIPT);
        assert!(h.iter().all(|e| e["message"]["content"].is_array() || e["type"] == "result"));
        let texts: Vec<String> = h
            .iter()
            .flat_map(|e| e["message"]["content"].as_array().cloned().unwrap_or_default())
            .filter_map(|b| b["text"].as_str().map(String::from))
            .collect();
        assert!(texts.iter().any(|t| t.contains("hello from file")));
        assert!(!texts.iter().any(|t| t == "a sub-agent's turn"), "sub-agents stay out");
        assert!(!texts.iter().any(|t| t == "<meta>"), "meta records stay out");
        assert!(!texts.iter().any(|t| t == "No response requested."));
        assert!(!texts.iter().any(|t| t.starts_with(claude_pty::INTERRUPTED)));
        assert_eq!(h.iter().filter(|e| e["type"] == "result").count(), 1, "the interrupt shows as stopped");
    }

    /// A model is logged by its name in `sources/` and what its chip shows,
    /// never by the path of the user's file.
    #[test]
    fn models_are_logged_without_their_path() {
        let ws = std::env::temp_dir().join(format!("snapstudio-chat-models-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&ws).unwrap();
        let m =
            StagedModel { name: "001-bracket.3mf".into(), original: "bracket.stl".into(), tris: 12, parts: 1, size_mm: [40.0, 20.0, 10.0] };
        let (msg, _) = save_attachments(&ws, "thicker", &[], &[m]);
        let content = msg["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "model");
        assert_eq!(content[0]["name"], "001-bracket.3mf");
        assert_eq!(content[0]["original"], "bracket.stl");
        assert_eq!(content[0]["size_mm"][0], 40.0);
        assert_eq!(content[1]["text"], "thicker", "the user's own text, without the list sent to Claude");
        assert!(!msg.to_string().contains(&*ws.to_string_lossy()), "no path in the log");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn the_log_is_the_history_once_it_exists() {
        let ws = std::env::temp_dir().join(format!("snapstudio-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&ws).unwrap();
        let tr = ws.join("t.jsonl");
        std::fs::write(&tr, TRANSCRIPT).unwrap();
        assert!(!history_of(&ws, Some(&tr)).is_empty(), "no log yet: the transcript");

        let img = Attachment { name: "../../evil sketch.png".into(), media_type: "image/png".into(), data: "iVBORw0K".into() };
        let (msg, names) = save_attachments(&ws, "hello", &[img], &[]);
        assert_eq!(names, ["001-evil-sketch.png"]);
        log_append(&ws, &[msg, json!({ "type": "result", "subtype": "success" })]);
        let h = history_of(&ws, Some(&tr));
        assert_eq!(h.len(), 2, "the log wins over the transcript");
        let name = h[0]["message"]["content"][0]["name"].as_str().unwrap();
        assert_eq!(name, "001-evil-sketch.png", "no path, no spaces");
        assert!(attachments_dir(&ws).join(name).is_file());
        assert!(!log_path(&ws).with_file_name("x").exists());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn previews_claude_reads_are_kept_as_seen() {
        let ws = std::env::temp_dir().join(format!("snapstudio-glance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        let preview = crate::ia::previews_dir_of(&ws);
        std::fs::create_dir_all(&preview).unwrap();
        std::fs::write(preview.join("front.png"), b"png").unwrap();
        let mut g = Glances::default();
        let read = |id: &str, path: &Path| {
            json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": id, "name": "Read", "input": { "file_path": path } } ] } })
        };
        g.watch(&ws, &read("toolu_1", &preview.join("front.png")));
        g.watch(&ws, &read("toolu_2", &ws.join("model.py")));
        let result = |id: &str| {
            json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": id, "content": [{ "type": "image" }] } ] } })
        };
        let seen = g.seen(&ws, &result("toolu_1"));
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["name"], "seen-toolu_1.png");
        assert!(attachments_dir(&ws).join("seen-toolu_1.png").is_file());
        assert!(g.seen(&ws, &result("toolu_2")).is_empty(), "not a preview");
        assert!(g.seen(&ws, &result("toolu_1")).is_empty(), "only once");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn long_tool_results_are_capped() {
        let big = "x".repeat(RESULT_CAP + 10);
        let c = slim_content(&json!([{ "type": "tool_result", "tool_use_id": "t", "content": big }]));
        assert_eq!(c[0]["content"].as_str().unwrap().chars().count(), RESULT_CAP + 1);
    }

    /// Runs a real Claude through the app's own launch for `c`, collecting
    /// its view events.
    fn real_session(c: &Conversation, prompt: &str) -> Arc<Mutex<Vec<Value>>> {
        let ws = crate::ia::workspace(&c.id);
        std::fs::create_dir_all(&ws).unwrap();
        claude_pty::pretrust(&ws).unwrap();
        let l = launch(c, &Tools::detect(), false, prompt.into()).unwrap();
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = got.clone();
        claude_pty::start(l, Arc::new(move |e| sink.lock().unwrap().push(e)), None).unwrap();
        got
    }

    fn wait_for(got: &Mutex<Vec<Value>>, secs: u64, pred: &dyn Fn(&[Value]) -> bool) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while !pred(&got.lock().unwrap()) && std::time::Instant::now() < end {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    /// The whole loop against the real Claude Code, in its interactive mode
    /// (a few cents): a permission card, a second message typed into the
    /// same CLI, a question, an interrupt.
    /// `CHAT_REAL=1 cargo test --lib real_claude_round_trip -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_claude_round_trip() {
        if std::env::var("CHAT_REAL").is_err() {
            return;
        }
        let mut c = conv("local");
        c.id = uuid::Uuid::new_v4().to_string();
        c.model = Some("claude-haiku-4-5-20251001".into());
        let ws = crate::ia::workspace(&c.id);
        let got =
            real_session(&c, "Run exactly `python3 -c \"open('proof.txt','w').write('real-ok')\"` with the Bash tool, then say done.");
        wait_for(&got, 120, &|e| e.iter().any(|x| x["type"] == "control_request"));
        let rid = got.lock().unwrap().iter().find(|x| x["type"] == "control_request").expect("a permission card")["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        let req = claude_pty::request(&c.id, &rid).unwrap();
        claude_pty::answer(&c.id, &rid, &decision(&req, true, false, None, false)).unwrap();
        wait_for(&got, 120, &|e| e.iter().any(|x| x["type"] == "result"));
        assert_eq!(std::fs::read_to_string(ws.join("proof.txt")).unwrap().trim(), "real-ok");

        claude_pty::inject_prompt(
            &c.id,
            "Use the AskUserQuestion tool to ask me 'Red or blue?' (options Red, Blue),\nthen reply ANSWER=<my answer>.",
        )
        .unwrap();
        wait_for(&got, 120, &|e| e.iter().any(|x| x["request"]["tool_name"] == "AskUserQuestion"));
        let q = got.lock().unwrap().iter().find(|x| x["request"]["tool_name"] == "AskUserQuestion").unwrap()["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        let req = claude_pty::request(&c.id, &q).unwrap();
        claude_pty::answer(&c.id, &q, &decision(&req, true, false, Some(&json!({ "answers": { "Red or blue?": "Blue" } })), false))
            .unwrap();
        wait_for(&got, 120, &|e| e.iter().filter(|x| x["type"] == "result").count() >= 2);
        let said: String = got
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e["message"]["content"].as_array())
            .flatten()
            .filter_map(|b| b["text"].as_str())
            .collect();
        assert!(said.contains("ANSWER=Blue"), "{said}");

        // `sleep` runs without asking: interrupted while it runs.
        claude_pty::inject_prompt(&c.id, "Run `sleep 60` with the Bash tool.").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(12));
        claude_pty::interrupt(&c.id).unwrap();
        wait_for(&got, 30, &|e| e.iter().filter(|x| x["type"] == "result").count() >= 3);
        let last = got.lock().unwrap().iter().filter(|x| x["type"] == "result").last().cloned().unwrap();
        assert_eq!(last["subtype"], "error_during_execution", "{last}");
        close(&c.id);
        let events = got.lock().unwrap().clone();
        println!("{} events: {:?}", events.len(), events.iter().map(|e| e["type"].as_str().unwrap_or("")).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(crate::ia::dir(&c.id));
    }

    /// The built-in sandbox against the real Claude Code, through the app's
    /// own launch (settings with the hooks merged in, reduced environment):
    /// a command writes in its folder, cannot write the home, has no
    /// network. Costs a few cents:
    /// `IA_REAL=1 cargo test --lib real_builtin_sandbox -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_builtin_sandbox() {
        if std::env::var("IA_REAL").is_err() {
            return;
        }
        let home = dirs::home_dir().unwrap();
        let mut c = conv("sandbox");
        c.id = uuid::Uuid::new_v4().to_string();
        c.model = Some("claude-haiku-4-5-20251001".into());
        let ws = crate::ia::workspace(&c.id);
        let probe_home = home.join("snapstudio-sandbox-probe.txt");
        let prompt = format!(
            "Automated sandbox test. Use the Bash tool, one call per command, exactly these, no retries:\n\
             1. echo ok > inside.txt\n2. touch {}\n3. curl -sS -m 8 -o /dev/null https://example.com; echo curl=$?\nThen reply DONE.",
            probe_home.display()
        );
        let got = real_session(&c, &prompt);
        wait_for(&got, 240, &|e| e.iter().any(|x| x["type"] == "result" || x["type"] == "exited"));
        close(&c.id);
        let events = got.lock().unwrap().clone();
        let all: String = events
            .iter()
            .filter(|e| e["type"] == "user")
            .flat_map(|e| e["message"]["content"].as_array().cloned().unwrap_or_default())
            .map(|b| b["content"].to_string())
            .collect();
        let inside = std::fs::read_to_string(ws.join("inside.txt")).ok();
        let _ = std::fs::remove_dir_all(crate::ia::dir(&c.id));
        assert_eq!(inside.as_deref().map(str::trim), Some("ok"), "a command writes in its folder");
        assert!(!probe_home.exists(), "nothing written in the home");
        assert!(all.contains("curl=56") || all.contains("not on the allow list") || all.contains("curl=6"), "no network: {all}");
        assert!(!events.iter().any(|e| e["type"] == "control_request"), "sandboxed commands run without asking");
    }
}
