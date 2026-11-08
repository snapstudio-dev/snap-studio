//! The page's side: what only the interface holds is asked through
//! `snappy-ui` events, and the page answers with `snappy_ui_reply`.

use super::*;

pub(crate) fn ui_calls() -> &'static Pending<Value> {
    static C: OnceLock<Pending<Value>> = OnceLock::new();
    C.get_or_init(Pending::new)
}

/// Asks the UI about what only it holds (Prepare's state, the Files view).
pub(crate) fn ui_call(method: &str, args: Value) -> Result<Value> {
    ui_call_within(method, args, UI_TIMEOUT)
}

pub(crate) fn ui_call_within(method: &str, args: Value, timeout: Duration) -> Result<Value> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let rx = ui_calls().add(&id, json!({ "method": method }));
    emit("snappy-ui", json!({ "id": id, "method": method, "args": args }));
    let got = rx.recv_timeout(timeout);
    ui_calls().remove(&id);
    let v = got.map_err(|_| anyhow!("Snap Studio did not answer"))?;
    match v.get("error").and_then(|e| e.as_str()) {
        Some(e) => Err(anyhow!(e.to_string())),
        None => Ok(v),
    }
}

/// The UI's answer to [`ui_call`].
pub fn ui_reply(id: &str, result: Value) {
    ui_calls().answer(id, result);
}
