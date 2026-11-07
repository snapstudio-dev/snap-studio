//! Snappy's cards: the approval barrier for writes, and the questions it
//! asks the user (`ask_user`). Anything that is not an explicit yes is a no.
//!
//! What waits for the user is kept in a `Pending`: its answer's sender and
//! what it shows (so a card drawn again, the view over a site rebuilt,
//! finds it). The drawer's state and what waits change under one lock: a
//! card cannot slip in while the drawer closes and stay unrefused.

use super::*;

/// Requests waiting for an answer, by id: where the answer goes, and what
/// the request shows.
pub(crate) struct Pending<T> {
    map: Mutex<HashMap<String, (Sender<T>, Value)>>,
}

impl<T> Pending<T> {
    pub(crate) fn new() -> Self {
        Pending { map: Mutex::new(HashMap::new()) }
    }

    /// A new request; its answer comes on the receiver.
    pub(crate) fn add(&self, id: &str, shown: Value) -> std::sync::mpsc::Receiver<T> {
        let (tx, rx) = channel();
        self.map.lock().unwrap().insert(id.to_string(), (tx, shown));
        rx
    }

    /// Answers a request; false if it no longer waits.
    pub(crate) fn answer(&self, id: &str, v: T) -> bool {
        match self.map.lock().unwrap().remove(id) {
            Some((tx, _)) => tx.send(v).is_ok(),
            None => false,
        }
    }

    pub(crate) fn remove(&self, id: &str) {
        self.map.lock().unwrap().remove(id);
    }

    /// Answers every request with `v()`.
    pub(crate) fn answer_all(&self, v: impl Fn() -> T) {
        let all: Vec<Sender<T>> = self.map.lock().unwrap().drain().map(|(_, (tx, _))| tx).collect();
        for tx in all {
            let _ = tx.send(v());
        }
    }

    /// What every waiting request shows.
    pub(crate) fn shown(&self) -> Vec<Value> {
        self.map.lock().unwrap().values().map(|(_, v)| v.clone()).collect()
    }

    #[cfg(test)]
    pub(crate) fn ids(&self) -> Vec<String> {
        self.map.lock().unwrap().keys().cloned().collect()
    }
}

/// Whether the drawer is open; held while a card or a question is added,
/// and while closing refuses what waits.
static DRAWER: Mutex<bool> = Mutex::new(false);

pub(crate) fn approvals() -> &'static Pending<bool> {
    static A: OnceLock<Pending<bool>> = OnceLock::new();
    A.get_or_init(Pending::new)
}

pub(crate) fn questions() -> &'static Pending<Option<String>> {
    static Q: OnceLock<Pending<Option<String>>> = OnceLock::new();
    Q.get_or_init(Pending::new)
}

pub(crate) fn emit(event: &str, payload: Value) {
    #[cfg(test)]
    emitted().lock().unwrap().push((event.to_string(), payload.clone()));
    if let Some(app) = crate::snappy::app() {
        let _ = app.emit(event, payload);
    }
}

/// What the tools showed the interface, for tests that play its part
/// (cards, questions, the page's side).
#[cfg(test)]
pub(crate) fn emitted() -> &'static Mutex<Vec<(String, Value)>> {
    static E: OnceLock<Mutex<Vec<(String, Value)>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(Vec::new()))
}

/// The drawer opened or closed: closing it refuses what was waiting, in
/// the same step.
pub fn set_drawer(open: bool) {
    let mut d = DRAWER.lock().unwrap();
    *d = open;
    if !open {
        approvals().answer_all(|| false);
        questions().answer_all(|| None);
    }
}

/// Adds a request to `pending` only while the drawer is open (checked and
/// added under the drawer's lock).
fn add_if_open<T>(pending: &Pending<T>, id: &str, shown: Value) -> Option<std::sync::mpsc::Receiver<T>> {
    let d = DRAWER.lock().unwrap();
    d.then(|| pending.add(id, shown))
}

/// Holds a call until the user answers its card. Only an explicit yes
/// passes.
pub(crate) fn approve(tool: &str, card: &str) -> bool {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let shown = json!({ "kind": "approval", "id": id, "tool": tool, "text": card });
    let Some(rx) = add_if_open(approvals(), &id, shown.clone()) else { return false };
    emit("snappy-approval", shown);
    let yes = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or(false);
    approvals().remove(&id);
    emit("snappy-approval-done", json!({ "id": id, "approved": yes }));
    yes
}

/// The cards waiting for an answer.
#[cfg(test)]
pub(crate) fn waiting() -> Vec<String> {
    approvals().ids()
}

/// What waits for the user now, cards then questions: for a card drawn
/// again (the view over a site rebuilt, the drawer reloaded).
pub fn waiting_shown() -> Vec<Value> {
    let mut all = approvals().shown();
    all.extend(questions().shown());
    all
}

/// The user's answer to a card.
pub fn answer(id: &str, yes: bool) {
    approvals().answer(id, yes);
}

/// Refuses every call still waiting (drawer closed, Stop, Snappy ended),
/// and leaves every question unanswered.
pub fn refuse_all() {
    approvals().answer_all(|| false);
    questions().answer_all(|| None);
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
    let id = uuid::Uuid::new_v4().simple().to_string();
    let shown = json!({ "kind": "question", "id": id, "question": question, "options": options });
    let Some(rx) = add_if_open(questions(), &id, shown.clone()) else {
        return Err(anyhow!("The conversation is closed: the user cannot answer now."));
    };
    emit("snappy-question", shown);
    let answer = rx.recv_timeout(APPROVAL_TIMEOUT).ok().flatten();
    questions().remove(&id);
    emit("snappy-question-done", json!({ "id": id, "answer": answer }));
    Ok(match answer {
        Some(a) => json!({ "answer": a }),
        None => json!({ "answer": null, "note": "The user did not answer." }),
    })
}

/// The user's answer to a question (None: skipped).
pub fn reply(id: &str, answer: Option<String>) {
    questions().answer(id, answer);
}
