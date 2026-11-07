//! Long operations: they answer at once with a task id, which Snappy
//! follows (`task_status`) or cancels (`task_cancel`).

use super::*;

pub(crate) struct Task {
    label: String,
    state: &'static str,
    result: Value,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub(crate) fn tasks() -> &'static Mutex<HashMap<String, Task>> {
    static T: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs a long operation in the background; its id answers at once.
pub(crate) fn spawn_task(label: String, work: impl std::future::Future<Output = Result<Value, String>> + Send + 'static) -> Value {
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

pub(crate) fn ask_task_cancel(args: &Value) -> Result<String> {
    let id = str_arg(args, "task")?;
    let what = tasks().lock().unwrap().get(id).map(|t| t.label.clone()).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    Ok(crate::t!("snappy.ask.task_cancel", what = what))
}
