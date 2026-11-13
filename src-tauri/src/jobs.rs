//! Prints: queue, started prints, history.
//!
//! Slice previews live in a temporary folder; a queued print must survive a
//! restart. So each job keeps its G-code in `jobs/<id>.gcode`, and the
//! `jobs.json` store describes it: state, printer, launch options, profiles,
//! summary. The order of `queued` jobs in the store is the queue order.
//!
//! A background task polls the printers: it publishes the prints snapshot
//! (`prints-status`), records pauses and resumes, closes finished jobs and,
//! when a printer is free with a non-empty queue, asks the UI whether to
//! start the next one (`queue-next`). Nothing starts without the user.
//!
//! The history is kept forever, G-code included, unless the user chose an
//! automatic deletion in Settings (`retention.json`, 30 days to a year).

use crate::gcode::SliceStats;
use crate::printers::{self, StartOptions, Status};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Automatic deletion of the history the user may choose, in days.
pub const RETENTIONS: [u32; 3] = [30, 90, 365];
/// Printer polling interval.
const POLL: Duration = Duration::from_secs(8);
/// Right after the launch, the printer may still say it is free: a job that
/// recent is not closed.
const GRACE_S: u64 = 90;
/// Passes between two automatic deletions of old history (one hour).
const PRUNE_EVERY: u32 = 450;

/// Slicing profiles, for the record.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Profile {
    pub machine: String,
    pub process: String,
    pub filaments: Vec<String>,
    pub bed: Option<String>,
    /// Plate label as shown when slicing.
    pub bed_label: Option<String>,
    pub colors: Vec<Option<String>>,
    /// The Prepare plate's objects as sliced: the spool check can bring a
    /// queued print back to Prepare. None for records older than it.
    pub plate: Option<serde_json::Value>,
}

/// What the user says of a finished print, set in its record only.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct PrintResult {
    /// None: not said yet (a note alone).
    pub success: Option<bool>,
    /// Why it failed, a key of the record's list (`adhesion`, `clog`…).
    pub reason: Option<String>,
    pub note: String,
    /// When it was last set.
    pub at: u64,
}

/// A moment of the print seen by the background tracking.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct JobEvent {
    /// pause | resume
    pub kind: String,
    pub at: u64,
}

/// The printer's video of a finished print, once matched.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Timelapse {
    pub root: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Job {
    pub id: String,
    /// Display name, without extension.
    pub name: String,
    pub printer_id: String,
    /// G-code kept by Snap Studio.
    pub file: String,
    /// File name on the printer (known once started).
    #[serde(default)]
    pub remote: String,
    /// queued | printing | complete | cancelled | error | finished
    pub state: String,
    pub created: u64,
    #[serde(default)]
    pub started: Option<u64>,
    #[serde(default)]
    pub finished: Option<u64>,
    pub options: StartOptions,
    pub tools: Vec<u8>,
    #[serde(default)]
    pub profile: Profile,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub stats: Option<SliceStats>,
    /// Started with a substitution (a tool on another head): the printer's
    /// extruder map goes back to identity when it ends.
    #[serde(default)]
    pub remapped: bool,
    #[serde(default)]
    pub result: Option<PrintResult>,
    /// Pauses and resumes, in order.
    #[serde(default)]
    pub events: Vec<JobEvent>,
    #[serde(default)]
    pub timelapse: Option<Timelapse>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn dir() -> PathBuf {
    let d = crate::util::app_dir().join("jobs");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// The store is read and written under this lock: the UI and the background
/// task both touch it.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn load_unlocked() -> Vec<Job> {
    std::fs::read(dir().join("jobs.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_unlocked(list: &[Job]) -> Result<()> {
    crate::util::write_atomic(&dir().join("jobs.json"), &serde_json::to_vec(list)?)
}

/// Changes the store in one go.
fn update<T>(f: impl FnOnce(&mut Vec<Job>) -> Result<T>) -> Result<T> {
    update_pruning(f).map(|(out, _)| out)
}

/// The same, also saying how many old records the automatic deletion
/// removed on the way (the UI is told when some went).
fn update_pruning<T>(f: impl FnOnce(&mut Vec<Job>) -> Result<T>) -> Result<(T, usize)> {
    let _g = lock();
    let mut list = load_unlocked();
    let out = f(&mut list)?;
    let gone = prune(&mut list, retention(), now());
    save_unlocked(&list)?;
    Ok((out, gone))
}

/// Automatic deletion of the history, in days: None keeps it forever (the
/// default).
pub fn retention() -> Option<u32> {
    std::fs::read(dir().join("retention.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Option<u32>>(&b).ok())
        .flatten()
        .filter(|d| RETENTIONS.contains(d))
}

/// Saves the choice and applies it at once.
pub fn set_retention(days: Option<u32>) -> Result<()> {
    if days.is_some_and(|d| !RETENTIONS.contains(&d)) {
        return Err(anyhow!("retention: {days:?}"));
    }
    std::fs::write(dir().join("retention.json"), serde_json::to_vec(&days)?)?;
    update(|_| Ok(()))
}

/// Finished prints older than the chosen retention go, with their G-code;
/// without one, nothing goes. The queue and running prints always stay.
/// How many went.
fn prune(list: &mut Vec<Job>, keep_days: Option<u32>, now: u64) -> usize {
    let Some(days) = keep_days else { return 0 };
    let limit = now.saturating_sub(days as u64 * 86_400);
    let before = list.len();
    list.retain(|j| {
        if is_done(&j.state) && j.finished.unwrap_or(j.created) < limit {
            let _ = std::fs::remove_file(&j.file);
            false
        } else {
            true
        }
    });
    before - list.len()
}

fn is_done(state: &str) -> bool {
    matches!(state, "complete" | "cancelled" | "error" | "finished")
}

pub fn list() -> Vec<Job> {
    let _g = lock();
    load_unlocked()
}

/// A job as the Prints page reads it: with whether its G-code is still
/// there (a record can outlive it).
#[derive(Serialize)]
pub struct JobView {
    #[serde(flatten)]
    pub job: Job,
    pub gcode: bool,
}

pub fn view(job: Job) -> JobView {
    JobView { gcode: Path::new(&job.file).is_file(), job }
}

pub fn views() -> Vec<JobView> {
    list().into_iter().map(view).collect()
}

pub fn get(id: &str) -> Option<Job> {
    list().into_iter().find(|j| j.id == id)
}

/// What the UI knows about the slice when adding.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct NewJob {
    /// Id chosen in advance (it goes into the name of the file sent).
    pub id: Option<String>,
    pub name: String,
    pub printer_id: String,
    pub options: StartOptions,
    pub tools: Vec<u8>,
    pub profile: Profile,
    pub source: Option<String>,
    /// Summary already known (requeue); otherwise recomputed from the G-code.
    #[serde(skip)]
    pub stats: Option<SliceStats>,
}

/// File name on the printer: unique per job, so that two prints of the same
/// model do not overwrite each other and stay distinguishable.
pub fn remote_name(name: &str, id: &str) -> String {
    format!("{}-{}.gcode", name, &id[..id.len().min(6)])
}

/// Copies the G-code into the store and saves the job. Slow (copy, G-code
/// parsing): call it off the async thread.
pub fn add(gcode: &Path, new: NewJob, state: &str, remote: &str) -> Result<Job> {
    let id = new.id.clone().unwrap_or_else(printers::new_id);
    let file = dir().join(format!("{id}.gcode"));
    std::fs::copy(gcode, &file).with_context(|| format!("copying {} to {}", gcode.display(), file.display()))?;
    // Summary recomputed from the file: it travels with the job.
    let stats = new.stats.clone().or_else(|| {
        std::fs::File::open(&file)
            .ok()
            .and_then(|f| crate::gcode::parse_with(f, crate::gcode::Keep::None).ok())
            .map(|d| crate::gcode::stats(&d))
    });
    let job = Job {
        id,
        name: if new.name.is_empty() { "impression".into() } else { new.name },
        printer_id: new.printer_id,
        file: file.to_string_lossy().to_string(),
        remote: remote.to_string(),
        state: state.to_string(),
        created: now(),
        started: (state == "printing").then(now),
        finished: None,
        options: new.options,
        tools: new.tools,
        profile: new.profile,
        source: new.source,
        stats,
        remapped: false,
        result: None,
        events: vec![],
        timelapse: None,
    };
    let j = job.clone();
    update(move |list| {
        list.push(j);
        Ok(())
    })?;
    Ok(job)
}

pub fn remove(id: &str) -> Result<()> {
    update(|list| {
        if let Some(j) = list.iter().find(|j| j.id == id) {
            // Only a print that really runs is protected: a printer that was deleted,
            // is unreachable or free will never close it.
            let running = snapshot().iter().any(|l| l.printer_id == j.printer_id && l.status.online && busy(&l.status.state));
            if j.state == "printing" && running {
                return Err(anyhow!(crate::t!("err.job_running")));
            }
            let _ = std::fs::remove_file(&j.file);
        }
        list.retain(|j| j.id != id);
        Ok(())
    })
}

/// Moves a job in the queue (`delta`: -1 up, +1 down).
pub fn shift(id: &str, delta: i32) -> Result<()> {
    update(|list| {
        let queued: Vec<usize> = list.iter().enumerate().filter(|(_, j)| j.state == "queued").map(|(i, _)| i).collect();
        let Some(pos) = queued.iter().position(|&i| list[i].id == id) else {
            return Ok(());
        };
        let target = pos as i32 + delta;
        if target < 0 || target as usize >= queued.len() {
            return Ok(());
        }
        list.swap(queued[pos], queued[target as usize]);
        Ok(())
    })
}

/// Changes the printer or options of a queued job.
pub fn edit(id: &str, printer_id: Option<String>, options: Option<StartOptions>) -> Result<Job> {
    update(|list| {
        let j = list.iter_mut().find(|j| j.id == id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
        if let Some(p) = printer_id {
            j.printer_id = p;
        }
        if let Some(o) = options {
            j.options = o;
        }
        Ok(j.clone())
    })
}

/// Queues a print from the history again (new entry).
pub fn requeue(id: &str) -> Result<Job> {
    let old = get(id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
    // A record can outlive its G-code (removed by hand, an old copy).
    if !Path::new(&old.file).is_file() {
        return Err(anyhow!(crate::t!("err.job_no_gcode")));
    }
    add(
        Path::new(&old.file),
        NewJob {
            id: None,
            stats: old.stats,
            name: old.name,
            printer_id: old.printer_id,
            options: old.options,
            tools: old.tools,
            profile: old.profile,
            source: old.source,
        },
        "queued",
        "",
    )
}

/// The job just left for the printer.
pub fn mark_started(id: &str, remote: &str) -> Result<()> {
    update(|list| {
        // A job is added at the end of the list: it goes after the history, out of
        // the queue.
        let i = list.iter().position(|j| j.id == id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
        let mut j = list.remove(i);
        j.state = "printing".into();
        j.remote = remote.to_string();
        j.started = Some(now());
        list.push(j);
        Ok(())
    })
}

/// The job was started with a substitution.
pub fn mark_remapped(id: &str) -> Result<()> {
    update(|list| {
        if let Some(j) = list.iter_mut().find(|j| j.id == id) {
            j.remapped = true;
        }
        Ok(())
    })
}

/// The result of a finished print, from its record (None clears it).
pub fn set_result(id: &str, result: Option<PrintResult>) -> Result<Job> {
    update(|list| {
        let j = list.iter_mut().find(|j| j.id == id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
        if !is_done(&j.state) {
            return Err(anyhow!(crate::t!("err.job_not_finished")));
        }
        // Nothing said and no note: no result.
        j.result = result.map(|r| tidy_result(r, now())).filter(|r| r.success.is_some() || !r.note.is_empty());
        Ok(j.clone())
    })
}

/// A result as stored: dated, its note trimmed, a reason only for a
/// failure.
fn tidy_result(mut r: PrintResult, at: u64) -> PrintResult {
    r.at = at;
    r.note = r.note.trim().to_string();
    if r.success != Some(false) || r.reason.as_deref().is_some_and(|s| s.trim().is_empty()) {
        r.reason = None;
    }
    r
}

/// The timelapse found for a finished print, kept so that the record does
/// not look for it again.
pub fn set_timelapse(id: &str, timelapse: Timelapse) -> Result<Job> {
    update(|list| {
        let j = list.iter_mut().find(|j| j.id == id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
        j.timelapse = Some(timelapse);
        Ok(j.clone())
    })
}

/// A pause or a resume seen by the tracking. A pause after a pause, or a
/// resume without one, adds nothing; true when an event was added.
fn track(job: &mut Job, state: &str, at: u64) -> bool {
    let paused = job.events.last().is_some_and(|e| e.kind == "pause");
    let kind = match (state, paused) {
        ("paused", false) => "pause",
        ("printing", true) => "resume",
        _ => return false,
    };
    job.events.push(JobEvent { kind: kind.into(), at });
    true
}

/// Snap Studio's job behind a printer's running print: the one with the
/// file it prints, else the last started.
fn running_job<'a>(list: &'a mut [Job], printer_id: &str, file: Option<&str>) -> Option<&'a mut Job> {
    let mine: Vec<usize> =
        list.iter().enumerate().filter(|(_, j)| j.printer_id == printer_id && j.state == "printing").map(|(i, _)| i).collect();
    let i = mine
        .iter()
        .copied()
        .find(|&i| file.is_some_and(|f| !list[i].remote.is_empty() && list[i].remote == f))
        .or_else(|| mine.last().copied())?;
    list.get_mut(i)
}

/// The printer went from printing to paused, or back. `printed_s`, the
/// time the print has actually run as the printer says, is given for a pause
/// found at the launch: the pause then started while the app was away, and
/// is dated from it rather than from now.
fn record_state(printer_id: &str, state: &str, file: Option<&str>, printed_s: Option<f32>) {
    if !has_printing(printer_id) {
        return;
    }
    let r = update(|list| {
        Ok(running_job(list, printer_id, file).map(|j| {
            let at = printed_s.map_or(now(), |s| pause_seen_at(j, s, now()));
            track(j, state, at)
        }))
    });
    if let Err(e) = r {
        eprintln!("[jobs] pause not recorded: {e}");
    }
}

/// When a print found paused stopped: its start, plus the time it ran
/// (`print_duration`, which the printer does not count while paused), plus
/// the pauses already known. Never after now, nor before its start; now
/// when the start is unknown.
fn pause_seen_at(job: &Job, printed_s: f32, now: u64) -> u64 {
    let Some(started) = job.started else { return now };
    let mut paused = 0u64;
    let mut open: Option<u64> = None;
    for e in &job.events {
        match (e.kind.as_str(), open) {
            ("pause", None) => open = Some(e.at),
            ("resume", Some(from)) => {
                paused += e.at.saturating_sub(from);
                open = None;
            }
            _ => {}
        }
    }
    (started + printed_s.max(0.0) as u64 + paused).min(now).max(started)
}

/// Closes the running jobs of a printer that no longer is.
fn close_printing(printer_id: &str, state: &str) -> Vec<Job> {
    let out = update(|list| {
        let mut closed = vec![];
        let fresh = |j: &Job| j.started.is_some_and(|t| now().saturating_sub(t) < GRACE_S);
        for j in list.iter_mut().filter(|j| j.printer_id == printer_id && j.state == "printing" && !fresh(j)) {
            j.state = state.to_string();
            j.finished = Some(now());
            closed.push(j.clone());
        }
        Ok(closed)
    });
    out.unwrap_or_default()
}

fn has_printing(printer_id: &str) -> bool {
    list().iter().any(|j| j.printer_id == printer_id && j.state == "printing")
}

fn next_for(printer_id: &str) -> Option<Job> {
    list().into_iter().find(|j| j.printer_id == printer_id && j.state == "queued")
}

/* ------------------------------------------------------------ tracking */

/// A printer in the prints snapshot.
#[derive(Serialize, Clone)]
pub struct Live {
    pub printer_id: String,
    pub printer_name: String,
    pub status: Status,
}

#[derive(Serialize, Clone)]
pub(crate) struct QueueNext {
    printer_id: String,
    printer_name: String,
    /// Print that just finished, if it was seen finishing.
    finished: Option<Job>,
    next: Job,
}

#[derive(Default)]
struct Monitor {
    /// Last confirmed state per printer.
    states: HashMap<String, String>,
    /// Consecutive passes where the printer said it was free.
    idle: HashMap<String, u32>,
    /// Printers for which the question was already asked.
    asked: HashSet<String>,
    snapshot: Vec<Live>,
}

fn monitor() -> &'static Mutex<Monitor> {
    static M: OnceLock<Mutex<Monitor>> = OnceLock::new();
    M.get_or_init(Default::default)
}

/// The monitor, poisoning recovered: a panic while it was held (a tick on
/// odd data) must not take `prints_status` and the queue down with it.
fn mon() -> std::sync::MutexGuard<'static, Monitor> {
    monitor().lock().unwrap_or_else(|e| e.into_inner())
}

fn busy(state: &str) -> bool {
    matches!(state, "printing" | "paused")
}

/// Last known snapshot.
pub fn snapshot() -> Vec<Live> {
    mon().snapshot.clone()
}

/// "Later": no new question before the next print.
pub fn dismiss(printer_id: &str) {
    mon().asked.insert(printer_id.to_string());
}

/// Asks the question again for free printers with a queue (when the UI
/// starts, or on demand).
pub fn ask_again(app: &AppHandle) {
    let mut m = mon();
    m.asked.clear();
    let snap = m.snapshot.clone();
    drop(m);
    for live in snap {
        if live.status.online && !busy(&live.status.state) {
            offer_next(app, &live, None);
        }
    }
}

fn offer_next(app: &impl Report, live: &Live, finished: Option<Job>) {
    let Some(next) = next_for(&live.printer_id) else { return };
    {
        let mut m = mon();
        if !m.asked.insert(live.printer_id.clone()) {
            return;
        }
    }
    app.queue_next(QueueNext { printer_id: live.printer_id.clone(), printer_name: live.printer_name.clone(), finished, next });
}

/// Background task: one pass every `POLL` seconds, while the app lives.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut n: u32 = 0;
        loop {
            // The automatic deletion, at launch then every hour.
            if n % PRUNE_EVERY == 0 && retention().is_some() {
                match update_pruning(|_| Ok(())) {
                    // The list must not keep records that are gone.
                    Ok((_, gone)) if gone > 0 => {
                        let _ = app.emit("jobs-changed", ());
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[jobs] history not pruned: {e}"),
                }
            }
            n = n.wrapping_add(1);
            tick(&app).await;
            tokio::time::sleep(POLL).await;
        }
    });
}

async fn tick(app: &AppHandle) {
    let printers = printers::load();
    let mut snap = Vec::with_capacity(printers.len());
    for p in &printers {
        let st = printers::status(&p.host, p.port).await;
        let live = Live { printer_id: p.id.clone(), printer_name: p.name.clone(), status: st };
        if live.status.online && observe(app, &live) {
            // A print started with a substitution is over: the map goes back
            // to identity, for whatever is started next, wherever from.
            if let Err(e) = printers::gcode_script(&p.host, p.port, &printers::identity_map_script()).await {
                eprintln!("[jobs] extruder map not reset on {}: {e}", p.name);
            }
        }
        snap.push(live);
    }
    mon().snapshot = snap.clone();
    let _ = app.emit("prints-status", snap);
}

/// Transitions of a reachable printer.
///
/// An end of print is only kept when confirmed by two consecutive passes and
/// a complete state: an incomplete answer or a Klipper hiccup must not close a
/// print that is still running. True when a print started with a
/// substitution was just closed.
fn observe(app: &impl Report, live: &Live) -> bool {
    if live.status.partial {
        return false;
    }
    let id = &live.printer_id;
    let state = live.status.state.as_str();
    if busy(state) {
        let prev = {
            let mut m = mon();
            m.idle.insert(id.clone(), 0);
            // New print: the question may be asked again when it ends.
            m.asked.remove(id);
            m.states.insert(id.clone(), state.to_string())
        };
        // Pauses and resumes go into the job's timeline (only on a change:
        // the store is not written at every pass). At the first pass after
        // the launch, a print found paused was paused while the app was
        // away: the pause is dated from the time the print has run.
        match prev.as_deref() {
            Some(p) if p == state => {}
            Some(_) => record_state(id, state, live.status.job.as_deref(), None),
            None if state == "paused" => record_state(id, state, live.status.job.as_deref(), Some(live.status.elapsed_s.unwrap_or(0.0))),
            None => {}
        }
        return false;
    }
    let pending = has_printing(id);
    let was_busy = {
        let mut m = mon();
        let n = m.idle.entry(id.clone()).or_insert(0);
        *n += 1;
        let confirmed = *n >= 2;
        let was_busy = m.states.get(id).is_some_and(|s| busy(s));
        if (was_busy || pending) && !confirmed {
            return false;
        }
        m.states.insert(id.clone(), state.to_string());
        was_busy
    };
    // Free: what was believed running is over (seen finishing, or finished
    // while the app was closed).
    let outcome = match state {
        "cancelled" => "cancelled",
        "error" => "error",
        "complete" => "complete",
        _ => "finished",
    };
    let closed = if pending { close_printing(id, outcome) } else { vec![] };
    let reset = closed.iter().any(|j| j.remapped);
    if was_busy || !closed.is_empty() {
        app.jobs_changed();
        let name = closed.first().map(|j| j.name.clone()).or_else(|| live.status.job.clone()).unwrap_or_else(|| crate::t!("prints.print"));
        let key = match outcome {
            "cancelled" => "queue.done.cancelled",
            "error" => "queue.done.error",
            _ => "queue.done.ok",
        };
        let next = next_for(id).map(|j| format!(" {}", crate::t!("notify.next", name = j.name))).unwrap_or_default();
        app.notify(&crate::t!(key, name = name), &format!("{}.{next}", live.printer_name));
    }
    offer_next(app, live, closed.into_iter().next());
    reset
}

/// Where the monitor reports: the app (events, notifications), or a test.
trait Report {
    fn jobs_changed(&self);
    fn notify(&self, title: &str, body: &str);
    fn queue_next(&self, q: QueueNext);
}

impl Report for AppHandle {
    fn jobs_changed(&self) {
        let _ = self.emit("jobs-changed", ());
    }

    fn notify(&self, title: &str, body: &str) {
        use tauri_plugin_notification::NotificationExt;
        #[cfg(feature = "sim")]
        let title = &crate::sim::tag(title);
        let _ = self.notification().builder().title(title).body(body).show();
    }

    fn queue_next(&self, q: QueueNext) {
        let _ = self.emit("queue-next", q);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_keeps_the_plate() {
        let p: Profile = serde_json::from_str(
            r#"{"machine":"U1","filaments":["PLA"],"plate":[{"id":3,"path":"/m/a.3mf","item":0,"pos":[1,2],"heads":{"1":0,"2":3}}]}"#,
        )
        .unwrap();
        assert_eq!(p.plate.as_ref().unwrap()[0]["heads"]["2"], 3);
        let back: Profile = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back.plate, p.plate);
        // Records written before: no plate, nothing to bring back.
        let old: Profile = serde_json::from_str(r#"{"machine":"U1"}"#).unwrap();
        assert!(old.plate.is_none());
    }

    fn mk(i: u64, state: &str) -> Job {
        Job {
            id: format!("j{i}"),
            name: format!("n{i}"),
            printer_id: "p".into(),
            file: format!("/nonexistent/j{i}.gcode"),
            remote: String::new(),
            state: state.into(),
            created: i,
            started: None,
            finished: Some(i),
            options: StartOptions::default(),
            tools: vec![0],
            profile: Profile::default(),
            source: None,
            stats: None,
            remapped: false,
            result: None,
            events: vec![],
            timelapse: None,
        }
    }

    const DAY: u64 = 86_400;

    #[test]
    fn history_is_kept_forever_by_default() {
        let mut list: Vec<Job> = (0..300).map(|i| mk(i, "complete")).collect();
        prune(&mut list, None, 1000 * DAY);
        assert_eq!(list.len(), 300, "no retention, nothing goes");
    }

    #[test]
    fn prune_follows_the_retention() {
        let now = 400 * DAY;
        let mut list = vec![
            mk(now - 10 * DAY, "complete"),
            mk(now - 31 * DAY, "error"),
            mk(now - 89 * DAY, "cancelled"),
            mk(now - 200 * DAY, "finished"),
            // The queue and a running print are never pruned, however old.
            mk(1, "queued"),
            mk(2, "printing"),
        ];
        let ids = |l: &[Job]| l.iter().map(|j| j.id.clone()).collect::<Vec<_>>();
        let mut a = list.clone();
        assert_eq!(prune(&mut a, Some(30), now), 3);
        assert_eq!(ids(&a), [format!("j{}", now - 10 * DAY), "j1".into(), "j2".into()]);
        let mut b = list.clone();
        prune(&mut b, Some(90), now);
        assert_eq!(b.len(), 5);
        assert!(!b.iter().any(|j| j.state == "finished"));
        assert_eq!(prune(&mut list, Some(365), now), 0);
        assert_eq!(list.len(), 6);
        // A record without an end date counts from its creation.
        let mut old = vec![Job { finished: None, ..mk(5, "error") }];
        prune(&mut old, Some(30), now);
        assert!(old.is_empty());
    }

    #[test]
    fn results_are_tidied() {
        let ok = tidy_result(PrintResult { success: Some(true), reason: Some("clog".into()), note: "  fine \n".into(), at: 0 }, 42);
        assert_eq!(ok, PrintResult { success: Some(true), reason: None, note: "fine".into(), at: 42 });
        let ko = tidy_result(PrintResult { success: Some(false), reason: Some("adhesion".into()), note: String::new(), at: 0 }, 7);
        assert_eq!(ko.reason.as_deref(), Some("adhesion"));
        let blank = tidy_result(PrintResult { success: Some(false), reason: Some(" ".into()), note: String::new(), at: 0 }, 7);
        assert!(blank.reason.is_none());
        // A note alone, nothing said yet.
        let note = tidy_result(PrintResult { success: None, reason: Some("clog".into()), note: "lid tight".into(), at: 0 }, 7);
        assert_eq!((note.success, note.reason, note.note.as_str()), (None, None, "lid tight"));
    }

    #[test]
    fn retention_choices() {
        assert_eq!(RETENTIONS, [30, 90, 365]);
    }

    #[test]
    fn pauses_and_resumes_are_tracked_once() {
        let mut j = mk(1, "printing");
        assert!(!track(&mut j, "printing", 10), "running, nothing to say");
        assert!(track(&mut j, "paused", 20));
        assert!(!track(&mut j, "paused", 30), "still paused");
        assert!(track(&mut j, "printing", 40));
        assert!(!track(&mut j, "printing", 50));
        assert!(track(&mut j, "paused", 60));
        let kinds: Vec<(&str, u64)> = j.events.iter().map(|e| (e.kind.as_str(), e.at)).collect();
        assert_eq!(kinds, [("pause", 20), ("resume", 40), ("pause", 60)]);
    }

    #[test]
    fn a_pause_found_at_launch_is_dated_from_the_time_printed() {
        let now = 10_000;
        let mut j = Job { started: Some(1000), ..mk(1, "printing") };
        // Ran 3000 s, so the pause began at 4000.
        assert_eq!(pause_seen_at(&j, 3000.0, now), 4000);
        // An earlier pause of 500 s pushes it back by as much.
        j.events = vec![JobEvent { kind: "pause".into(), at: 2000 }, JobEvent { kind: "resume".into(), at: 2500 }];
        assert_eq!(pause_seen_at(&j, 3000.0, now), 4500);
        // Never after now, nor before the start; now without a start.
        assert_eq!(pause_seen_at(&j, 1e9, now), now);
        assert_eq!(pause_seen_at(&j, -5.0, now), 1500);
        assert_eq!(pause_seen_at(&mk(2, "printing"), 3000.0, now), now);
    }

    #[test]
    fn running_job_prefers_the_printed_file() {
        let mut list = vec![
            Job { remote: "a-111111.gcode".into(), ..mk(1, "printing") },
            Job { remote: "b-222222.gcode".into(), ..mk(2, "printing") },
            Job { printer_id: "q".into(), ..mk(3, "printing") },
            mk(4, "complete"),
        ];
        assert_eq!(running_job(&mut list, "p", Some("a-111111.gcode")).unwrap().id, "j1");
        // Another tool's file: the last one started.
        assert_eq!(running_job(&mut list, "p", Some("other.gcode")).unwrap().id, "j2");
        assert_eq!(running_job(&mut list, "p", None).unwrap().id, "j2");
        assert!(running_job(&mut list, "z", None).is_none());
    }

    #[test]
    fn old_records_read_without_the_new_fields() {
        let mut v = serde_json::to_value(mk(1, "complete")).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("result");
        o.remove("events");
        o.remove("timelapse");
        let j: Job = serde_json::from_value(v).unwrap();
        assert!(j.result.is_none() && j.events.is_empty() && j.timelapse.is_none());
        // A result keeps its reason and note.
        let r: PrintResult = serde_json::from_str(r#"{"success":false,"reason":"adhesion","note":"corner lifted"}"#).unwrap();
        assert_eq!((r.success, r.reason.as_deref()), (Some(false), Some("adhesion")));
        assert_eq!(r.at, 0);
    }
}

/// The queue monitor against a simulated printer: a print ends, its job
/// closes, the next one is offered.
#[cfg(all(test, feature = "sim"))]
mod sim_tests {
    use super::*;
    use crate::sim::tests::{data_dir, start};

    #[derive(Default)]
    struct Seen {
        changed: Mutex<u32>,
        notes: Mutex<Vec<(String, String)>>,
        next: Mutex<Vec<QueueNext>>,
    }

    impl Report for Seen {
        fn jobs_changed(&self) {
            *self.changed.lock().unwrap() += 1;
        }
        fn notify(&self, title: &str, body: &str) {
            self.notes.lock().unwrap().push((title.into(), body.into()));
        }
        fn queue_next(&self, q: QueueNext) {
            self.next.lock().unwrap().push(q);
        }
    }

    #[test]
    fn the_queue_follows_a_simulated_print() {
        data_dir();
        let s = start("solo");
        let p = s.printer(0);
        let file = s.gcode("Queue.gcode", vec![0], 20, 10);
        let new = |name: &str| NewJob { name: name.into(), printer_id: p.id.clone(), tools: vec![0], ..Default::default() };
        let first = add(&file, new("First"), "queued", "").unwrap();
        let second = add(&file, new("Second"), "queued", "").unwrap();
        // Launched as the app does: sent under its own name, then marked.
        let remote = remote_name(&first.name, &first.id);
        let sent = s.dir.join(&remote);
        std::fs::copy(&file, &sent).unwrap();
        s.send(0, &sent, StartOptions::default(), &[0]).unwrap();
        mark_started(&first.id, &remote).unwrap();
        let live = || Live { printer_id: p.id.clone(), printer_name: p.name.clone(), status: s.status(0) };
        let seen = Seen::default();
        observe(&seen, &live());
        assert!(seen.next.lock().unwrap().is_empty(), "printing: nothing offered");
        // The print ends (20 min, a minute of heating first).
        s.advance(21.0 * 60.0 + 5.0);
        assert_eq!(s.status(0).state, "complete");
        // Out of the 90 s given to a print just launched.
        update(|list| {
            list.iter_mut().filter(|j| j.id == first.id).for_each(|j| j.started = Some(now() - 2 * GRACE_S));
            Ok(())
        })
        .unwrap();
        observe(&seen, &live());
        assert_eq!(get(&first.id).unwrap().state, "printing", "one pass is not enough");
        observe(&seen, &live());
        assert_eq!(get(&first.id).unwrap().state, "complete");
        assert_eq!(seen.notes.lock().unwrap().len(), 1);
        assert!(seen.notes.lock().unwrap()[0].1.contains("Second"), "{:?}", seen.notes.lock().unwrap());
        let next = seen.next.lock().unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(
            (next[0].next.id.as_str(), next[0].finished.as_ref().map(|j| j.id.as_str())),
            (second.id.as_str(), Some(first.id.as_str()))
        );
        // Asked once.
        drop(next);
        observe(&seen, &live());
        assert_eq!(seen.next.lock().unwrap().len(), 1);
    }
}
