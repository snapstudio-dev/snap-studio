//! The fake Moonraker of a simulated printer: the HTTP routes and the
//! `/websocket` JSON-RPC the app uses on a U1, on `127.0.0.1` only, plus a
//! `/sim/` control path no real client knows. Faults act at the socket:
//! connections refused, the port closed, answers delayed.

use super::clock::Clock;
use super::faults::Fault;
use super::files::{self, Files};
use super::machine::{Klippy, Machine, Net, OBJECTS};
use super::scenario::{PrinterSpec, Scenario, Spool};
use super::script::Exec;
use super::{camera, fixtures};
use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Multipart, Path as UrlPath, RawQuery, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

/// What goes to the live WebSocket clients.
#[derive(Clone, Debug)]
pub enum Push {
    /// `notify_status_update`: the changes, and the time.
    Status(Map<String, Value>, f64),
    /// Another notification; not to the connection `skip` (it got it already).
    Method(String, Value, Option<u64>),
    /// Close every connection (a fault).
    Close,
}

/// One simulated printer: its machine, its files, its port.
pub struct SimPrinter {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub clock: Arc<Clock>,
    pub files: Files,
    machine: Mutex<Machine>,
    tx: broadcast::Sender<Push>,
    net: watch::Sender<Net>,
    scripts: tokio::sync::Mutex<()>,
    conns: AtomicU64,
}

type P = Arc<SimPrinter>;

impl SimPrinter {
    pub fn lock(&self) -> MutexGuard<'_, Machine> {
        self.machine.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Brings the machine to now and pushes what changed.
    pub fn sync(&self) {
        let now = self.clock.now();
        let (events, changes, net, timelapses, eventtime) = {
            let mut m = self.lock();
            m.sync(now);
            (std::mem::take(&mut m.events), m.changes(), m.net(), std::mem::take(&mut m.pending_timelapse), m.sim_s)
        };
        for (date, secs) in timelapses {
            self.write_timelapse(&date, secs);
        }
        if let Some(c) = changes {
            let _ = self.tx.send(Push::Status(c, eventtime));
        }
        for (method, params) in events {
            let _ = self.tx.send(Push::Method(method, params, None));
        }
        self.net.send_if_modified(|n| {
            let changed = *n != net;
            *n = net;
            changed
        });
        if net != Net::Open {
            let _ = self.tx.send(Push::Close);
        }
    }

    /// A finished print's timelapse: its video and picture in `camera`, and
    /// the camera service's record of it.
    fn write_timelapse(&self, date: &str, secs: f64) {
        let Ok(dir) = self.files.root_dir("camera") else { return };
        let video = format!("{date}.mp4");
        let _ = std::fs::write(dir.join(&video), fixtures::timelapse_mp4(secs));
        let _ = std::fs::write(dir.join(format!("{date}.jpg")), camera::frame(&self.card()));
        self.lock().timelapses.push((date.to_string(), video));
    }

    /// The camera picture's content.
    pub fn card(&self) -> camera::Card {
        let m = self.lock();
        let state = match (&m.klippy, m.ps.state.as_str()) {
            (Klippy::Ready, "standby") if m.op.is_some() => "BUSY".to_string(),
            (Klippy::Ready, s) => s.to_ascii_uppercase(),
            (k, _) => k.state().to_ascii_uppercase(),
        };
        camera::Card {
            name: self.name.clone(),
            state,
            layer: m.ps.layer.filter(|_| m.run.is_some()),
            progress: m.ps.progress,
            clock_s: m.sim_s,
            accent: fixtures::rgb(&m.heads[m.active as usize].spool.color),
        }
    }

    pub fn inject(&self, f: Fault) {
        self.lock().inject(f);
        self.sync();
    }

    pub fn clear_faults(&self) {
        self.lock().clear_faults();
        self.sync();
    }

    pub fn set_spool(&self, head: u8, spool: Spool) {
        self.lock().set_spool(head, spool);
        self.sync();
    }

    /// `/sim/status`.
    pub fn status(&self) -> Value {
        let m = self.lock();
        json!({
            "id": self.id, "name": self.name, "port": self.port, "factor": m.factor,
            "state": m.ps.state, "klippy": m.klippy.state(), "faults": m.fault_names(),
            "progress": m.ps.progress, "net": format!("{:?}", m.net()).to_ascii_lowercase(),
        })
    }
}

/* ------------------------------------------------------------ farm */

/// The printers of a scenario, each on its own port.
pub struct Farm {
    pub printers: Vec<P>,
    pub clock: Arc<Clock>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Farm {
    /// Starts every printer of `scenario`, its files in `dir`. Inside a
    /// Tokio runtime.
    pub async fn start(scenario: &Scenario, factor: f64, dir: &Path, clock: Arc<Clock>) -> Result<Farm> {
        let epoch =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0) - clock.now();
        let mut printers = Vec::new();
        let mut tasks = Vec::new();
        for spec in &scenario.printers {
            let p = build(spec.clone(), factor, epoch, dir.join(&spec.id), clock.clone()).await?;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", p.0)).await.context("binding a simulated printer")?;
            let p = Arc::new(SimPrinter { port: listener.local_addr()?.port(), ..p.1 });
            p.sync();
            tasks.push(tokio::spawn(serve(p.clone(), listener)));
            if !clock.is_manual() {
                let q = p.clone();
                tasks.push(tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        q.sync();
                    }
                }));
            }
            printers.push(p);
        }
        Ok(Farm { printers, clock, tasks })
    }

    /// Moves a manual clock on (tests), every printer with it.
    pub fn advance(&self, secs: f64) {
        self.clock.advance(secs);
        for p in &self.printers {
            p.sync();
        }
    }

    pub fn find(&self, id: &str) -> Option<&P> {
        self.printers.iter().find(|p| p.id == id)
    }

    pub fn stop(&self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Drop for Farm {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A printer's machine and files, its sample files written.
async fn build(spec: PrinterSpec, factor: f64, epoch: f64, dir: PathBuf, clock: Arc<Clock>) -> Result<(u16, SimPrinter)> {
    let files = Files::new(dir, spec.disk_mb.max(1) * 1_000_000)?;
    for f in &spec.files {
        let path = files.path("gcodes", &f.name)?;
        std::fs::write(&path, fixtures::sample_gcode(f, &spec.spools))?;
    }
    // Timelapses of its past prints.
    if let Ok(cam) = files.root_dir("camera") {
        for j in spec.history.iter().filter(|j| j.status == "completed") {
            let date = fixtures::date_index(epoch - j.days_ago * 86_400.0);
            std::fs::write(cam.join(format!("{date}.mp4")), fixtures::timelapse_mp4((j.minutes as f64 * 2.0).clamp(5.0, 120.0)))?;
        }
    }
    let plan = match &spec.print {
        Some(f) => {
            let info = files.info(f)?;
            Some(info.plan.clone().map_err(anyhow::Error::msg)?)
        }
        None => None,
    };
    let (tx, _) = broadcast::channel(256);
    let (net, _) = watch::channel(Net::Open);
    let name = spec.name.clone();
    let id = spec.id.clone();
    let mut machine = Machine::new(spec, factor, epoch, plan);
    machine.last = clock.now();
    // The camera records of the past timelapses.
    let pictures: Vec<(String, String)> = files
        .list("camera")?
        .iter()
        .filter_map(|v| v["path"].as_str())
        .filter(|p| p.ends_with(".mp4"))
        .map(|p| (p.trim_end_matches(".mp4").to_string(), p.to_string()))
        .collect();
    machine.timelapses = pictures;
    let p = SimPrinter {
        id,
        name,
        port: 0,
        clock,
        files,
        machine: Mutex::new(machine),
        tx,
        net,
        scripts: tokio::sync::Mutex::new(()),
        conns: AtomicU64::new(1),
    };
    // Each past video's picture.
    let card = p.card();
    if let Ok(cam) = p.files.root_dir("camera") {
        for (date, _) in p.lock().timelapses.clone() {
            let _ = std::fs::write(cam.join(format!("{date}.jpg")), camera::frame(&card));
        }
    }
    Ok((0, p))
}

/* ------------------------------------------------------------ socket */

/// Accepts connections while the printer is reachable: refused during a
/// `disconnect`, the port closed during `unreachable`, live connections
/// closed by either.
async fn serve(p: P, listener: tokio::net::TcpListener) {
    let app = router(p.clone());
    let mut net = p.net.subscribe();
    let mut listener = Some(listener);
    loop {
        if *net.borrow_and_update() == Net::Closed {
            listener = None;
            if net.changed().await.is_err() {
                return;
            }
            continue;
        }
        if listener.is_none() {
            match tokio::net::TcpListener::bind(("127.0.0.1", p.port)).await {
                Ok(l) => listener = Some(l),
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            }
        }
        let Some(l) = listener.as_ref() else { continue };
        tokio::select! {
            r = l.accept() => {
                let Ok((sock, _)) = r else { continue };
                if *net.borrow() != Net::Open {
                    drop(sock);
                    continue;
                }
                let svc = hyper_util::service::TowerToHyperService::new(app.clone());
                let mut watch = p.net.subscribe();
                tokio::spawn(async move {
                    let conn = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(sock), svc)
                        .with_upgrades();
                    tokio::pin!(conn);
                    loop {
                        tokio::select! {
                            _ = &mut conn => break,
                            c = watch.changed() => {
                                if c.is_err() || *watch.borrow() != Net::Open {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
            c = net.changed() => {
                if c.is_err() {
                    return;
                }
            }
        }
    }
}

fn router(p: P) -> Router {
    Router::new()
        .route("/server/info", get(server_info))
        .route("/printer/info", get(printer_info))
        .route("/printer/objects/list", get(objects_list))
        .route("/printer/objects/query", get(objects_query).post(objects_query))
        .route("/printer/gcode/script", post(gcode_script))
        .route("/printer/print/{action}", post(print_action))
        .route("/printer/emergency_stop", post(emergency_stop))
        .route("/printer/firmware_restart", post(firmware_restart))
        .route("/printer/restart", post(firmware_restart))
        .route("/printer/bed_mesh/abort_probe_mesh", post(abort_probe_mesh))
        .route("/server/files/roots", get(roots))
        .route("/server/files/list", get(list))
        .route("/server/files/metadata", get(metadata))
        .route("/server/files/directory", get(directory))
        .route("/server/files/upload", post(upload))
        .route("/server/files/move", post(move_file))
        .route("/server/files/{root}/{*path}", get(download).delete(delete))
        .route("/server/history/list", get(history))
        .route("/server/history/totals", get(totals))
        .route("/websocket", get(websocket))
        .route("/sim/status", get(sim_status))
        .route("/sim/fault", post(sim_fault))
        .route("/sim/clear", post(sim_clear))
        .route("/sim/spool", post(sim_spool))
        .fallback(|| async { err(404, "Not Found") })
        .layer(axum::middleware::from_fn_with_state(p.clone(), slow))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(p)
}

/// The `slow` fault: every Moonraker answer late.
async fn slow(State(p): State<P>, req: Request, next: Next) -> Response {
    let ms = p.lock().faults.slow_ms;
    if ms > 0 && !req.uri().path().starts_with("/sim/") {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    next.run(req).await
}

fn ok(v: Value) -> Response {
    Json(json!({ "result": v })).into_response()
}

fn err(code: u16, msg: &str) -> Response {
    let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(json!({ "error": { "code": code, "message": msg } }))).into_response()
}

fn query(raw: &Option<String>) -> Vec<(String, String)> {
    url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()).into_owned().collect()
}

fn arg(raw: &Option<String>, k: &str) -> Option<String> {
    query(raw).into_iter().find(|(x, _)| x == k).map(|(_, v)| v)
}

/* ------------------------------------------------------------ status */

fn server_info_of(p: &P) -> Value {
    let m = p.lock();
    let connected = !matches!(m.klippy, Klippy::Error(_));
    json!({
        "klippy_connected": connected,
        "klippy_state": m.klippy.state(),
        "components": ["database", "file_manager", "klippy_apis", "machine", "data_store", "history", "webcam", "snapmaker"],
        "failed_components": [],
        "registered_directories": ["config", "logs", "gcodes", "camera"],
        "warnings": [],
        "websocket_count": 0,
        "moonraker_version": "v0.9.3-sim",
        "api_version": [1, 5, 0],
        "api_version_string": "1.5.0",
    })
}

fn printer_info_of(p: &P) -> Value {
    let m = p.lock();
    json!({
        "state": m.klippy.state(),
        "state_message": m.klippy.message(),
        "hostname": m.spec.hostname,
        "software_version": format!("v0.12.0-sim U1 {}", m.spec.firmware),
        "cpu_info": "Simulated U1",
        "klipper_path": "/home/sim/klipper",
        "python_path": "/home/sim/klippy-env/bin/python",
        "log_file": "/home/sim/printer_data/logs/klippy.log",
        "config_file": "/home/sim/printer_data/config/printer.cfg",
    })
}

async fn server_info(State(p): State<P>) -> Response {
    p.sync();
    ok(server_info_of(&p))
}

async fn printer_info(State(p): State<P>) -> Response {
    p.sync();
    ok(printer_info_of(&p))
}

async fn objects_list(State(p): State<P>) -> Response {
    p.sync();
    ok(json!({ "objects": OBJECTS }))
}

/// `name` or `name=field,field` per object.
fn wanted_of_query(raw: &Option<String>) -> Vec<(String, Option<Vec<String>>)> {
    query(raw).into_iter().map(|(k, v)| (k, (!v.is_empty()).then(|| v.split(',').map(|s| s.trim().to_string()).collect()))).collect()
}

fn wanted_of_json(objects: &Value) -> Vec<(String, Option<Vec<String>>)> {
    objects
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())))
                .collect()
        })
        .unwrap_or_default()
}

fn status_of(p: &P, wanted: &[(String, Option<Vec<String>>)]) -> std::result::Result<Value, (u16, String)> {
    let m = p.lock();
    if let Klippy::Error(msg) = &m.klippy {
        return Err((503, format!("Klippy Disconnected: {msg}")));
    }
    Ok(json!({ "eventtime": m.sim_s, "status": m.query(wanted) }))
}

async fn objects_query(State(p): State<P>, RawQuery(raw): RawQuery) -> Response {
    p.sync();
    match status_of(&p, &wanted_of_query(&raw)) {
        Ok(v) => ok(v),
        Err((c, m)) => err(c, &m),
    }
}

/* ------------------------------------------------------------ scripts and actions */

/// Runs a script line after line, each waited for; the responses go to
/// every client but `conn`, and back to the caller.
async fn run_script(p: &P, script: &str, conn: Option<u64>) -> (Vec<String>, std::result::Result<(), String>) {
    let _one_at_a_time = p.scripts.lock().await;
    let mut all = Vec::new();
    for line in script.lines() {
        p.sync();
        let o = p.lock().exec(line);
        for l in &o.out {
            let _ = p.tx.send(Push::Method("notify_gcode_response".into(), json!([l]), conn));
        }
        all.extend(o.out);
        match o.exec {
            Exec::Done => {}
            Exec::Fail(e) => {
                let _ = p.tx.send(Push::Method("notify_gcode_response".into(), json!([format!("!! {e}")]), None));
                p.sync();
                return (all, Err(e));
            }
            Exec::Wait(id) => loop {
                p.sync();
                let r = p.lock().op_result(id);
                match r {
                    Some(Ok(())) => break,
                    Some(Err(e)) => return (all, Err(e)),
                    None => tokio::time::sleep(Duration::from_millis(40)).await,
                }
            },
        }
    }
    p.sync();
    (all, Ok(()))
}

async fn gcode_script(State(p): State<P>, RawQuery(raw): RawQuery, body: axum::body::Bytes) -> Response {
    let from_body = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["script"].as_str().map(String::from));
    let Some(script) = from_body.or_else(|| arg(&raw, "script")) else {
        return err(400, "No script given");
    };
    match run_script(&p, &script, None).await.1 {
        Ok(()) => ok(json!("ok")),
        Err(e) => err(400, &e),
    }
}

/// Starts a file of `gcodes`: its plan read off the async threads.
async fn start_file(p: &P, file: &str, opts: Option<[bool; 3]>, map: &[[u8; 2]]) -> std::result::Result<(), String> {
    let rel = files::clean(file).map_err(|e| e.to_string())?;
    let q = p.clone();
    let r = rel.clone();
    let info = tokio::task::spawn_blocking(move || q.files.info(&r)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    p.sync();
    let mut m = p.lock();
    let opts = opts.unwrap_or(m.prefs);
    m.start_print(&rel, info.plan.clone(), opts, map)
}

async fn print_action(State(p): State<P>, UrlPath(action): UrlPath<String>, RawQuery(raw): RawQuery) -> Response {
    p.sync();
    if action == "start" {
        let Some(f) = arg(&raw, "filename") else { return err(400, "No filename given") };
        return match start_file(&p, &f, None, &[]).await {
            Ok(()) => {
                p.sync();
                ok(json!("ok"))
            }
            Err(e) => err(400, &e),
        };
    }
    let r = {
        let mut m = p.lock();
        if m.klippy != Klippy::Ready {
            Err(format!("Klippy not ready: {}", m.klippy.message()))
        } else {
            match action.as_str() {
                "pause" => {
                    if m.pause() {
                        Ok(())
                    } else {
                        Err("Print not running".to_string())
                    }
                }
                "resume" => m.resume(),
                "cancel" => m.cancel(),
                _ => return err(404, "Not Found"),
            }
        }
    };
    p.sync();
    match r {
        Ok(()) => ok(json!("ok")),
        Err(e) => err(400, &e),
    }
}

async fn emergency_stop(State(p): State<P>) -> Response {
    p.lock().shutdown("Shutdown due to webhooks request");
    p.sync();
    ok(json!("ok"))
}

async fn firmware_restart(State(p): State<P>) -> Response {
    p.lock().firmware_restart();
    p.sync();
    ok(json!("ok"))
}

async fn abort_probe_mesh(State(p): State<P>) -> Response {
    p.sync();
    let r = p.lock().abort_mesh();
    p.sync();
    match r {
        Ok(()) => ok(json!({ "state": "success" })),
        Err(e) => ok(json!({ "state": "error", "message": e })),
    }
}

/* ------------------------------------------------------------ files */

async fn roots() -> Response {
    ok(json!(files::ROOTS
        .iter()
        .map(|(n, perm)| json!({ "name": n, "path": format!("/home/sim/printer_data/{n}"), "permissions": perm }))
        .collect::<Vec<_>>()))
}

async fn list(State(p): State<P>, RawQuery(raw): RawQuery) -> Response {
    let root = arg(&raw, "root").unwrap_or_else(|| "gcodes".into());
    let mut l = match p.files.list(&root) {
        Ok(l) => l,
        Err(e) => return err(400, &e.to_string()),
    };
    if root == "camera" {
        l.insert(0, json!({ "path": "monitor.jpg", "modified": p.lock().wall(), "size": 30_000, "permissions": "r" }));
    }
    ok(json!(l))
}

async fn metadata(State(p): State<P>, RawQuery(raw): RawQuery) -> Response {
    let Some(f) = arg(&raw, "filename") else { return err(400, "No filename given") };
    let q = p.clone();
    match tokio::task::spawn_blocking(move || q.files.info(&f)).await {
        Ok(Ok(i)) => ok(i.meta.clone()),
        Ok(Err(e)) => err(404, &e.to_string()),
        Err(e) => err(500, &e.to_string()),
    }
}

fn disk(p: &P) -> Value {
    let total = p.files.quota;
    let used = if p.lock().faults.disk_full { total.saturating_sub(1_000_000) } else { p.files.used().min(total) };
    json!({ "total": total, "used": used, "free": total - used })
}

async fn directory(State(p): State<P>, RawQuery(raw): RawQuery) -> Response {
    let root = arg(&raw, "path").unwrap_or_else(|| "gcodes".into());
    let root = root.split('/').next().unwrap_or("gcodes").to_string();
    let files = match p.files.list(&root) {
        Ok(l) => l,
        Err(e) => return err(400, &e.to_string()),
    };
    let perm = files::ROOTS.iter().find(|(r, _)| *r == root).map(|(_, p)| *p).unwrap_or("r");
    ok(json!({
        "dirs": [],
        "files": files.iter().filter(|f| !f["path"].as_str().unwrap_or("").contains('/')).map(|f| json!({ "filename": f["path"], "size": f["size"], "modified": f["modified"], "permissions": f["permissions"] })).collect::<Vec<_>>(),
        "disk_usage": disk(&p),
        "root_info": { "name": root, "permissions": perm },
    }))
}

async fn upload(State(p): State<P>, headers: HeaderMap, mut form: Multipart) -> Response {
    p.sync();
    let (full, fail_at) = {
        let m = p.lock();
        (m.faults.disk_full, m.faults.upload_fail)
    };
    if full {
        return err(507, "Insufficient disk space");
    }
    let total = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let (mut root, mut start, mut sub) = ("gcodes".to_string(), false, String::new());
    let mut saved: Option<(String, u64)> = None;
    loop {
        let field = match form.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return err(400, &format!("Upload interrupted: {e}")),
        };
        match field.name().unwrap_or("") {
            "root" => root = field.text().await.unwrap_or_default(),
            "print" => start = field.text().await.unwrap_or_default().eq_ignore_ascii_case("true"),
            "path" => sub = field.text().await.unwrap_or_default(),
            "file" => {
                if root != "gcodes" {
                    return err(403, &format!("Root {root} not writable"));
                }
                let name = field.file_name().unwrap_or("upload.gcode").to_string();
                let rel = if sub.trim_matches('/').is_empty() { name } else { format!("{}/{name}", sub.trim_matches('/')) };
                let Ok(dest) = p.files.path("gcodes", &rel) else { return err(400, "Invalid file name") };
                let part = dest.with_extension("upload");
                if let Some(d) = dest.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let Ok(mut out) = std::fs::File::create(&part) else { return err(500, "Cannot write the file") };
                let mut field = field;
                let mut got = 0u64;
                loop {
                    match field.chunk().await {
                        Ok(Some(c)) => {
                            got += c.len() as u64;
                            if std::io::Write::write_all(&mut out, &c).is_err() {
                                let _ = std::fs::remove_file(&part);
                                return err(500, "Cannot write the file");
                            }
                            if let Some(at) = fail_at {
                                if total > 0 && got as f64 * 100.0 / total as f64 >= at {
                                    drop(out);
                                    let _ = std::fs::remove_file(&part);
                                    return err(500, "Upload interrupted: connection lost (simulated)");
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let _ = std::fs::remove_file(&part);
                            return err(400, &format!("Upload interrupted: {e}"));
                        }
                    }
                }
                drop(out);
                if std::fs::rename(&part, &dest).is_err() {
                    return err(500, "Cannot write the file");
                }
                p.files.forget(&rel);
                saved = Some((rel, got));
            }
            _ => {}
        }
    }
    let Some((rel, size)) = saved else { return err(400, "No file uploaded") };
    // Read once now, as Moonraker reads a new file's metadata.
    let q = p.clone();
    let r = rel.clone();
    let _ = tokio::task::spawn_blocking(move || q.files.info(&r)).await;
    let started = if start { start_file(&p, &rel, None, &[]).await.is_ok() } else { false };
    p.sync();
    let item = json!({ "path": rel, "root": "gcodes", "size": size, "modified": p.lock().wall(), "permissions": "rw" });
    (
        StatusCode::CREATED,
        Json(json!({ "result": { "item": item, "print_started": started, "print_queued": false, "action": "create_file" } })),
    )
        .into_response()
}

async fn move_file(State(p): State<P>, Json(body): Json<Value>) -> Response {
    let split = |k: &str| body[k].as_str().and_then(|s| s.split_once('/')).map(|(r, x)| (r.to_string(), x.to_string()));
    let (Some((sr, sp)), Some((dr, dp))) = (split("source"), split("dest")) else { return err(400, "source and dest required") };
    if sr != "gcodes" || dr != "gcodes" {
        return err(403, "Root not writable");
    }
    let (Ok(src), Ok(dst)) = (p.files.path(&sr, &sp), p.files.path(&dr, &dp)) else { return err(400, "Invalid path") };
    if !src.is_file() {
        return err(404, &format!("File {sp} does not exist"));
    }
    if p.lock().run.as_ref().is_some_and(|r| r.file == sp) {
        return err(403, "File is currently being printed");
    }
    if dst.exists() {
        return err(409, &format!("File {dp} already exists"));
    }
    if std::fs::rename(&src, &dst).is_err() {
        return err(500, "Cannot move the file");
    }
    p.files.forget(&sp);
    ok(json!({ "item": { "path": dp, "root": "gcodes" }, "source_item": { "path": sp, "root": "gcodes" }, "action": "move_file" }))
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` within `len`.
fn range_of(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let spec = h?.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        return Some((len.saturating_sub(n), len - 1));
    }
    let a: u64 = a.parse().ok()?;
    let b = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
    Some((a, b))
}

async fn download(State(p): State<P>, UrlPath((root, path)): UrlPath<(String, String)>, headers: HeaderMap) -> Response {
    p.sync();
    let mime = crate::printer_files::mime_of(&path);
    if root == "camera" && path == "monitor.jpg" {
        if !p.lock().camera_on() {
            return err(404, "File monitor.jpg does not exist");
        }
        let card = p.card();
        let jpg = tokio::task::spawn_blocking(move || camera::frame(&card)).await.unwrap_or_default();
        return ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "no-store")], jpg).into_response();
    }
    let Ok(file) = p.files.path(&root, &path) else { return err(400, "Invalid path") };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let read = tokio::task::spawn_blocking(move || -> std::io::Result<(u64, Option<(u64, u64)>, Vec<u8>)> {
        use std::io::{Read, Seek};
        let mut f = std::fs::File::open(&file)?;
        let len = f.metadata()?.len();
        match range_of(range.as_deref(), len) {
            Some((a, b)) if a <= b => {
                f.seek(std::io::SeekFrom::Start(a))?;
                let mut buf = vec![0u8; (b - a + 1) as usize];
                f.read_exact(&mut buf)?;
                Ok((len, Some((a, b)), buf))
            }
            Some(_) => Ok((len, Some((len, len)), Vec::new())),
            None => {
                let mut buf = Vec::with_capacity(len as usize);
                f.read_to_end(&mut buf)?;
                Ok((len, None, buf))
            }
        }
    })
    .await;
    match read {
        Ok(Ok((len, Some((a, _)), _))) if a >= len => {
            Response::builder().status(416).header(header::CONTENT_RANGE, format!("bytes */{len}")).body(Body::empty()).unwrap_or_default()
        }
        Ok(Ok((len, Some((a, b)), body))) => Response::builder()
            .status(206)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes {a}-{b}/{len}"))
            .body(Body::from(body))
            .unwrap_or_default(),
        Ok(Ok((_, None, body))) => Response::builder()
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .body(Body::from(body))
            .unwrap_or_default(),
        _ => err(404, &format!("File {path} does not exist")),
    }
}

async fn delete(State(p): State<P>, UrlPath((root, path)): UrlPath<(String, String)>) -> Response {
    p.sync();
    if !Files::writable(&root) {
        return err(405, "Path not available for DELETE");
    }
    let Ok(file) = p.files.path(&root, &path) else { return err(400, "Invalid path") };
    if p.lock().run.as_ref().is_some_and(|r| r.file == path) {
        return err(403, "File is currently being printed");
    }
    if std::fs::remove_file(&file).is_err() {
        return err(404, &format!("File {path} does not exist"));
    }
    p.files.forget(&path);
    ok(json!({ "item": { "path": path, "root": root }, "action": "delete_file" }))
}

async fn history(State(p): State<P>, RawQuery(raw): RawQuery) -> Response {
    p.sync();
    let limit = arg(&raw, "limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(50);
    let start = arg(&raw, "start").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let asc = arg(&raw, "order").as_deref() == Some("asc");
    let m = p.lock();
    let mut jobs = m.history.clone();
    jobs.sort_by(|a, b| a["start_time"].as_f64().unwrap_or(0.0).total_cmp(&b["start_time"].as_f64().unwrap_or(0.0)));
    if !asc {
        jobs.reverse();
    }
    let count = jobs.len();
    ok(json!({ "count": count, "jobs": jobs.into_iter().skip(start).take(limit).collect::<Vec<_>>() }))
}

async fn totals(State(p): State<P>) -> Response {
    p.sync();
    ok(p.lock().totals())
}

/* ------------------------------------------------------------ control path */

async fn sim_status(State(p): State<P>) -> Response {
    p.sync();
    ok(p.status())
}

async fn sim_fault(State(p): State<P>, Json(f): Json<Fault>) -> Response {
    p.inject(f);
    ok(p.status())
}

async fn sim_clear(State(p): State<P>) -> Response {
    p.clear_faults();
    ok(p.status())
}

async fn sim_spool(State(p): State<P>, Json(body): Json<Value>) -> Response {
    let head = body["head"].as_u64().unwrap_or(0).min(3) as u8;
    let Ok(spool) = serde_json::from_value::<Spool>(body["spool"].clone()) else { return err(400, "spool expected") };
    p.set_spool(head, spool);
    ok(p.status())
}

/* ------------------------------------------------------------ websocket */

async fn websocket(State(p): State<P>, mut req: Request) -> Response {
    let Some(key) = req.headers().get(header::SEC_WEBSOCKET_KEY).map(|k| k.as_bytes().to_vec()) else {
        return err(400, "WebSocket upgrade expected");
    };
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(&key);
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let Ok(io) = upgrade.await else { return };
        let ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
            hyper_util::rt::TokioIo::new(io),
            tokio_tungstenite::tungstenite::protocol::Role::Server,
            None,
        )
        .await;
        session(p, ws).await;
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .body(Body::empty())
        .unwrap_or_default()
}

type Subs = Arc<Mutex<Vec<(String, Option<Vec<String>>)>>>;

async fn session<S>(p: P, ws: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let conn = p.conns.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = ws.split();
    let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || close {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let subs: Subs = Arc::default();
    let mut rx = p.tx.subscribe();
    let (fwd_out, fwd_subs) = (out.clone(), subs.clone());
    let forward = tokio::spawn(async move {
        loop {
            let msg = match rx.recv().await {
                Ok(Push::Status(changes, et)) => {
                    let wanted = fwd_subs.lock().map(|s| s.clone()).unwrap_or_default();
                    let mut d = Map::new();
                    for (name, fields) in &wanted {
                        let Some(Value::Object(o)) = changes.get(name) else { continue };
                        let o: Map<String, Value> = match fields {
                            Some(f) => o.iter().filter(|(k, _)| f.contains(k)).map(|(k, v)| (k.clone(), v.clone())).collect(),
                            None => o.clone(),
                        };
                        if !o.is_empty() {
                            d.insert(name.clone(), Value::Object(o));
                        }
                    }
                    if d.is_empty() {
                        continue;
                    }
                    json!({ "jsonrpc": "2.0", "method": "notify_status_update", "params": [d, et] })
                }
                Ok(Push::Method(_, _, Some(skip))) if skip == conn => continue,
                Ok(Push::Method(method, params, _)) => json!({ "jsonrpc": "2.0", "method": method, "params": params }),
                Ok(Push::Close) => {
                    let _ = fwd_out.send(Message::Close(None));
                    break;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if fwd_out.send(Message::Text(msg.to_string().into())).is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                let Ok(req) = serde_json::from_str::<Value>(&t) else { continue };
                let (p, out, subs) = (p.clone(), out.clone(), subs.clone());
                // Each request on its own: a long script does not hold the others.
                tokio::spawn(async move {
                    let id = req["id"].clone();
                    let method = req["method"].as_str().unwrap_or("").to_string();
                    let reply = match rpc(&p, &method, &req["params"], conn, &subs, &out).await {
                        Ok(result) => json!({ "jsonrpc": "2.0", "result": result, "id": id }),
                        Err((code, message)) => json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": id }),
                    };
                    if !id.is_null() {
                        let _ = out.send(Message::Text(reply.to_string().into()));
                    }
                });
            }
            Message::Ping(d) => {
                let _ = out.send(Message::Pong(d));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    forward.abort();
    drop(out);
    let _ = writer.await;
}

type Rpc = std::result::Result<Value, (i64, String)>;

fn not_found() -> (i64, String) {
    (-32601, "Method not found".into())
}

async fn rpc(p: &P, method: &str, params: &Value, conn: u64, subs: &Subs, out: &mpsc::UnboundedSender<Message>) -> Rpc {
    p.sync();
    let fail = |e: String| (400i64, e);
    match method {
        "server.connection.identify" => Ok(json!({ "connection_id": conn })),
        "server.info" => Ok(server_info_of(p)),
        "printer.info" => Ok(printer_info_of(p)),
        "printer.objects.list" => Ok(json!({ "objects": OBJECTS })),
        "printer.objects.query" => status_of(p, &wanted_of_json(&params["objects"])).map_err(|(c, m)| (c as i64, m)),
        "printer.objects.subscribe" => {
            let wanted = wanted_of_json(&params["objects"]);
            if let Ok(mut s) = subs.lock() {
                *s = wanted.clone();
            }
            status_of(p, &wanted).map_err(|(c, m)| (c as i64, m))
        }
        "printer.gcode.script" => {
            let script = params["script"].as_str().unwrap_or("").to_string();
            let (lines, r) = run_script(p, &script, Some(conn)).await;
            // The caller's own responses, before its answer.
            for l in lines {
                let n = json!({ "jsonrpc": "2.0", "method": "notify_gcode_response", "params": [l] });
                let _ = out.send(Message::Text(n.to_string().into()));
            }
            r.map(|_| json!("ok")).map_err(fail)
        }
        "printer.print.start" => {
            let f = params["filename"].as_str().unwrap_or("").to_string();
            start_file(p, &f, None, &[]).await.map(|_| json!("ok")).map_err(fail)
        }
        "printer.print.pause" => (p.lock().pause()).then(|| json!("ok")).ok_or_else(|| fail("Print not running".into())),
        "printer.print.resume" => p.lock().resume().map(|_| json!("ok")).map_err(fail),
        "printer.print.cancel" => p.lock().cancel().map(|_| json!("ok")).map_err(fail),
        "printer.emergency_stop" => {
            p.lock().shutdown("Shutdown due to webhooks request");
            Ok(json!("ok"))
        }
        "printer.firmware_restart" | "printer.restart" => {
            p.lock().firmware_restart();
            Ok(json!("ok"))
        }
        "server.files.start_local_print" => {
            let refused = {
                let m = p.lock();
                if m.faults.no_start_local_print {
                    return Err(not_found());
                }
                m.faults.start_refused.clone()
            };
            if let Some(msg) = refused {
                return Ok(json!({ "state": "error", "message": msg }));
            }
            let path = params["path"].as_str().unwrap_or("").to_string();
            let o = &params["options"];
            let flag = |k: &str| o[k].as_i64().or_else(|| o[k].as_str().and_then(|s| s.parse().ok())).unwrap_or(0) != 0;
            let opts = [flag("bed_level"), flag("flow_calibrate"), flag("time_lapse_camera")];
            let map: Vec<[u8; 2]> = o["map_table"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| Some([x.get(0)?.as_u64()? as u8, x.get(1)?.as_u64()? as u8])).collect())
                .unwrap_or_default();
            match start_file(p, &path, Some(opts), &map).await {
                Ok(()) => {
                    p.sync();
                    Ok(json!({ "state": "success" }))
                }
                Err(e) => Ok(json!({ "state": "error", "message": e })),
            }
        }
        "camera.start_monitor" => {
            let mut m = p.lock();
            if m.faults.camera_off {
                return Ok(json!({ "state": "failed", "message": "camera not available" }));
            }
            m.camera_until = m.last + 10.0;
            Ok(json!({ "state": "success" }))
        }
        "camera.stop_monitor" => {
            p.lock().camera_until = f64::NEG_INFINITY;
            Ok(json!({ "state": "success" }))
        }
        "camera.get_timelapse_instance" => {
            let list: Vec<Value> = p
                .lock()
                .timelapses
                .iter()
                .map(|(d, v)| json!({ "date_index": d, "video_path": format!("/userdata/.tmp_timelapse/{d}/{v}"), "status": "finished" }))
                .collect();
            Ok(json!({ "state": "success", "instances": list }))
        }
        "camera.delete_timelapse_instance" => {
            let idx = params["date_index"].as_str().unwrap_or("").to_string();
            let found = {
                let mut m = p.lock();
                let before = m.timelapses.len();
                let gone: Vec<(String, String)> = m.timelapses.iter().filter(|(d, _)| *d == idx).cloned().collect();
                m.timelapses.retain(|(d, _)| *d != idx);
                (before != m.timelapses.len()).then_some(gone)
            };
            let Some(gone) = found else { return Ok(json!({ "state": "failed", "message": "no such instance" })) };
            if let Ok(cam) = p.files.root_dir("camera") {
                for (d, v) in gone {
                    let _ = std::fs::remove_file(cam.join(v));
                    let _ = std::fs::remove_file(cam.join(format!("{d}.jpg")));
                }
            }
            Ok(json!({ "state": "success" }))
        }
        _ => Err(not_found()),
    }
}
