//! Snappy: the in-app workshop assistant.
//!
//! One persistent conversation with a durable memory, over the shared
//! Claude engine (`claude_pty.rs`) — a thin wrapper, no protocol of its
//! own. Snappy lives in `~/.config/snap-studio/snappy/`: its log
//! (`chat.jsonl`), its memory (`MEMORY.md`, written by Snappy itself), its
//! instructions, its session id. It runs only while the app is open.
//!
//! Snappy gets none of Claude's own tools — no Bash, no file tools, no web:
//! it acts on the workshop only through the app's MCP server
//! (`snappy_mcp.rs`, tools in `snappy_tools.rs`), where actions that cannot
//! be undone wait for the user's explicit yes. Everything sent to the
//! model goes through the privacy filter (`privacy.rs`).

use crate::claude_pty::{self, Launch};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// The engine's key for Snappy's Claude.
pub const KEY: &str = "snappy";

/// `MEMORY.md`'s limits: about 200 lines, 24 KB.
pub const MEMORY_MAX_LINES: usize = 200;
pub const MEMORY_MAX_BYTES: usize = 24 * 1024;

/// How long a new Snappy waits for its MCP connection.
const MCP_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Claude's tools Snappy never gets, on top of `--tools ""`.
const DENIED_TOOLS: [&str; 10] = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "WebFetch", "WebSearch", "Task", "Glob"];

/// `~/.config/snap-studio/snappy`, beside Create's `ia/`.
pub fn root() -> PathBuf {
    let d = crate::ia::root().parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir).join("snappy");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn log_path() -> PathBuf {
    root().join("chat.jsonl")
}

pub fn memory_path() -> PathBuf {
    root().join("MEMORY.md")
}

fn instructions_path() -> PathBuf {
    root().join("INSTRUCTIONS.md")
}

fn state_path() -> PathBuf {
    root().join("state.json")
}

/// Where the hook files of Snappy's runs go.
fn sentinel_dir() -> PathBuf {
    claude_pty::host_sentinel_dir("snappy")
}

// ------------------------------------------------------------ identity

/// Who Snappy is, as the model reads it at launch: role, instructions,
/// the approval rule. Never the list of what it can do — the tools say
/// that themselves.
pub fn identity(lang: &str) -> String {
    format!(
        "You are Snappy, the workshop assistant built into Snap Studio, a desktop app for 3D printing with Snapmaker \
printers (preparing, slicing, sending and following prints).\n\
\n\
- Answer in the user's language ({lang} unless they write in another one). In French, address the user as « vous ».\n\
- Be brief and concrete. You act on the workshop only through the snap-studio tools; describe what you will do \
before an action.\n\
- Every tool you use asks the user for confirmation in the app first, reads included. A refusal, a closed panel or \
no answer means no: say so, and do not retry unless asked. Use only the tools the request needs.\n\
- Files stored on a printer and files on this computer are different things: when a request does not say which, ask.\n\
- Long operations return a task id: follow it with the task tools, or cancel it.\n\
- Printers and files are named by their display names. Never ask for, repeat or store serial numbers, IP \
addresses, hostnames or file paths.\n\
- Your memory is MEMORY.md, read and written with the memory tools: keep what is worth remembering across \
conversations (the user's printers by name, preferences, recurring settings), short. Each message also carries \
your memory and the app's current context.\n"
    )
}

/// The instructions file, written for the user to see what Snappy is told.
fn write_instructions(lang: &str) {
    let _ = std::fs::write(instructions_path(), identity(lang));
}

// ------------------------------------------------------------ memory

/// Snappy's memory, filtered (as any text sent to the model).
pub fn memory() -> String {
    let raw = std::fs::read_to_string(memory_path()).unwrap_or_default();
    crate::privacy::text(&raw, &crate::privacy::known())
}

/// Replaces the memory with `content`, filtered, within its limits.
pub fn set_memory(content: &str) -> Result<()> {
    let clean = checked_memory(content, &crate::privacy::known())?;
    crate::util::write_atomic(&memory_path(), clean.as_bytes())
}

/// The memory as it may be saved: filtered, and refused past its limits
/// (Snappy is told to condense it).
fn checked_memory(content: &str, known: &[String]) -> Result<String> {
    let clean = crate::privacy::text(content, known);
    let lines = clean.lines().count();
    if lines > MEMORY_MAX_LINES || clean.len() > MEMORY_MAX_BYTES {
        return Err(anyhow!(
            "MEMORY.md is limited to {MEMORY_MAX_LINES} lines and {} KB ({lines} lines, {} bytes given): condense it.",
            MEMORY_MAX_BYTES / 1024,
            clean.len()
        ));
    }
    Ok(clean)
}

// ------------------------------------------------------------ messages

/// The text Claude gets for a user message: the app's context and the
/// memory first (`--append-system-prompt` only applies at launch, and the
/// CLI stays open), then the message.
pub fn turn_text(text: &str, context: &Value) -> String {
    let known = crate::privacy::known();
    let ctx = crate::privacy::json(context, &known);
    let memory = memory();
    let memory = if memory.trim().is_empty() { "(empty)".to_string() } else { memory };
    format!("<snap-studio-context>\n{}\n</snap-studio-context>\n<memory>\n{}\n</memory>\n\n{}", ctx, memory.trim_end(), text)
}

/// The user's message as the log keeps it.
fn logged_message(text: &str) -> Value {
    json!({ "type": "user", "message": { "content": [{ "type": "text", "text": text }] } })
}

fn log_append(events: &[Value]) {
    if events.is_empty() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path()) else { return };
    let mut buf = String::new();
    for e in events {
        buf.push_str(&e.to_string());
        buf.push('\n');
    }
    let _ = f.write_all(buf.as_bytes());
}

/// The conversation so far, for the drawer.
pub fn history() -> Vec<Value> {
    std::fs::read_to_string(log_path()).map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()).unwrap_or_default()
}

// ------------------------------------------------------------ session

/// Snappy's Claude session id, kept across launches.
fn session_id() -> String {
    let mut st = state();
    if let Some(id) = st["session_id"].as_str().filter(|s| uuid::Uuid::parse_str(s).is_ok()) {
        return id.to_string();
    }
    let id = uuid::Uuid::new_v4().to_string();
    st["session_id"] = json!(id);
    save_state(&st);
    id
}

/// What Snappy keeps besides its conversation: its session id, its model.
fn state() -> Value {
    std::fs::read(state_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save_state(st: &Value) {
    let _ = crate::util::write_atomic(&state_path(), st.to_string().as_bytes());
}

/// Snappy's model (Settings › AI); none: the account's default.
pub fn model() -> Option<String> {
    state()["model"].as_str().filter(|m| crate::chat::MODELS.contains(m)).map(String::from)
}

/// Sets Snappy's model. A running Snappy closes so its next message
/// resumes with it — at once when idle, once its answer ends otherwise.
pub fn set_model(model: Option<&str>) -> Result<()> {
    if let Some(m) = model {
        if !crate::chat::MODELS.contains(&m) {
            return Err(anyhow!("unknown model: {m}"));
        }
    }
    let mut st = state();
    st["model"] = model.map(|m| json!(m)).unwrap_or(Value::Null);
    save_state(&st);
    if claude_pty::is_busy(KEY) {
        RESTART.store(true, std::sync::atomic::Ordering::SeqCst);
    } else if claude_pty::is_open(KEY) {
        crate::snappy_tools::refuse_all();
        claude_pty::close(KEY);
    }
    Ok(())
}

/// Close once the answer ends (the model changed meanwhile).
static RESTART: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The app's handle, for the events and the tools.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

fn emit(events: Vec<Value>) {
    if let Some(app) = app() {
        let _ = app.emit("snappy-chat", json!({ "events": events }));
    }
}

/// The view's events, logged; anything asked through Claude's own
/// permission prompt is refused (Snappy's approvals are the app's).
fn listener() -> claude_pty::Listener {
    Arc::new(move |event: Value| {
        if event["type"] == "control_request" {
            if let Some(rid) = event["request_id"].as_str() {
                let deny = claude_pty::permission_decision(false, None, None, &crate::t!("chat.denied_by_user"));
                let _ = claude_pty::answer(KEY, rid, &deny);
            }
            return;
        }
        if event["type"] == "exited" {
            crate::snappy_tools::refuse_all();
        }
        if event["type"] == "result" && RESTART.swap(false, std::sync::atomic::Ordering::SeqCst) {
            std::thread::spawn(|| claude_pty::close(KEY));
        }
        if !matches!(event["type"].as_str(), Some("exited" | "auth_failed")) {
            log_append(std::slice::from_ref(&event));
        }
        emit(vec![event]);
    })
}

/// How Snappy's Claude starts: host Claude in Snappy's folder, none of its
/// own tools, the app's MCP server only (its config in a `0600` file),
/// whose tools need no prompt — the approvals are the server's.
pub fn launch(claude: &Path, mcp_config: &Path, session_id: &str, resume: bool, prompt: String, lang: &str, model: Option<&str>) -> Launch {
    let dir = root();
    let mut args: Vec<String> = vec![
        "--tools".into(),
        String::new(),
        "--disallowedTools".into(),
        DENIED_TOOLS.join(","),
        "--strict-mcp-config".into(),
        "--mcp-config".into(),
        mcp_config.to_string_lossy().to_string(),
        "--allowedTools".into(),
        format!("mcp__{}", crate::snappy_mcp::SERVER),
        "--permission-mode".into(),
        "default".into(),
        "--append-system-prompt".into(),
        identity(lang),
    ];
    if let Some(m) = model.filter(|m| crate::chat::MODELS.contains(m)) {
        args.push("--model".into());
        args.push(m.to_string());
    }
    Launch {
        key: KEY.into(),
        program: vec![claude.to_string_lossy().to_string()],
        args,
        settings: json!({ "permissions": { "deny": DENIED_TOOLS } }),
        session_id: session_id.into(),
        resume,
        prompt,
        cwd: dir.clone(),
        envs: Vec::new(),
        clean_env: false,
        sentinel_dir: sentinel_dir(),
        transcript: crate::ia::session_file_in(&dir, session_id),
        ask: true,
    }
}

pub fn is_busy() -> bool {
    claude_pty::is_busy(KEY)
}

/// Sends a message with the app's `context`: typed into the waiting CLI, or
/// the prompt of a new one (Snappy's session resumed when it exists).
pub fn send(text: &str, context: &Value) -> Result<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _gate = GATE.get_or_init(|| Mutex::new(())).lock().unwrap();
    if text.trim().is_empty() {
        return Ok(());
    }
    let prompt = turn_text(text, context);
    claude_pty::check_prompt(&prompt)?;
    if claude_pty::is_open(KEY) {
        claude_pty::inject_prompt(KEY, &prompt)?;
    } else {
        let claude = crate::util::which("claude").ok_or_else(|| anyhow!(crate::t!("err.no_claude")))?;
        let mcp = crate::snappy_mcp::ensure_started()?;
        let dir = root();
        let lang = crate::i18n::lang();
        write_instructions(&lang);
        if let Err(e) = claude_pty::pretrust(&dir) {
            eprintln!("[snappy] folder not pre-trusted: {e}");
        }
        let id = session_id();
        let resume = crate::ia::session_file_in(&dir, &id).is_file();
        // Claude connects to its MCP servers after it starts: the message
        // waits for the tools, then is typed in, rather than leave as the
        // launch prompt without them.
        crate::snappy_mcp::reset_listed();
        claude_pty::start(launch(&claude, &mcp, &id, resume, String::new(), &lang, model().as_deref()), listener(), None)?;
        if !crate::snappy_mcp::wait_listed(MCP_WAIT) {
            eprintln!("[snappy] the tools were not listed in time");
        }
        claude_pty::inject_prompt(KEY, &prompt)?;
    }
    log_append(&[logged_message(text)]);
    Ok(())
}

pub fn stop() -> Result<()> {
    crate::snappy_tools::refuse_all();
    if claude_pty::is_open(KEY) {
        claude_pty::interrupt(KEY)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Snappy against the real Claude Code, through the app's MCP server (a
    /// few cents): it calls a read tool, then a refused action changes
    /// nothing. Its folder lives under `XDG_CONFIG_HOME`:
    /// `SNAPPY_REAL=1 XDG_CONFIG_HOME=… cargo test --lib real_snappy -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_snappy_uses_its_tools() {
        if std::env::var("SNAPPY_REAL").is_err() {
            return;
        }
        let _ = std::fs::remove_file(log_path());
        let _ = std::fs::remove_file(state_path());
        std::fs::write(memory_path(), "- The user prints mostly PETG.\n").unwrap();
        let wait = |n: usize| {
            let end = std::time::Instant::now() + std::time::Duration::from_secs(150);
            while history().iter().filter(|e| e["type"] == "result").count() < n && std::time::Instant::now() < end {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        };
        // Every tool asks first: the user says yes to the read.
        crate::snappy_tools::set_drawer(true);
        let yes = std::thread::spawn(|| {
            let end = std::time::Instant::now() + std::time::Duration::from_secs(150);
            while std::time::Instant::now() < end {
                if let Some(id) = crate::snappy_tools::waiting().pop() {
                    crate::snappy_tools::answer(&id, true);
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            false
        });
        send("Use your memory_read tool, then tell me in one sentence which material I print most.", &json!({ "view": "prepare" }))
            .unwrap();
        wait(1);
        assert!(yes.join().unwrap(), "the read asked first");
        let h = history();
        let tools: Vec<String> = h
            .iter()
            .filter(|e| e["type"] == "assistant")
            .flat_map(|e| e["message"]["content"].as_array().cloned().unwrap_or_default())
            .filter_map(|b| b["name"].as_str().map(String::from))
            .collect();
        let said: String = h
            .iter()
            .filter(|e| e["type"] == "assistant")
            .flat_map(|e| e["message"]["content"].as_array().cloned().unwrap_or_default())
            .filter_map(|b| b["text"].as_str().map(String::from))
            .collect();
        println!("tools: {tools:?}\nsaid: {said}");
        assert!(tools.iter().any(|t| t == "mcp__snap-studio__memory_read"), "{tools:?}");
        assert!(said.contains("PETG"), "{said}");
        // An action with the drawer closed: refused, nothing done.
        crate::snappy_tools::set_drawer(false);
        send("Use apply_slice_setting to set infill to 40. Then tell me if it worked, in one sentence.", &json!({})).unwrap();
        wait(2);
        let h = history();
        let results: String = h
            .iter()
            .filter(|e| e["type"] == "user")
            .flat_map(|e| e["message"]["content"].as_array().cloned().unwrap_or_default())
            .map(|b| b["content"].to_string())
            .collect();
        println!("results: {results}");
        assert!(results.contains("did not approve"), "{results}");
        claude_pty::close(KEY);
    }

    #[test]
    fn snappy_gets_no_tool_of_its_own() {
        let l = launch(
            Path::new("/usr/local/bin/claude"),
            Path::new("/x/mcp.json"),
            "11111111-2222-3333-4444-555555555555",
            false,
            "hi".into(),
            "fr",
            None,
        );
        let at = l.args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(l.args[at + 1], "", "no built-in tool");
        assert!(l
            .args
            .windows(2)
            .any(|w| w[0] == "--disallowedTools" && w[1].contains("Bash") && w[1].contains("Write") && w[1].contains("WebFetch")));
        assert!(l.args.contains(&"--strict-mcp-config".to_string()), "no other MCP server");
        assert!(l.args.windows(2).any(|w| w == ["--allowedTools", "mcp__snap-studio"]));
        assert_eq!(l.settings["permissions"]["deny"][0], "Bash");
        // The MCP config is a file, its token never on the command line.
        let argv = claude_pty::argv(&l, Path::new("/tmp/p.pid"));
        assert!(argv.windows(2).any(|w| w == ["--mcp-config", "/x/mcp.json"]));
        assert!(!argv.iter().any(|a| a.contains("Bearer")));
        assert!(!argv.iter().any(|a| a == "-p" || a == "--print"));
        assert!(l.cwd.ends_with("snap-studio/snappy"));
        assert!(!l.args.contains(&"--model".to_string()), "the account's default");
        let m = launch(
            Path::new("/c"),
            Path::new("/m"),
            "11111111-2222-3333-4444-555555555555",
            false,
            String::new(),
            "fr",
            Some("claude-haiku-4-5-20251001"),
        );
        assert!(m.args.windows(2).any(|w| w == ["--model", "claude-haiku-4-5-20251001"]));
        let bad = launch(
            Path::new("/c"),
            Path::new("/m"),
            "11111111-2222-3333-4444-555555555555",
            false,
            String::new(),
            "fr",
            Some("--dangerously-skip-permissions"),
        );
        assert!(!bad.args.contains(&"--model".to_string()), "only known models");
    }

    #[test]
    fn the_identity_says_who_not_what() {
        let id = identity("fr");
        assert!(id.contains("Snappy") && id.contains("« vous »"));
        // Actions are described by the tools only.
        for tool in crate::snappy_tools::TOOLS.iter().filter(|t| t.name.contains('_')) {
            assert!(!id.contains(tool.name), "{}", tool.name);
        }
    }

    #[test]
    fn the_memory_is_capped_and_filtered() {
        let ok = checked_memory("- Workshop U1: PLA mostly\n- at 192.168.1.20\n", &[]).unwrap();
        assert!(ok.contains("Workshop U1") && !ok.contains("192.168"), "{ok}");
        assert!(checked_memory(&"line\n".repeat(MEMORY_MAX_LINES + 1), &[]).is_err(), "too many lines");
        assert!(checked_memory(&"x".repeat(MEMORY_MAX_BYTES + 1), &[]).is_err(), "too big");
        assert!(checked_memory(&"line\n".repeat(MEMORY_MAX_LINES), &[]).is_ok());
    }

    #[test]
    fn each_message_carries_context_and_memory_filtered() {
        let ctx = json!({ "view": "prepare", "printer": "Workshop U1", "host": "192.168.1.9", "note": "at 10.1.2.3" });
        let t = turn_text("Slice it", &ctx);
        assert!(t.contains("Workshop U1") && t.contains("prepare"));
        assert!(!t.contains("192.168.1.9") && !t.contains("10.1.2.3"), "{t}");
        assert!(t.ends_with("\n\nSlice it"));
        assert!(t.contains("<memory>"));
    }
}
