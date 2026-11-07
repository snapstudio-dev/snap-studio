//! Long operations: they answer at once with a task id, which Snappy
//! follows (`task_status`) or cancels (`task_cancel`).

use super::*;

pub(crate) struct Task {
    label: String,
    state: &'static str,
    result: Value,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
    cancel: Cancel,
}

/// How a long operation stops, if it can: never "cancelled" while it goes
/// on.
#[derive(Clone, Copy)]
pub(crate) enum Cancel {
    /// Its work is only ours: dropped at once. (Every task of today stops
    /// where it runs or not at all; the tests use this one.)
    #[cfg_attr(not(test), allow(dead_code))]
    Abort,
    /// Asked to stop where it runs (a slice: as the sheet's Stop does).
    Call(fn() -> Result<()>),
    /// It cannot be stopped half way; the reason says what to do instead.
    Refuse(&'static str),
}

pub(crate) fn tasks() -> &'static Mutex<HashMap<String, Task>> {
    static T: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs a long operation in the background; its id answers at once.
pub(crate) fn spawn_task(
    label: String,
    cancel: Cancel,
    work: impl std::future::Future<Output = Result<Value, String>> + Send + 'static,
) -> Value {
    let id = format!("task-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    tasks().lock().unwrap().insert(id.clone(), Task { label: label.clone(), state: "running", result: Value::Null, handle: None, cancel });
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

pub(crate) fn task_param() -> Value {
    json!({ "type": "object", "properties": { "task": { "type": "string", "description": "The task id." } }, "required": ["task"] })
}

pub(crate) fn task_status(args: &Value) -> Result<Value> {
    let id = str_arg(args, "task")?;
    let t = tasks().lock().unwrap();
    let t = t.get(id).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    Ok(json!({ "task": id, "what": t.label, "state": t.state, "result": t.result }))
}

pub(crate) fn task_cancel(args: &Value) -> Result<Value> {
    let id = str_arg(args, "task")?;
    let cancel = {
        let all = tasks().lock().unwrap();
        let t = all.get(id).ok_or_else(|| anyhow!("unknown task: {id}"))?;
        if t.state != "running" {
            return Ok(json!({ "task": id, "state": t.state }));
        }
        t.cancel
    };
    match cancel {
        Cancel::Refuse(why) => return Err(anyhow!(why)),
        // Stopped where it runs; its own end then follows.
        Cancel::Call(stop) => stop()?,
        Cancel::Abort => {
            if let Some(h) = tasks().lock().unwrap().get_mut(id).and_then(|t| t.handle.take()) {
                h.abort();
            }
        }
    }
    if let Some(t) = tasks().lock().unwrap().get_mut(id) {
        if t.state == "running" {
            t.state = "cancelled";
        }
    }
    Ok(json!({ "task": id, "state": "cancelled" }))
}

/// Before any card: a task that cannot be stopped says so at once.
pub(crate) fn ask_task_cancel(args: &Value) -> Result<String> {
    let id = str_arg(args, "task")?;
    let (what, cancel) =
        tasks().lock().unwrap().get(id).map(|t| (t.label.clone(), t.cancel)).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    if let Cancel::Refuse(why) = cancel {
        return Err(anyhow!(why));
    }
    Ok(crate::t!("snappy.ask.task_cancel", what = what))
}

/// Starting a print uploads then starts it: cut half way, it would leave a
/// partial file or start anyway.
pub(crate) const PRINT_STARTING: &str =
    "A print being sent and started cannot be stopped half way (a partial upload, or a print starting anyway). Once it prints, pause or cancel it with print_control.";
