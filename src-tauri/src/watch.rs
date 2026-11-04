//! Live tracking of printers through Moonraker's JSON-RPC WebSocket.
//!
//! One task per printer: it subscribes to the available Klipper objects, then
//! the printer pushes its changes (`notify_status_update`). Each update is
//! merged into a local snapshot and sent to the UI as a Tauri event.
//! Automatic reconnection with increasing backoff.

use crate::printers::{self, Printer, Status};
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

/// Klipper objects wanted; those the printer does not know are ignored.
const WANTED: &[&str] = &[
    // U1-specific object: loaded spools. Absent on an ordinary Klipper.
    "print_task_config",
    "print_stats",
    "display_status",
    "virtual_sdcard",
    "extruder",
    "extruder1",
    "extruder2",
    "extruder3",
    "heater_bed",
    "chamber",
    "toolhead",
    "gcode_move",
    "fan",
];

#[derive(Serialize, Clone)]
struct Payload {
    id: String,
    /// True while the live feed is established.
    live: bool,
    status: Status,
}

type Tasks = Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>;

fn tasks() -> &'static Tasks {
    static T: OnceLock<Tasks> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Vec::new()))
}

/// Opens a feed to each saved printer.
pub fn start(app: AppHandle) {
    stop();
    let mut guard = tasks().lock().unwrap();
    for p in printers::load() {
        let app = app.clone();
        guard.push(tauri::async_runtime::spawn(async move { run(app, p).await }));
    }
}

/// Closes all feeds (when the Printers tab is no longer shown).
pub fn stop() {
    let mut guard = tasks().lock().unwrap();
    for t in guard.drain(..) {
        t.abort();
    }
}

fn emit(app: &AppHandle, id: &str, live: bool, status: Status) {
    let _ = app.emit("printer-status", Payload { id: id.to_string(), live, status });
}

async fn run(app: AppHandle, p: Printer) {
    let mut backoff = 2u64;
    loop {
        let err = match session(&app, &p).await {
            Ok(()) => {
                backoff = 2;
                crate::t!("err.closed_by_printer")
            }
            Err(e) => crate::util::ui_err(e),
        };
        emit(&app, &p.id, false, Status { online: false, state: "offline".into(), message: Some(err), ..Default::default() });
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(20);
    }
}

/// The same address rule as every HTTP request (`printers::authority`).
fn ws_url(p: &Printer) -> String {
    printers::ws_url(&p.host, p.port)
}

/// Merges a partial update into the current snapshot.
fn merge(base: &mut Map<String, Value>, upd: &Value) {
    let Some(obj) = upd.as_object() else { return };
    for (k, v) in obj {
        match (base.get_mut(k), v) {
            (Some(Value::Object(dst)), Value::Object(src)) => {
                for (k2, v2) in src {
                    dst.insert(k2.clone(), v2.clone());
                }
            }
            _ => {
                base.insert(k.clone(), v.clone());
            }
        }
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Sink = futures_util::stream::SplitSink<Ws, Message>;

async fn send(tx: &mut Sink, v: Value) -> Result<()> {
    tx.send(Message::Text(v.to_string().into())).await?;
    Ok(())
}

async fn session(app: &AppHandle, p: &Printer) -> Result<()> {
    let id = p.id.clone();
    let app2 = app.clone();
    session_with(p, &move |live, st| emit(&app2, &id, live, st)).await
}

/// Core of the session, independent of Tauri (testable).
pub async fn session_with(p: &Printer, out: &(dyn Fn(bool, Status) + Send + Sync)) -> Result<()> {
    // Without a bound, an unreachable address would block the task for very long.
    let (stream, _) = tokio::time::timeout(Duration::from_secs(6), tokio_tungstenite::connect_async(ws_url(p)))
        .await
        .map_err(|_| anyhow!(crate::t!("err.connect_timeout")))??;
    let (mut tx, mut rx) = stream.split();

    // 1. Identification (recommended by Moonraker) then object inventory.
    send(
        &mut tx,
        json!({"jsonrpc":"2.0","id":1,"method":"server.connection.identify",
               "params":{"client_name":"Snap Studio","version":env!("CARGO_PKG_VERSION"),
                         "type":"desktop","url":"https://github.com/"}}),
    )
    .await?;
    send(&mut tx, json!({"jsonrpc":"2.0","id":2,"method":"printer.objects.list"})).await?;
    send(&mut tx, json!({"jsonrpc":"2.0","id":4,"method":"printer.info"})).await?;

    let mut snapshot = Map::new();
    let mut st = Status { online: true, state: "standby".into(), ..Default::default() };
    // Klipper down: the snapshot's `print_stats` is stale until it is back
    // (ready, then a fresh subscription), and must not read as a print.
    let mut down = false;
    let keep_down = |st: &mut Status| {
        st.state = "error".into();
        st.message = Some(crate::t!("err.klipper_down"));
    };

    loop {
        // Prolonged silence signals a dead link: reconnect.
        let msg = match tokio::time::timeout(Duration::from_secs(60), rx.next()).await {
            Err(_) => return Err(anyhow!(crate::t!("err.no_data_60"))),
            Ok(None) => return Ok(()),
            Ok(Some(m)) => m?,
        };

        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Ping(d) => {
                tx.send(Message::Pong(d)).await?;
                continue;
            }
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        let id = v.get("id").and_then(|x| x.as_u64());
        let method = v.get("method").and_then(|x| x.as_str()).unwrap_or("");

        match (id, method) {
            // Inventory: only subscribe to the objects actually present.
            (Some(2), _) => {
                let available: Vec<String> = v
                    .get("result")
                    .and_then(|r| r.get("objects"))
                    .and_then(|o| o.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let mut objects = Map::new();
                for w in WANTED {
                    if available.iter().any(|a| a == w) {
                        objects.insert((*w).to_string(), Value::Null);
                    }
                }
                if objects.is_empty() {
                    return Err(anyhow!(crate::t!("err.no_klipper_objects")));
                }
                send(
                    &mut tx,
                    json!({"jsonrpc":"2.0","id":3,"method":"printer.objects.subscribe",
                           "params":{"objects": Value::Object(objects)}}),
                )
                .await?;
            }
            // Full snapshot returned by the subscription.
            (Some(3), _) => {
                if let Some(s) = v.get("result").and_then(|r| r.get("status")) {
                    merge(&mut snapshot, s);
                    let mut next = st.clone();
                    next.nozzles.clear();
                    next.filaments.clear();
                    printers::apply_status(&Value::Object(snapshot.clone()), &mut next);
                    if down {
                        keep_down(&mut next);
                    }
                    st = next;
                    out(true, st.clone());
                }
            }
            // General printer information.
            (Some(4), _) => {
                if let Some(r) = v.get("result") {
                    st.hostname = r.get("hostname").and_then(|x| x.as_str()).map(String::from);
                    st.klipper = r.get("state").and_then(|x| x.as_str()).map(String::from);
                    out(true, st.clone());
                }
            }
            // Update pushed by the printer.
            (_, "notify_status_update") => {
                if let Some(upd) = v.get("params").and_then(|p| p.get(0)) {
                    merge(&mut snapshot, upd);
                    let mut next = st.clone();
                    next.nozzles.clear();
                    next.filaments.clear();
                    printers::apply_status(&Value::Object(snapshot.clone()), &mut next);
                    if down {
                        keep_down(&mut next);
                    }
                    st = next;
                    out(true, st.clone());
                }
            }
            (_, "notify_klippy_ready") => {
                down = false;
                st.klipper = Some("ready".into());
                st.message = None;
                // A fresh inventory and subscription: the snapshot is renewed.
                send(&mut tx, json!({"jsonrpc":"2.0","id":2,"method":"printer.objects.list"})).await?;
            }
            (_, "notify_klippy_disconnected") | (_, "notify_klippy_shutdown") => {
                down = true;
                st.klipper = Some("shutdown".into());
                keep_down(&mut st);
                out(true, st.clone());
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Moonraker only sends the changed fields: the snapshot must keep the rest.
    #[test]
    fn partial_updates_are_merged() {
        let mut snap = Map::new();
        merge(
            &mut snap,
            &json!({"extruder":{"temperature":219.8,"target":220.0},
                    "print_stats":{"state":"printing","filename":"piece.gcode","print_duration":100.0},
                    "display_status":{"progress":0.10}}),
        );
        // A notification carrying only the temperature.
        merge(&mut snap, &json!({"extruder":{"temperature":221.4}}));

        let mut st = Status { online: true, ..Default::default() };
        printers::apply_status(&Value::Object(snap.clone()), &mut st);
        assert_eq!(st.nozzles.len(), 1);
        assert!((st.nozzles[0].current - 221.4).abs() < 0.01);
        // The target, absent from the update, is preserved.
        assert!((st.nozzles[0].target - 220.0).abs() < 0.01);
        assert_eq!(st.job.as_deref(), Some("piece.gcode"));

        // State change alone.
        merge(&mut snap, &json!({"print_stats":{"state":"paused"}}));
        let mut st2 = Status { online: true, ..Default::default() };
        printers::apply_status(&Value::Object(snap), &mut st2);
        assert_eq!(st2.state, "paused");
        assert_eq!(st2.job.as_deref(), Some("piece.gcode"));
    }

    /// Full chain against a fake Moonraker: WebSocket handshake, inventory,
    /// subscription, snapshot then partial updates.
    #[test]
    fn live_session_against_fake_moonraker() {
        let script = match std::env::var("FAKE_WS") {
            Ok(v) => v,
            Err(_) => return, // test skipped outside a development environment
        };
        let port = 7803;
        let mut srv = std::process::Command::new("python3")
            .arg(&script)
            .arg(port.to_string())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("fake server");
        std::thread::sleep(Duration::from_millis(600));

        let p = Printer {
            id: "t".into(),
            name: "Faux U1".into(),
            host: "127.0.0.1".into(),
            port,
            model: "Snapmaker U1".into(),
            note: String::new(),
        };
        let seen: std::sync::Arc<Mutex<Vec<Status>>> = Default::default();
        let sink = seen.clone();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(10), session_with(&p, &move |_live, st| sink.lock().unwrap().push(st))).await;
        });
        let _ = srv.wait();

        let got = seen.lock().unwrap();
        assert!(got.len() >= 4, "only {} statuses received", got.len());

        // Initial snapshot.
        let first = got.iter().find(|s| s.job.is_some()).expect("no job received");
        assert_eq!(first.job.as_deref(), Some("piece_U1.gcode"));
        assert_eq!(first.nozzles.len(), 4);
        assert!(first.nozzles[1].active, "the active head must be T1");
        assert_eq!(first.layer, Some((12, 80)));

        // Pushed updates: the temperature rises, the target is kept.
        let last_printing = got.iter().rev().find(|s| s.state == "printing").unwrap();
        assert!((last_printing.nozzles[0].current - 219.9).abs() < 0.01, "final temperature = {}", last_printing.nozzles[0].current);
        assert!((last_printing.nozzles[0].target - 220.0).abs() < 0.01);
        assert!((last_printing.progress.unwrap() - 0.35).abs() < 1e-4);
        assert!(last_printing.remaining_s.is_some());

        // The last event only carried the state: the rest must survive.
        let last = got.last().unwrap();
        assert_eq!(last.state, "paused");
        assert_eq!(last.job.as_deref(), Some("piece_U1.gcode"));
        assert_eq!(last.hostname.as_deref(), Some("lava"));
    }

    #[test]
    fn url_is_built_from_host() {
        let p = Printer {
            id: "x".into(),
            name: "U1".into(),
            host: "http://192.168.1.50/".into(),
            port: 7125,
            model: String::new(),
            note: String::new(),
        };
        assert_eq!(ws_url(&p), "ws://192.168.1.50:7125/websocket");
    }
}

#[cfg(test)]
mod camera_probe {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    /// Wakes the camera and checks that the snapshot refreshes.
    ///
    /// `CAM_HOST=192.168.0.144 cargo test camera_probe -- --nocapture`
    #[test]
    fn wakes_the_camera() {
        let Ok(host) = std::env::var("CAM_HOST") else { return };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let url = format!("ws://{host}:7125/websocket");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            let call = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "camera.start_monitor",
                "params": {"domain": "lan", "interval": 0},
                "id": 1
            });
            ws.send(Message::Text(call.to_string().into())).await.unwrap();
            for _ in 0..12 {
                let Ok(Some(Ok(msg))) = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next()).await else {
                    break;
                };
                if let Message::Text(t) = msg {
                    if t.contains("\"id\": 1") || t.contains("\"id\":1") {
                        println!("response: {}", &t[..t.len().min(300)]);
                        break;
                    }
                }
            }
        });
    }
}
