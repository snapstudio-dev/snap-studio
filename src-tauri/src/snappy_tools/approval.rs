//! Snappy's cards: the approval barrier for writes, and the questions it
//! asks the user (`ask_user`). Anything that is not an explicit yes is a no.

use super::*;

pub(crate) static DRAWER_OPEN: AtomicBool = AtomicBool::new(false);

pub(crate) fn approvals() -> &'static Mutex<HashMap<String, Sender<bool>>> {
    static A: OnceLock<Mutex<HashMap<String, Sender<bool>>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn emit(event: &str, payload: Value) {
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
pub(crate) fn approve(tool: &str, card: &str) -> bool {
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

/// The cards waiting for an answer.
#[cfg(test)]
pub(crate) fn waiting() -> Vec<String> {
    approvals().lock().unwrap().keys().cloned().collect()
}

/// The user's answer to a card.
pub fn answer(id: &str, yes: bool) {
    if let Some(tx) = approvals().lock().unwrap().remove(id) {
        let _ = tx.send(yes);
    }
}

/// Refuses every call still waiting (drawer closed, Stop, Snappy ended),
/// and leaves every question unanswered.
pub fn refuse_all() {
    let waiting: Vec<Sender<bool>> = approvals().lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in waiting {
        let _ = tx.send(false);
    }
    let asked: Vec<Sender<Option<String>>> = questions().lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in asked {
        let _ = tx.send(None);
    }
}

pub(crate) fn questions() -> &'static Mutex<HashMap<String, Sender<Option<String>>>> {
    static Q: OnceLock<Mutex<HashMap<String, Sender<Option<String>>>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn ask_user_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "question": { "type": "string" },
            "options": { "type": "array", "items": { "type": "string" }, "maxItems": 6, "description": "Short answers to pick from; may be empty for a free answer." },
        },
        "required": ["question"],
    })
}

/// The question as a card of the conversation, until the user answers,
/// skips it, closes the conversation, or 15 minutes pass.
pub(crate) fn ask_user(args: &Value) -> Result<Value> {
    let question = str_arg(args, "question")?;
    let options: Vec<&str> = args["options"].as_array().into_iter().flatten().filter_map(|o| o.as_str()).take(6).collect();
    if !DRAWER_OPEN.load(Ordering::SeqCst) {
        return Err(anyhow!("The conversation is closed: the user cannot answer now."));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    questions().lock().unwrap().insert(id.clone(), tx);
    emit("snappy-question", json!({ "id": id, "question": question, "options": options }));
    let answer = rx.recv_timeout(APPROVAL_TIMEOUT).ok().flatten();
    questions().lock().unwrap().remove(&id);
    emit("snappy-question-done", json!({ "id": id, "answer": answer }));
    Ok(match answer {
        Some(a) => json!({ "answer": a }),
        None => json!({ "answer": null, "note": "The user did not answer." }),
    })
}

/// The user's answer to a question (None: skipped).
pub fn reply(id: &str, answer: Option<String>) {
    if let Some(tx) = questions().lock().unwrap().remove(id) {
        let _ = tx.send(answer);
    }
}
