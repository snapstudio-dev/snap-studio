//! Snappy's tools: a static table, each with its declaration (name,
//! description, parameters), whether it needs the user's approval, and its
//! handler in Rust. Served by `snappy_mcp.rs`.
//!
//! Approval is a barrier on this side, not Claude's permission prompt: a
//! call to a tool marked so is held, a confirmation card shows at the
//! bottom of Snappy's drawer, and anything that is not an explicit yes is a
//! no — refused, the drawer closed (or not open), or no answer within 15
//! minutes.
//!
//! Every result goes through the privacy filter. Long operations (starting
//! a print, which uploads it first) answer at once with a task id, which
//! Snappy follows or cancels.

use crate::privacy;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

/// How long an approval waits for the user.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long the UI has to answer a question about what it shows.
const UI_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    /// The parameters' JSON schema (`inputSchema`).
    pub params: fn() -> Value,
    /// Held for the user's explicit yes.
    pub approval: bool,
    /// What the confirmation card says, the names resolved: also where the
    /// arguments are checked, before anyone is asked.
    pub ask: fn(&Value) -> Result<String>,
    pub run: fn(&Value) -> Result<Value>,
}

fn no_params() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn no_ask(_: &Value) -> Result<String> {
    Ok(String::new())
}

pub static TOOLS: &[Tool] = &[
    Tool {
        name: "printers",
        description: "The user's printers by display name: model, whether online, state (standby, printing, paused…), the current print's progress and time left, temperatures, loaded filaments.",
        params: no_params,
        approval: false,
        ask: no_ask,
        run: printers,
    },
    Tool {
        name: "printer_files",
        description: "Print files stored on one printer, newest first: name, size, date, estimated time, filament.",
        params: printer_param,
        approval: false,
        ask: no_ask,
        run: printer_files,
    },
    Tool {
        name: "local_files",
        description: "Files shown in Snap Studio's Files view (the folder the user browses), by name.",
        params: no_params,
        approval: false,
        ask: no_ask,
        run: local_files,
    },
    Tool {
        name: "slice_summary",
        description: "What Prepare holds now: the printer and presets chosen, the quick settings (layer height, infill, walls, supports, brim), and the last slice's estimates when there is one.",
        params: no_params,
        approval: false,
        ask: no_ask,
        run: slice_summary,
    },
    Tool {
        name: "print_queue",
        description: "Known prints: queued, printing and past ones, with their printer, state and estimates. A queued print's id starts it with start_queued_print.",
        params: no_params,
        approval: false,
        ask: no_ask,
        run: print_queue,
    },
    Tool {
        name: "memory_read",
        description: "Your memory (MEMORY.md), as saved.",
        params: no_params,
        approval: false,
        ask: no_ask,
        run: memory_read,
    },
    Tool {
        name: "memory_write",
        description: "Replaces your memory (MEMORY.md) with `content`, Markdown, at most about 200 lines / 24 KB. Never serial numbers, addresses, hostnames or file paths.",
        params: memory_params,
        approval: false,
        ask: no_ask,
        run: memory_write,
    },
    Tool {
        name: "task_status",
        description: "State of a long operation started by another tool: running, done (with its result), failed (with why) or cancelled.",
        params: task_param,
        approval: false,
        ask: no_ask,
        run: task_status,
    },
    Tool {
        name: "task_cancel",
        description: "Cancels a long operation that is still running.",
        params: task_param,
        approval: false,
        ask: no_ask,
        run: task_cancel,
    },
    Tool {
        name: "apply_slice_setting",
        description: "Changes one of Prepare's quick settings for the next slices: infill (percent, 0-100), walls (count, 1-10), supports (true/false) or brim (true/false). The user confirms it.",
        params: setting_params,
        approval: true,
        ask: ask_setting,
        run: apply_setting,
    },
    Tool {
        name: "start_queued_print",
        description: "Starts a queued print (by its id from print_queue) on its printer; the bed must be clear. The user confirms it. Answers with a task id.",
        params: job_param,
        approval: true,
        ask: ask_start_job,
        run: start_job,
    },
    Tool {
        name: "print_printer_file",
        description: "Starts printing a file already stored on a printer (names from printer_files). The user confirms it. Answers with a task id.",
        params: printer_file_params,
        approval: true,
        ask: ask_print_file,
        run: print_file,
    },
    Tool {
        name: "delete_printer_file",
        description: "Deletes a print file stored on a printer (names from printer_files). The user confirms it.",
        params: printer_file_params,
        approval: true,
        ask: ask_delete_file,
        run: delete_file,
    },
];

pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

/// The tools as MCP lists them.
pub fn list() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": (t.params)(),
                "annotations": { "readOnlyHint": !t.approval, "destructiveHint": t.approval },
            })
        })
        .collect()
}

/// Runs a tool: checked, approved when it must be, its result filtered.
pub fn call(name: &str, args: &Value) -> Result<Value> {
    let tool = find(name).ok_or_else(|| anyhow!("unknown tool: {name}"))?;
    let card = (tool.ask)(args)?;
    if tool.approval && !approve(tool.name, &card) {
        return Err(anyhow!("The user did not approve this action ({card}). Nothing was done."));
    }
    let out = (tool.run)(args)?;
    Ok(privacy::json(&out, &privacy::known()))
}

// ------------------------------------------------------------ approval

static DRAWER_OPEN: AtomicBool = AtomicBool::new(false);

fn approvals() -> &'static Mutex<HashMap<String, Sender<bool>>> {
    static A: OnceLock<Mutex<HashMap<String, Sender<bool>>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit(event: &str, payload: Value) {
    if let Some(app) = crate::snappy::app() {
        let _ = app.emit(event, payload);
    }
}

/// The drawer opened or closed: closing it refuses what was waiting.
pub fn set_drawer(open: bool) {
    DRAWER_OPEN.store(open, Ordering::SeqCst);
    if !open {
        refuse_all();
    }
}

/// Holds a call until the user answers its card. Only an explicit yes
/// passes.
fn approve(tool: &str, card: &str) -> bool {
    if !DRAWER_OPEN.load(Ordering::SeqCst) {
        return false;
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    approvals().lock().unwrap().insert(id.clone(), tx);
    emit("snappy-approval", json!({ "id": id, "tool": tool, "text": card }));
    let yes = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or(false);
    approvals().lock().unwrap().remove(&id);
    emit("snappy-approval-done", json!({ "id": id, "approved": yes }));
    yes
}

/// The user's answer to a card.
pub fn answer(id: &str, yes: bool) {
    if let Some(tx) = approvals().lock().unwrap().remove(id) {
        let _ = tx.send(yes);
    }
}

/// Refuses every call still waiting (drawer closed, Stop, Snappy ended).
pub fn refuse_all() {
    let waiting: Vec<Sender<bool>> = approvals().lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in waiting {
        let _ = tx.send(false);
    }
}

// ------------------------------------------------------------ the UI's side

fn ui_calls() -> &'static Mutex<HashMap<String, Sender<Value>>> {
    static C: OnceLock<Mutex<HashMap<String, Sender<Value>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Asks the UI about what only it holds (Prepare's state, the Files view).
fn ui_call(method: &str, args: Value) -> Result<Value> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    ui_calls().lock().unwrap().insert(id.clone(), tx);
    emit("snappy-ui", json!({ "id": id, "method": method, "args": args }));
    let got = rx.recv_timeout(UI_TIMEOUT);
    ui_calls().lock().unwrap().remove(&id);
    let v = got.map_err(|_| anyhow!("Snap Studio did not answer"))?;
    match v.get("error").and_then(|e| e.as_str()) {
        Some(e) => Err(anyhow!(e.to_string())),
        None => Ok(v),
    }
}

/// The UI's answer to [`ui_call`].
pub fn ui_reply(id: &str, result: Value) {
    if let Some(tx) = ui_calls().lock().unwrap().remove(id) {
        let _ = tx.send(result);
    }
}

// ------------------------------------------------------------ tasks

struct Task {
    label: String,
    state: &'static str,
    result: Value,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

fn tasks() -> &'static Mutex<HashMap<String, Task>> {
    static T: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs a long operation in the background; its id answers at once.
fn spawn_task(label: String, work: impl std::future::Future<Output = Result<Value, String>> + Send + 'static) -> Value {
    let id = format!("task-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    tasks().lock().unwrap().insert(id.clone(), Task { label: label.clone(), state: "running", result: Value::Null, handle: None });
    let tid = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let r = work.await;
        if let Some(t) = tasks().lock().unwrap().get_mut(&tid) {
            if t.state == "running" {
                (t.state, t.result) = match r {
                    Ok(v) => ("done", v),
                    Err(e) => ("failed", json!(e)),
                };
            }
            t.handle = None;
        }
    });
    if let Some(t) = tasks().lock().unwrap().get_mut(&id) {
        if t.state == "running" {
            t.handle = Some(handle);
        }
    }
    json!({ "task": id, "state": "running", "what": label })
}

fn task_param() -> Value {
    json!({ "type": "object", "properties": { "task": { "type": "string", "description": "The task id." } }, "required": ["task"] })
}

fn task_status(args: &Value) -> Result<Value> {
    let id = str_arg(args, "task")?;
    let t = tasks().lock().unwrap();
    let t = t.get(id).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    Ok(json!({ "task": id, "what": t.label, "state": t.state, "result": t.result }))
}

fn task_cancel(args: &Value) -> Result<Value> {
    let id = str_arg(args, "task")?;
    let mut all = tasks().lock().unwrap();
    let t = all.get_mut(id).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    if t.state != "running" {
        return Ok(json!({ "task": id, "state": t.state }));
    }
    if let Some(h) = t.handle.take() {
        h.abort();
    }
    t.state = "cancelled";
    Ok(json!({ "task": id, "state": "cancelled" }))
}

// ------------------------------------------------------------ helpers

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("missing `{key}`"))
}

fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(f)
}

/// A printer by its display name (case and spaces aside).
fn printer_named(name: &str) -> Result<crate::printers::Printer> {
    let list = crate::printers::load();
    let norm = |s: &str| s.trim().to_lowercase();
    list.iter().find(|p| norm(&p.name) == norm(name)).cloned().ok_or_else(|| {
        let names: Vec<&str> = list.iter().map(|p| p.name.as_str()).collect();
        anyhow!("no printer named “{name}”; the printers are: {}", names.join(", "))
    })
}

fn printer_param() -> Value {
    json!({ "type": "object", "properties": { "printer": { "type": "string", "description": "The printer's display name." } }, "required": ["printer"] })
}

fn printer_file_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string", "description": "The printer's display name." },
            "file": { "type": "string", "description": "The file's name, as printer_files lists it." },
        },
        "required": ["printer", "file"],
    })
}

/// The last part of a path on a printer: what the user sees.
fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A print file on a printer, by the name `printer_files` gives.
fn printer_file(p: &crate::printers::Printer, name: &str) -> Result<crate::printer_files::RemoteFile> {
    let o = overview(p)?;
    let found: Vec<_> = o.files.into_iter().filter(|f| base_name(&f.path) == name || f.path == name).collect();
    match found.len() {
        0 => Err(anyhow!("no file named “{name}” on {}", p.name)),
        1 => Ok(found.into_iter().next().unwrap()),
        _ => Err(anyhow!("several files are named “{name}” on {}", p.name)),
    }
}

fn overview(p: &crate::printers::Printer) -> Result<crate::printer_files::Overview> {
    block_on(async {
        let st = crate::printers::status(&p.host, p.port).await;
        if !st.online {
            return Err(anyhow!(crate::t!("err.printer_silent", name = p.name)));
        }
        let printing = crate::printer_files::printing_path(&st.state, st.job.as_deref());
        crate::printer_files::overview(&p.host, p.port, printing).await
    })
}

// ------------------------------------------------------------ reads

fn printers(_: &Value) -> Result<Value> {
    let list = crate::printers::load();
    let out: Vec<Value> = block_on(async {
        let mut out = Vec::new();
        for p in &list {
            let st = crate::printers::status(&p.host, p.port).await;
            let s = serde_json::to_value(&st).unwrap_or_default();
            out.push(json!({
                "name": p.name,
                "model": p.model,
                "online": st.online,
                "state": st.state,
                "message": st.message,
                "error": st.error,
                "current_print": st.job.as_deref().map(base_name),
                "progress_percent": st.progress.map(|x| (x * 100.0).round()),
                "elapsed_min": st.elapsed_s.map(|x| (x / 60.0).round()),
                "remaining_min": st.remaining_s.map(|x| (x / 60.0).round()),
                "layer": st.layer,
                "nozzles": s["nozzles"],
                "bed": s["bed"],
                "chamber": s["chamber"],
                "filaments": s["filaments"],
            }));
        }
        out
    });
    Ok(json!({ "printers": out }))
}

fn printer_files(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let mut files = overview(&p)?.files;
    files.sort_by(|a, b| b.modified.total_cmp(&a.modified));
    let total = files.len();
    let out: Vec<Value> = files
        .iter()
        .take(100)
        .map(|f| {
            let m = f.meta.as_ref();
            json!({
                "name": base_name(&f.path),
                "size_kb": f.size / 1024,
                "modified": f.modified as u64,
                "estimated_min": m.and_then(|m| m.estimated_time).map(|t| (t / 60.0).round()),
                "filaments": m.map(|m| m.filament_types.clone()),
                "layer_height": m.and_then(|m| m.layer_height),
            })
        })
        .collect();
    Ok(json!({ "printer": p.name, "files": out, "total": total }))
}

fn local_files(_: &Value) -> Result<Value> {
    ui_call("local_files", json!({}))
}

fn slice_summary(_: &Value) -> Result<Value> {
    ui_call("slice_summary", json!({}))
}

fn print_queue(_: &Value) -> Result<Value> {
    let printers = crate::printers::load();
    let name_of = |id: &str| printers.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_default();
    let jobs: Vec<Value> = crate::jobs::views()
        .into_iter()
        .map(|v| {
            let j = v.job;
            json!({
                "id": j.id,
                "name": j.name,
                "printer": name_of(&j.printer_id),
                "state": j.state,
                "created": j.created,
                "started": j.started,
                "finished": j.finished,
                "estimated_min": j.stats.as_ref().and_then(|s| s.print_time_s).map(|t| (t as f32 / 60.0).round()),
                "filament_g": j.stats.as_ref().and_then(|s| s.filament_g),
                "file_kept": v.gcode,
            })
        })
        .collect();
    Ok(json!({ "prints": jobs }))
}

fn memory_params() -> Value {
    json!({ "type": "object", "properties": { "content": { "type": "string", "description": "The whole new MEMORY.md." } }, "required": ["content"] })
}

fn memory_read(_: &Value) -> Result<Value> {
    Ok(json!({ "memory": crate::snappy::memory() }))
}

fn memory_write(args: &Value) -> Result<Value> {
    let content = args["content"].as_str().ok_or_else(|| anyhow!("missing `content`"))?;
    crate::snappy::set_memory(content)?;
    Ok(json!({ "saved": true }))
}

// ------------------------------------------------------------ actions

fn setting_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "setting": { "type": "string", "enum": ["infill", "walls", "supports", "brim"] },
            "value": { "description": "A number for infill (percent) and walls (count), true or false for supports and brim." },
        },
        "required": ["setting", "value"],
    })
}

/// The setting and its value, checked.
fn setting_of(args: &Value) -> Result<(&'static str, Value)> {
    let setting = str_arg(args, "setting")?;
    let v = &args["value"];
    let num = || v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim_end_matches('%').trim().parse().ok()));
    let flag = || v.as_bool().or_else(|| v.as_str().map(|s| matches!(s, "true" | "on" | "yes")));
    match setting {
        "infill" => num().filter(|n| (0.0..=100.0).contains(n)).map(|n| ("infill", json!(n.round() as u32))),
        "walls" => num().filter(|n| (1.0..=10.0).contains(n)).map(|n| ("walls", json!(n.round() as u32))),
        "supports" => flag().map(|b| ("supports", json!(b))),
        "brim" => flag().map(|b| ("brim", json!(b))),
        _ => None,
    }
    .ok_or_else(|| anyhow!("invalid setting or value: {setting} = {v}"))
}

fn ask_setting(args: &Value) -> Result<String> {
    let (setting, value) = setting_of(args)?;
    let value = match &value {
        Value::Bool(b) => crate::t!(if *b { "snappy.ask.on" } else { "snappy.ask.off" }),
        Value::Number(n) if setting == "infill" => format!("{n} %"),
        other => other.to_string(),
    };
    Ok(crate::t!("snappy.ask.setting", setting = crate::t!(&format!("snappy.setting.{setting}")), value = value))
}

fn apply_setting(args: &Value) -> Result<Value> {
    let (setting, value) = setting_of(args)?;
    ui_call("apply_setting", json!({ "setting": setting, "value": value }))
}

fn job_param() -> Value {
    json!({ "type": "object", "properties": { "job": { "type": "string", "description": "The print's id, from print_queue." } }, "required": ["job"] })
}

fn queued_job(args: &Value) -> Result<(crate::jobs::Job, String)> {
    let id = str_arg(args, "job")?;
    let job = crate::jobs::get(id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
    if job.state != "queued" {
        return Err(anyhow!(crate::t!("err.not_queued")));
    }
    let printer = crate::printers::load()
        .into_iter()
        .find(|p| p.id == job.printer_id)
        .map(|p| p.name)
        .ok_or_else(|| anyhow!(crate::t!("err.unknown_printer")))?;
    Ok((job, printer))
}

fn ask_start_job(args: &Value) -> Result<String> {
    let (job, printer) = queued_job(args)?;
    Ok(crate::t!("snappy.ask.start_job", name = job.name, printer = printer))
}

fn start_job(args: &Value) -> Result<Value> {
    let (job, printer) = queued_job(args)?;
    let app = crate::snappy::app().ok_or_else(|| anyhow!("app not ready"))?.clone();
    let id = job.id.clone();
    Ok(spawn_task(format!("start “{}” on {printer}", job.name), async move {
        crate::job_launch(app, id, None).await.map(|_| json!({ "started": true }))
    }))
}

fn ask_print_file(args: &Value) -> Result<String> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    Ok(crate::t!("snappy.ask.print_file", file = base_name(&f.path), printer = p.name))
}

fn print_file(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    let app = crate::snappy::app().ok_or_else(|| anyhow!("app not ready"))?.clone();
    let name = base_name(&f.path).to_string();
    let request = crate::PfPrintRequest {
        source_id: p.id.clone(),
        path: f.path.clone(),
        printer_id: p.id.clone(),
        options: crate::printers::StartOptions::default(),
        tools: Vec::new(),
        map: Vec::new(),
        queue: false,
    };
    Ok(spawn_task(format!("print “{name}” on {}", p.name), async move {
        crate::pf_print(app, request).await.map(|_| json!({ "started": true }))
    }))
}

fn ask_delete_file(args: &Value) -> Result<String> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    Ok(crate::t!("snappy.ask.delete_file", file = base_name(&f.path), printer = p.name))
}

fn delete_file(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    let errors = block_on(crate::pf_delete(p.id.clone(), "gcodes".into(), vec![f.path.clone()])).map_err(|e| anyhow!(e))?;
    match errors.into_iter().next().flatten() {
        Some(e) => Err(anyhow!(e)),
        None => Ok(json!({ "deleted": base_name(&f.path), "printer": p.name })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The drawer's state is the app's: tests that set it take turns.
    static DRAWER: Mutex<()> = Mutex::new(());

    #[test]
    fn every_tool_is_declared_once() {
        let mut names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), TOOLS.len());
        for t in TOOLS {
            let p = (t.params)();
            assert_eq!(p["type"], "object", "{}", t.name);
            for r in p["required"].as_array().into_iter().flatten() {
                assert!(p["properties"].get(r.as_str().unwrap()).is_some(), "{}: {r}", t.name);
            }
        }
    }

    #[test]
    fn what_cannot_be_undone_needs_approval() {
        let approved: Vec<&str> = TOOLS.iter().filter(|t| t.approval).map(|t| t.name).collect();
        assert_eq!(approved, ["apply_slice_setting", "start_queued_print", "print_printer_file", "delete_printer_file"]);
        for t in TOOLS.iter().filter(|t| !t.approval) {
            assert!(
                [
                    "printers",
                    "printer_files",
                    "local_files",
                    "slice_summary",
                    "print_queue",
                    "memory_read",
                    "memory_write",
                    "task_status",
                    "task_cancel"
                ]
                .contains(&t.name),
                "{} acts without approval",
                t.name
            );
        }
    }

    /// Anything that is not an explicit yes is a no: the drawer closed, a
    /// refusal, everything refused at once.
    #[test]
    fn approval_is_denied_by_default() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        assert!(!approve("delete_printer_file", "x"), "the drawer is closed: no");
        set_drawer(true);
        let waiting = |n: usize| {
            let end = std::time::Instant::now() + Duration::from_secs(5);
            while approvals().lock().unwrap().len() < n && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let refused = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        let id = approvals().lock().unwrap().keys().next().cloned().unwrap();
        answer(&id, false);
        assert!(!refused.join().unwrap());
        let yes = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        let id = approvals().lock().unwrap().keys().next().cloned().unwrap();
        answer(&id, true);
        assert!(yes.join().unwrap(), "only an explicit yes passes");
        let closed = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        set_drawer(false);
        assert!(!closed.join().unwrap(), "closing the drawer refuses");
        assert!(approvals().lock().unwrap().is_empty());
    }

    #[test]
    fn a_refused_action_runs_nothing() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        let e = call("apply_slice_setting", &json!({ "setting": "infill", "value": 30 })).unwrap_err();
        assert!(e.to_string().contains("did not approve"), "{e}");
        // Bad arguments are refused before anyone is asked.
        assert!(call("apply_slice_setting", &json!({ "setting": "infill", "value": 300 })).unwrap_err().to_string().contains("invalid"));
        assert!(call("apply_slice_setting", &json!({ "setting": "speed", "value": 3 })).is_err());
    }

    #[test]
    fn settings_are_checked() {
        assert_eq!(setting_of(&json!({ "setting": "infill", "value": "25%" })).unwrap(), ("infill", json!(25)));
        assert_eq!(setting_of(&json!({ "setting": "walls", "value": 3 })).unwrap(), ("walls", json!(3)));
        assert_eq!(setting_of(&json!({ "setting": "supports", "value": true })).unwrap(), ("supports", json!(true)));
        assert!(setting_of(&json!({ "setting": "walls", "value": 0 })).is_err());
        assert!(setting_of(&json!({ "setting": "brim", "value": 2 })).is_err());
    }

    #[test]
    fn tasks_are_followed_and_cancelled() {
        let t = spawn_task("wait".into(), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(json!({}))
        });
        let id = t["task"].as_str().unwrap().to_string();
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "running");
        assert_eq!(task_cancel(&json!({ "task": id })).unwrap()["state"], "cancelled");
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "cancelled");
        let done = spawn_task("quick".into(), async { Ok(json!({ "n": 1 })) });
        let id = done["task"].as_str().unwrap().to_string();
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while task_status(&json!({ "task": id })).unwrap()["state"] == "running" && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["result"]["n"], 1);
        assert!(task_status(&json!({ "task": "task-nope" })).is_err());
    }
}
