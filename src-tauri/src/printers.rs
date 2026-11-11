//! Printer management and status reading.
//!
//! The Snapmaker U1 embeds Klipper + Moonraker: status is read over HTTP from
//! the Moonraker API, without cloud nor authentication. The same requests work
//! on any Klipper printer (Voron, Prusa Core One, etc.).

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Printer {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub note: String,
}

fn store_path() -> PathBuf {
    crate::util::app_dir().join("printers.json")
}

pub fn load() -> Vec<Printer> {
    std::fs::read(store_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(list: &[Printer]) -> Result<()> {
    crate::util::write_atomic(&store_path(), &serde_json::to_vec_pretty(list)?)
}

pub fn new_id() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", crate::util::fnv1a(&[&n.to_le_bytes()]))
}

/* ------------------------------------------------------------- status */

#[derive(Serialize, Default, Clone)]
pub struct Temp {
    pub current: f32,
    pub target: f32,
}

/// A spool loaded in one of the machine's slots.
#[derive(Serialize, Clone, Default)]
pub struct Filament {
    pub index: u8,
    pub kind: String,
    pub sub_type: String,
    /// Color in "#rrggbb" format.
    pub color: Option<String>,
    pub vendor: String,
    pub present: bool,
    /// Slot used by the current print.
    pub used: bool,
}

/// The U1 has four heads (T0 to T3): `extruder`, `extruder1`, `extruder2`, `extruder3`.
#[derive(Serialize, Clone)]
pub struct Nozzle {
    pub index: u8,
    pub current: f32,
    pub target: f32,
    pub active: bool,
}

#[derive(Serialize, Default, Clone)]
pub struct Status {
    pub online: bool,
    /// standby | printing | paused | complete | cancelled | error | offline
    pub state: String,
    pub message: Option<String>,
    pub hostname: Option<String>,
    pub klipper: Option<String>,
    pub job: Option<String>,
    /// 0.0 to 1.0
    pub progress: Option<f32>,
    pub elapsed_s: Option<f32>,
    pub remaining_s: Option<f32>,
    pub filament_mm: Option<f32>,
    pub nozzles: Vec<Nozzle>,
    pub filaments: Vec<Filament>,
    pub bed: Option<Temp>,
    pub chamber: Option<Temp>,
    pub fan: Option<f32>,
    pub speed_factor: Option<f32>,
    pub layer: Option<(u32, u32)>,
    pub error: Option<String>,
    /// Print objects unreadable this time (timeout…): the state is not the
    /// print's, it does not prove the print is over.
    #[serde(skip)]
    pub partial: bool,
    /// Position in the file (`virtual_sdcard.progress`), 0.0 to 1.0: tells a
    /// time-based `M73 P` in `progress` from the file position.
    #[serde(skip)]
    pub file_progress: Option<f32>,
    /// Bytes of the file read (`virtual_sdcard.file_position`).
    #[serde(skip)]
    pub file_position: Option<u64>,
}

pub(crate) fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(4))
            .connect_timeout(Duration::from_secs(2))
            .user_agent("Snap-Studio")
            .build()
            .expect("client HTTP")
    })
}

/// A printer's `host:port`, the one rule for every address built from a
/// saved printer: a scheme the user typed is dropped, a trailing slash too,
/// and the saved port is added unless the host carries one already
/// ("192.168.1.50:7125"). HTTP and WebSocket thus reach the same port.
pub(crate) fn authority(host: &str, port: u16) -> String {
    let h = host.trim();
    let h = ["http://", "https://", "ws://", "wss://"].iter().fold(h, |h, s| h.strip_prefix(s).unwrap_or(h));
    let h = h.trim_end_matches('/');
    if h.contains(':') {
        h.to_string()
    } else {
        format!("{h}:{port}")
    }
}

/// A host given as `https://` or `wss://` (a reverse proxy) keeps TLS, for
/// HTTP and for the WebSocket alike.
fn secure(host: &str) -> bool {
    let h = host.trim();
    h.starts_with("https://") || h.starts_with("wss://")
}

pub(crate) fn base(host: &str, port: u16) -> String {
    format!("{}://{}", if secure(host) { "https" } else { "http" }, authority(host, port))
}

pub(crate) fn ws_url(host: &str, port: u16) -> String {
    format!("{}://{}/websocket", if secure(host) { "wss" } else { "ws" }, authority(host, port))
}

pub(crate) async fn get_json(url: &str) -> Result<Value> {
    let r = client().get(url).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    Ok(r.json::<Value>().await?)
}

pub(crate) async fn get_text(url: &str) -> Result<String> {
    let r = client().get(url).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    Ok(r.text().await?)
}

fn f32_of(v: &Value) -> Option<f32> {
    v.as_f64().map(|x| x as f32)
}

fn temp_of(v: Option<&Value>) -> Option<Temp> {
    let o = v?;
    Some(Temp { current: f32_of(o.get("temperature")?)?, target: o.get("target").and_then(f32_of).unwrap_or(0.0) })
}

// ------------------------------------------------------------ sending a print

/// Client without a global timeout: an upload can last several minutes.
fn long_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder().connect_timeout(Duration::from_secs(4)).user_agent("Snap-Studio").build().expect("client HTTP")
    })
}

/// Launch options offered by Snapmaker Orca for the U1.
#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug)]
pub struct StartOptions {
    /// Automatic bed leveling.
    pub bed_leveling: bool,
    /// Extrusion flow calibration.
    pub flow_calibration: bool,
    /// Timelapse camera.
    pub timelapse: bool,
}

impl StartOptions {
    /// The options as Snapmaker Orca sends them: its keys, 1 or 0. The
    /// firmware reads them as integers (`get_int`): `true` is refused.
    pub fn orca_entries(&self) -> [(&'static str, u8); 3] {
        [
            ("bed_level", self.bed_leveling as u8),
            ("flow_calibrate", self.flow_calibration as u8),
            ("time_lapse_camera", self.timelapse as u8),
        ]
    }

    /// The same options as `print_task_config` reports them, with the
    /// `i18n` key of their label in the send sheet.
    fn status_entries(&self) -> [(&'static str, bool, &'static str); 3] {
        [
            ("auto_bed_leveling", self.bed_leveling, "send.leveling"),
            ("flow_calibrate", self.flow_calibration, "send.flow"),
            ("time_lapse_camera", self.timelapse, "send.timelapse"),
        ]
    }
}

/// Head mapping sent before the launch, as Snapmaker Orca does: tool → head
/// for every used tool, then the heads used.
pub fn map_script(tools: &[u8], map: &[(u8, u8)]) -> String {
    let mut lines: Vec<String> = Vec::new();
    // Every used tool gets its entry (the firmware resets none): the head
    // chosen as a substitute, otherwise the head of the same number.
    let heads: Vec<u8> = tools.iter().map(|t| head_of(*t, map)).collect();
    for (t, h) in tools.iter().zip(&heads) {
        lines.push(format!("SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER={t} MAP_EXTRUDER={h}"));
    }
    if !heads.is_empty() {
        // Physical heads the task uses.
        let mut used = heads.clone();
        used.sort_unstable();
        used.dedup();
        let list: Vec<String> = used.iter().map(|t| t.to_string()).collect();
        lines.push(format!("SET_PRINT_USED_EXTRUDERS EXTRUDERS={}", list.join(",")));
    }
    lines.join("\n")
}

/// One `SET_PRINT_PREFERENCE` per option, as Snapmaker Orca sends them
/// before a launch. Not every firmware knows it (the public 1.6.0 does not):
/// sent for what it is worth, the options of the start request are what
/// count.
pub fn preference_script(opts: &StartOptions) -> String {
    opts.orca_entries().iter().map(|(k, v)| format!("SET_PRINT_PREFERENCE KEY={k} VALUE={v}")).collect::<Vec<_>>().join("\n")
}

/// The options in one `SET_PRINT_PREFERENCES`, for a start without
/// `start_local_print`: `BED_LEVEL=1 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=1`.
pub fn legacy_preferences_script(opts: &StartOptions) -> String {
    let kv: Vec<String> = opts.orca_entries().iter().map(|(k, v)| format!("{}={v}", k.to_uppercase())).collect();
    format!("SET_PRINT_PREFERENCES {}", kv.join(" "))
}

/// `[tool, head]` pairs of the used tools, the head mapping of the start
/// request (the firmware resets its map when a print starts with options).
pub fn map_table(tools: &[u8], map: &[(u8, u8)]) -> Vec<[u8; 2]> {
    tools.iter().map(|t| [*t, head_of(*t, map)]).collect()
}

/// Parameters of `server.files.start_local_print`, shaped as Snapmaker
/// Orca's: file type, path under `gcodes`, plate, options (1 or 0) and head
/// mapping.
pub fn start_request(path: &str, opts: &StartOptions, tools: &[u8], map: &[(u8, u8)]) -> Value {
    let kind = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && !e.contains('/'))
        .unwrap_or_else(|| "gcode".into());
    let mut options = serde_json::Map::new();
    for (k, v) in opts.orca_entries() {
        options.insert(k.into(), v.into());
    }
    options.insert("map_table".into(), serde_json::json!(map_table(tools, map)));
    serde_json::json!({
        "type": kind,
        "path": path,
        "print_plate": 1,
        "options": options,
    })
}

/// True when a substitution really moves a tool to another head.
pub fn is_remap(map: &[(u8, u8)]) -> bool {
    map.iter().any(|(t, h)| t != h)
}

/// Extruder map back to identity, tool `n` on head `n`. The firmware keeps
/// the last map it was given, and Snap Studio only rewrites the entries of
/// the tools a print uses: after a print sent with a substitution, a print
/// started elsewhere (the printer's screen) could inherit it.
pub fn identity_map_script() -> String {
    (0..4u8).map(|h| format!("SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER={h} MAP_EXTRUDER={h}")).collect::<Vec<_>>().join("\n")
}

/// Head printing a G-code tool: its substitute, otherwise the same number.
pub fn head_of(tool: u8, map: &[(u8, u8)]) -> u8 {
    map.iter().find(|(t, _)| *t == tool).map(|(_, h)| *h).unwrap_or(tool)
}

/// A substitution is only taken when it stays one tool per head and
/// within the U1's four heads: two tools on one head would merge colors.
pub fn check_map(tools: &[u8], map: &[(u8, u8)]) -> Result<()> {
    if map.iter().any(|(t, h)| *h > 3 || !tools.contains(t)) {
        return Err(anyhow!("invalid head substitution"));
    }
    let mut heads: Vec<u8> = tools.iter().map(|t| head_of(*t, map)).collect();
    heads.sort_unstable();
    let n = heads.len();
    heads.dedup();
    if heads.len() != n {
        return Err(anyhow!("two tools on the same head"));
    }
    Ok(())
}

/// Runs a G-code script; the error reports Klipper's answer.
pub async fn gcode_script(host: &str, port: u16, script: &str) -> Result<()> {
    gcode_script_for(host, port, script, Duration::from_secs(30)).await
}

/// The same, for a script that lasts (Moonraker answers when it is done).
pub async fn gcode_script_for(host: &str, port: u16, script: &str, timeout: Duration) -> Result<()> {
    let r = long_client()
        .post(format!("{}/printer/gcode/script", base(host, port)))
        .timeout(timeout)
        .json(&serde_json::json!({ "script": script }))
        .send()
        .await?;
    if r.status().is_success() {
        return Ok(());
    }
    let code = r.status().as_u16();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    let msg = body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("unexpected response");
    Err(anyhow!("HTTP {code}: {msg}"))
}

/// Commands of `script` Klipper answered `Unknown command` to. Klipper does
/// not fail on an unknown command: it only says so in its responses.
pub fn unknown_commands(responses: &[String], script: &str) -> Vec<String> {
    let ours: Vec<&str> = script.lines().filter_map(|l| l.split_whitespace().next()).collect();
    let mut out: Vec<String> = Vec::new();
    for r in responses {
        let Some(i) = r.find("Unknown command") else { continue };
        let name = r[i..].split('"').nth(1).map(|n| n.trim().to_string()).unwrap_or_default();
        let known = ours.iter().any(|c| c.eq_ignore_ascii_case(&name));
        if known && !out.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            out.push(name);
        }
    }
    out
}

/// Runs a G-code script over the websocket, reading Klipper's responses: a
/// command it does not know is a failure, not a silent success.
pub async fn gcode_script_checked(host: &str, port: u16, script: &str) -> Result<()> {
    let (_, responses) =
        ws_session(host, port, "printer.gcode.script", serde_json::json!({ "script": script }), Duration::from_secs(30)).await?;
    let unknown = unknown_commands(&responses, script);
    if !unknown.is_empty() {
        return Err(anyhow!(crate::t!("err.unknown_command", cmd = unknown.join(", "))));
    }
    Ok(())
}

/// How a print was started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartRoute {
    /// `server.files.start_local_print`, options in the request.
    Orca,
    /// `SET_PRINT_PREFERENCES`, then `printer.print.start`.
    Legacy,
}

/// Starts a file of `gcodes` with its options, as Snapmaker Orca does:
/// `server.files.start_local_print` with the options (1 or 0) and the head
/// mapping. A printer without it (Moonraker refuses the method, or does not
/// answer) gets the options in `SET_PRINT_PREFERENCES`, then a plain start.
/// A printer that refuses the print itself (busy, nozzle mismatch…) is not
/// asked again another way.
pub async fn start_print(host: &str, port: u16, path: &str, opts: &StartOptions, tools: &[u8], map: &[(u8, u8)]) -> Result<StartRoute> {
    let req = start_request(path, opts, tools, map);
    let err = match ws_session(host, port, "server.files.start_local_print", req, Duration::from_secs(45)).await {
        Ok((v, _)) => {
            if v.get("state").and_then(|s| s.as_str()) == Some("success") {
                return Ok(StartRoute::Orca);
            }
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("refused");
            return Err(anyhow!("{msg}"));
        }
        Err(e) => e,
    };
    // Only a firmware without the method is asked the other way. A refusal
    // (busy, nozzle mismatch: a JSON-RPC error) is the answer; so is a
    // connection failure, which the other way would meet too.
    let (missing, late) = match err.downcast_ref::<WsError>() {
        Some(w) => (w.method_missing(), matches!(w, WsError::Timeout { .. })),
        None => (false, false),
    };
    if late {
        // An answer that came too late: the print may have started all the same.
        let st = status(host, port).await;
        if matches!(st.state.as_str(), "printing" | "paused") {
            return Ok(StartRoute::Orca);
        }
    }
    if !missing {
        return Err(err);
    }
    eprintln!("[print] start_local_print unavailable ({err}): SET_PRINT_PREFERENCES then printer.print.start");
    gcode_script_checked(host, port, &legacy_preferences_script(opts))
        .await
        .map_err(|e| anyhow!(crate::t!("err.prepare_refused", err = e)))?;
    crate::printer_files::start(host, port, path).await?;
    Ok(StartRoute::Legacy)
}

/// A bare POST to Moonraker (`/printer/emergency_stop`…): its `result`
/// (Null when there is none).
pub(crate) async fn post_path(host: &str, port: u16, path: &str) -> Result<Value> {
    let r = client().post(format!("{}{path}", base(host, port))).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!(crate::t!("err.printer_refuses", status = r.status())));
    }
    Ok(r.json::<Value>().await.map(|v| v["result"].clone()).unwrap_or(Value::Null))
}

/// Pause, resume or cancel the running print.
pub async fn print_action(host: &str, port: u16, action: &str) -> Result<()> {
    let action = match action {
        "pause" | "resume" | "cancel" => action,
        _ => return Err(anyhow!("unknown action: {action}")),
    };
    let r = client().post(format!("{}/printer/print/{action}", base(host, port))).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!(crate::t!("err.printer_refuses", status = r.status())));
    }
    Ok(())
}

/// `print_task_config` as the printer sees it, to check the options.
pub async fn task_config(host: &str, port: u16) -> Option<Value> {
    let url = format!("{}/printer/objects/query?print_task_config", base(host, port));
    let v = get_json(&url).await.ok()?;
    v.pointer("/result/status/print_task_config").cloned()
}

/// Options the printer did not take into account (empty when all is well,
/// or when it does not expose them).
pub fn unapplied_options(cfg: &Value, opts: &StartOptions) -> Vec<&'static str> {
    opts.status_entries()
        .iter()
        .filter(|(k, want, _)| match cfg.get(*k) {
            Some(Value::Bool(b)) => b != want,
            Some(Value::Number(n)) => (n.as_f64().unwrap_or(0.0) != 0.0) != *want,
            Some(Value::String(s)) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1") != *want,
            _ => false,
        })
        .map(|(_, _, label)| *label)
        .collect()
}

/// Uploads a G-code into `gcodes/` and, if asked, starts the print.
/// `progress(sent, total)` follows the bytes as they go.
pub async fn upload(
    host: &str,
    port: u16,
    path: &std::path::Path,
    remote_name: &str,
    start: bool,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> Result<()> {
    // Read as it is sent, 64 KiB at a time: a G-code of hundreds of
    // megabytes is not held in memory (it was, twice over).
    let total = std::fs::metadata(path).with_context(|| format!("reading {}", path.display()))?.len();
    let mut file =
        std::io::BufReader::with_capacity(256 * 1024, std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?);
    let mut sent = 0u64;
    let stream = futures_util::stream::iter(std::iter::from_fn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        match std::io::Read::read(&mut file, &mut buf) {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                sent += n as u64;
                progress(sent, total);
                Some(Ok::<Vec<u8>, std::io::Error>(buf))
            }
            Err(e) => Some(Err(e)),
        }
    }));
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
        .file_name(remote_name.to_string())
        .mime_str("application/octet-stream")?;
    let form =
        reqwest::multipart::Form::new().text("root", "gcodes").text("print", if start { "true" } else { "false" }).part("file", part);
    let r = long_client().post(format!("{}/server/files/upload", base(host, port))).multipart(form).send().await?;
    if !r.status().is_success() {
        let code = r.status().as_u16();
        let body: Value = r.json().await.unwrap_or(Value::Null);
        let msg = body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("refused");
        return Err(anyhow!(crate::t!("err.upload_refused", code = code, msg = msg)));
    }
    Ok(())
}

// ------------------------------------------------------------ camera

/// Calls a JSON-RPC method on Moonraker's websocket and waits for its answer.
/// Snapmaker's own methods (`camera.*`) are not relayed over HTTP by the U1's
/// nginx: the websocket is the only way.
pub async fn ws_call(host: &str, port: u16, method: &str, params: Value) -> Result<Value> {
    ws_session(host, port, method, params, Duration::from_secs(8)).await.map(|(v, _)| v)
}

/// The same, with its own timeout, also returning the G-code responses
/// Moonraker relayed meanwhile (`notify_gcode_response`).
pub async fn ws_session(host: &str, port: u16, method: &str, params: Value, timeout: Duration) -> Result<(Value, Vec<String>)> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let url = ws_url(host, port);
    let run = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(url.as_str()).await?;
        let req = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": 1 });
        ws.send(Message::Text(req.to_string().into())).await?;
        let mut responses: Vec<String> = Vec::new();
        while let Some(msg) = ws.next().await {
            let Message::Text(t) = msg? else { continue };
            let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
            if v.get("method").and_then(|m| m.as_str()) == Some("notify_gcode_response") {
                if let Some(lines) = v.get("params").and_then(|p| p.as_array()) {
                    responses.extend(lines.iter().filter_map(|l| l.as_str()).map(String::from));
                }
                continue;
            }
            if v.get("id").and_then(|i| i.as_i64()) != Some(1) {
                continue; // status notifications, unrelated
            }
            let _ = ws.close(None).await;
            if let Some(e) = v.get("error") {
                let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("erreur");
                return Err(WsError::Rpc {
                    method: method.to_string(),
                    code: e.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
                    message: msg.to_string(),
                }
                .into());
            }
            return Ok((v.get("result").cloned().unwrap_or(Value::Null), responses));
        }
        Err(anyhow!(crate::t!("err.ws_closed", method = method)))
    };
    tokio::time::timeout(timeout, run).await.map_err(|_| WsError::Timeout { method: method.to_string() })?
}

/// What a WebSocket request can fail on, when the caller must tell them
/// apart (`start_print`): the printer answered with an error, or did not
/// answer in time. Connection failures stay plain errors.
#[derive(Debug)]
pub enum WsError {
    /// Answered with a JSON-RPC error. `code` -32601 is a method the
    /// firmware does not have, as opposed to a request it refused.
    Rpc {
        method: String,
        code: i64,
        message: String,
    },
    Timeout {
        method: String,
    },
}

impl WsError {
    /// The firmware does not know the method: another way may be tried.
    pub fn method_missing(&self) -> bool {
        match self {
            WsError::Rpc { code, message, .. } => *code == -32601 || message.to_ascii_lowercase().contains("method not found"),
            WsError::Timeout { .. } => false,
        }
    }
}

impl std::fmt::Display for WsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WsError::Rpc { method, message, .. } => write!(f, "{method} : {message}"),
            WsError::Timeout { method } => f.write_str(&crate::t!("err.ws_no_answer", method = method)),
        }
    }
}

impl std::error::Error for WsError {}

/// Wakes the U1's camera: it then publishes a continuously renewed image,
/// and switches itself off unless restarted (about 10 s).
pub async fn camera_start(host: &str, port: u16) -> Result<()> {
    let r = ws_call(host, port, "camera.start_monitor", serde_json::json!({ "domain": "lan", "interval": 0 })).await?;
    match r.get("state").and_then(|s| s.as_str()) {
        Some("success") | None => Ok(()),
        Some(other) => Err(anyhow!(crate::t!("err.camera", err = other))),
    }
}

pub async fn camera_stop(host: &str, port: u16) -> Result<()> {
    ws_call(host, port, "camera.stop_monitor", serde_json::json!({ "domain": "lan" })).await.map(|_| ())
}

/// Latest camera image (JPEG), as Snapmaker Orca reads it.
pub async fn camera_frame(host: &str, port: u16) -> Result<Vec<u8>> {
    let url = format!("{}/server/files/camera/monitor.jpg", base(host, port));
    let r = client().get(url).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    Ok(r.bytes().await?.to_vec())
}

/// Klipper objects queried at each refresh.
const OBJECTS: &str =
    "print_task_config&print_stats&display_status&virtual_sdcard&extruder&extruder1&extruder2&extruder3&heater_bed&toolhead&gcode_move&fan";

pub async fn status(host: &str, port: u16) -> Status {
    let b = base(host, port);
    let mut st = Status { state: "offline".into(), ..Default::default() };

    // 1. Is Moonraker reachable and Klipper ready?
    match get_json(&format!("{b}/server/info")).await {
        Ok(v) => {
            st.online = true;
            let r = v.get("result").unwrap_or(&Value::Null);
            st.klipper = r.get("klippy_state").and_then(|s| s.as_str()).map(String::from);
            if r.get("klippy_connected").and_then(|b| b.as_bool()) == Some(false) {
                st.state = "error".into();
                st.message = Some(crate::t!("err.klipper_not_connected"));
            }
        }
        Err(e) => {
            st.message = Some(crate::util::ui_err(e));
            return st;
        }
    }

    if let Ok(v) = get_json(&format!("{b}/printer/info")).await {
        let r = v.get("result").unwrap_or(&Value::Null);
        st.hostname = r.get("hostname").and_then(|s| s.as_str()).map(String::from);
        if let Some(m) = r.get("state_message").and_then(|s| s.as_str()) {
            if r.get("state").and_then(|s| s.as_str()) != Some("ready") {
                st.message = Some(m.trim().to_string());
                st.state = "error".into();
            }
        }
    }

    // 2. Print objects.
    let Ok(v) = get_json(&format!("{b}/printer/objects/query?{OBJECTS}")).await else {
        if st.state == "offline" {
            st.state = "standby".into();
        }
        st.partial = true;
        return st;
    };
    apply_objects(&v, &mut st);
    let est = job_estimate(host, port, &st);
    apply_estimate(&mut st, est);
    st
}

/// How long a read of the slicer's estimate that got no answer waits
/// before another try (a printer busy at the start of a print).
const ESTIMATE_RETRY: Duration = Duration::from_secs(30);

/// What the file's metadata tells of a job: the slicer's estimate, how the
/// printer counts its progress, and where its G-code starts and ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlicerEstimate {
    /// `estimated_time`, in seconds; 0 when the file has none (another
    /// slicer).
    pub seconds: f32,
    /// The progress follows the slicer's `M73 P`, a share of the time, rather
    /// than the file position. Kept for the whole job once seen: a percentage
    /// in whole numbers meets the file position now and then.
    pub time_based: bool,
    /// `gcode_start_byte` and `gcode_end_byte`: the bytes of the print
    /// itself, between the file's header and its trailing settings.
    pub gcode: Option<(u64, u64)>,
}

/// The slicer's estimate of the job being printed, per printer.
struct JobEstimate {
    job: String,
    /// The job was printing or paused at the last status seen.
    active: bool,
    /// The printer answered the read (with an estimate or without one).
    answered: bool,
    estimate: Option<f32>,
    gcode: Option<(u64, u64)>,
    time_based: bool,
    /// When the last read started.
    asked: Instant,
    /// Bumped at each read: a late answer for an older one is dropped.
    generation: u64,
}

fn job_estimates() -> &'static std::sync::Mutex<std::collections::HashMap<String, JobEstimate>> {
    static C: OnceLock<std::sync::Mutex<std::collections::HashMap<String, JobEstimate>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// The progress differs from the file position: a time-based `M73 P`.
fn progress_is_time_based(st: &Status) -> bool {
    matches!((st.progress, st.file_progress), (Some(p), Some(f)) if (f - p).abs() > 0.005)
}

/// What the cache knows of the printer's job: its estimate, and the
/// generation of the read to start, at a new job or when the last read got
/// no answer for a while.
///
/// A new job is a print that starts (the state turns to printing or paused)
/// or another file name: the slicer can rewrite a file under the same name,
/// so a name alone does not keep an old estimate.
fn estimate_entry(
    cache: &mut std::collections::HashMap<String, JobEstimate>,
    key: &str,
    st: &Status,
    now: Instant,
) -> (Option<SlicerEstimate>, Option<u64>) {
    let active = matches!(st.state.as_str(), "printing" | "paused");
    let Some(job) = st.job.as_deref().filter(|_| active) else {
        if let Some(e) = cache.get_mut(key) {
            e.active = false;
        }
        return (None, None);
    };
    let e = cache.entry(key.to_string()).or_insert_with(|| JobEstimate {
        job: String::new(),
        active: false,
        answered: false,
        estimate: None,
        gcode: None,
        time_based: false,
        asked: now,
        generation: 0,
    });
    let same_job = e.active && e.job == job;
    if !same_job {
        e.job = job.to_string();
        e.active = true;
        e.answered = false;
        e.estimate = None;
        e.gcode = None;
        e.time_based = false;
    }
    e.time_based |= progress_is_time_based(st);
    let fetch = if !same_job || (!e.answered && now.duration_since(e.asked) >= ESTIMATE_RETRY) {
        e.asked = now;
        e.generation += 1;
        Some(e.generation)
    } else {
        None
    };
    let known = (e.estimate.is_some() || e.gcode.is_some()).then(|| SlicerEstimate {
        seconds: e.estimate.unwrap_or(0.0),
        time_based: e.time_based,
        gcode: e.gcode,
    });
    (known, fetch)
}

/// The slicer's estimate (`estimated_time`, seconds) of the printer's job,
/// and its G-code bytes, for the poll and the live feed alike.
///
/// Never waits: the file's metadata is read in the background and the
/// estimate is there from a later status on; until then, `None`.
pub fn job_estimate(host: &str, port: u16, st: &Status) -> Option<SlicerEstimate> {
    let key = base(host, port);
    let (est, fetch) = {
        let Ok(mut cache) = job_estimates().lock() else { return None };
        estimate_entry(&mut cache, &key, st, Instant::now())
    };
    if let (Some(generation), Some(job)) = (fetch, st.job.as_deref()) {
        let url = format!("{key}/server/files/metadata?filename={}", urlencoding::encode(job));
        tauri::async_runtime::spawn(async move {
            let Ok(v) = get_json(&url).await else { return };
            let est = v.pointer("/result/estimated_time").and_then(f32_of).filter(|e| *e > 0.0);
            let byte = |k: &str| v.pointer(&format!("/result/{k}")).and_then(|x| x.as_u64());
            let gcode = byte("gcode_start_byte").zip(byte("gcode_end_byte")).filter(|(a, b)| a < b);
            if let Ok(mut cache) = job_estimates().lock() {
                if let Some(e) = cache.get_mut(&key).filter(|e| e.generation == generation) {
                    e.answered = true;
                    e.estimate = est;
                    e.gcode = gcode;
                }
            }
        });
    }
    est
}

/// Time left from the slicer's estimate, as the printer's screen counts it,
/// instead of the extrapolation of `apply_status`.
///
/// With a time-based `M73 P`, the share of the estimate still to print;
/// otherwise the estimate minus the time printed, as Mainsail's "slicer"
/// estimate. Neither is scaled by the speed factor. Without an estimate
/// (G-code from another slicer), or once the print overruns it, the
/// extrapolation stays.
///
/// Then the percentage, as the printer's screen counts it: the share of the
/// print's G-code read (`gcode_start_byte` to `gcode_end_byte`), rather than
/// the slicer's time-based `M73 P`. Measured on a U1: 38 % on the screen
/// when `M73 P40` came, 17 % for `M73 P24`. The time left above still uses
/// `M73 P`, a share of the time.
pub fn apply_estimate(st: &mut Status, estimate: Option<SlicerEstimate>) {
    let Some(est) = estimate else { return };
    apply_time_left(st, &est);
    if let (Some(range), Some(pos)) = (est.gcode, st.file_position) {
        if matches!(st.state.as_str(), "printing" | "paused") {
            st.progress = Some(share_of_gcode(pos, range));
        }
    }
}

/// The share of the print's G-code read, 0.0 to 1.0: the header before it
/// counts as nothing, the settings after it as all.
pub fn share_of_gcode(pos: u64, (start, end): (u64, u64)) -> f32 {
    if end <= start {
        return 0.0;
    }
    (pos.clamp(start, end) - start) as f32 / (end - start) as f32
}

fn apply_time_left(st: &mut Status, est: &SlicerEstimate) {
    if est.seconds <= 0.0 || st.state != "printing" {
        return;
    }
    let (Some(p), Some(elapsed)) = (st.progress, st.elapsed_s) else { return };
    if !(0.0..1.0).contains(&p) {
        return;
    }
    let time_based = est.time_based || progress_is_time_based(st);
    let left = if time_based { est.seconds * (1.0 - p) } else { est.seconds - elapsed };
    if left > 0.0 {
        st.remaining_s = Some(left);
    }
}

/// Turns the `/printer/objects/query` answer into a displayable status.
pub fn apply_objects(v: &Value, st: &mut Status) {
    let s = v.get("result").and_then(|r| r.get("status")).cloned().unwrap_or(Value::Null);
    apply_status(&s, st);
}

/// Same processing from the `status` object alone (WebSocket feed).
pub fn apply_status(s: &Value, st: &mut Status) {
    if let Some(ps) = s.get("print_stats") {
        if let Some(state) = ps.get("state").and_then(|x| x.as_str()) {
            st.state = state.to_string();
        }
        st.job = ps.get("filename").and_then(|x| x.as_str()).filter(|f| !f.is_empty()).map(String::from);
        st.elapsed_s = ps.get("print_duration").and_then(f32_of);
        st.filament_mm = ps.get("filament_used").and_then(f32_of);
        // Given, even empty, it is the printer's word: a message it has
        // cleared goes away too (the live feed starts from the last status).
        if let Some(m) = ps.get("message").and_then(|x| x.as_str()) {
            st.message = Some(m.to_string()).filter(|m| !m.is_empty());
        }
        if let Some(i) = ps.get("info") {
            let cur = i.get("current_layer").and_then(|x| x.as_u64());
            let tot = i.get("total_layer").and_then(|x| x.as_u64());
            if let (Some(c), Some(t)) = (cur, tot) {
                st.layer = Some((c as u32, t as u32));
            }
        }
    }

    // Progress: display_status if present, otherwise progress in the file.
    st.file_progress = s.get("virtual_sdcard").and_then(|d| d.get("progress")).and_then(f32_of);
    st.file_position = s.get("virtual_sdcard").and_then(|d| d.get("file_position")).and_then(|x| x.as_u64());
    st.progress = s.get("display_status").and_then(|d| d.get("progress")).and_then(f32_of).or(st.file_progress);

    // Remaining time extrapolated from the progress (Moonraker does not give
    // it); `apply_estimate` replaces it with the slicer's estimate when known.
    if let (Some(p), Some(e)) = (st.progress, st.elapsed_s) {
        if p > 0.02 && p < 1.0 && st.state == "printing" {
            st.remaining_s = Some(e * (1.0 - p) / p);
        }
    }

    // Active head: `toolhead.extruder` gives its name ("extruder1" for instance).
    let active = s.get("toolhead").and_then(|t| t.get("extruder")).and_then(|x| x.as_str()).unwrap_or("extruder").to_string();
    for i in 0..4u8 {
        let key = if i == 0 { "extruder".to_string() } else { format!("extruder{i}") };
        if let Some(t) = temp_of(s.get(&key)) {
            st.nozzles.push(Nozzle { index: i, current: t.current, target: t.target, active: key == active });
        }
    }

    apply_filaments(s.get("print_task_config"), st);

    st.bed = temp_of(s.get("heater_bed"));
    st.chamber = temp_of(s.get("chamber"));
    st.fan = s.get("fan").and_then(|f| f.get("speed")).and_then(f32_of);
    st.speed_factor = s.get("gcode_move").and_then(|g| g.get("speed_factor")).and_then(f32_of);
}

#[derive(Serialize)]
pub struct Probe {
    pub ok: bool,
    pub detail: String,
    pub hostname: Option<String>,
    pub api: Option<String>,
    /// Port that answered: Moonraker listens on 7125 and behind nginx on 80.
    pub port: u16,
}

/// Checks an address typed by the user before saving it. Tries the given
/// port, then Moonraker's other usual port.
pub async fn probe(host: &str, port: u16) -> Probe {
    let first = probe_one(host, port).await;
    if first.ok {
        return first;
    }
    let alt = if port == 7125 { 80 } else { 7125 };
    let second = probe_one(host, alt).await;
    if second.ok {
        return second;
    }
    first
}

async fn probe_one(host: &str, port: u16) -> Probe {
    let b = base(host, port);
    match get_json(&format!("{b}/printer/info")).await {
        Ok(v) => {
            let r = v.get("result").unwrap_or(&Value::Null);
            let hostname = r.get("hostname").and_then(|s| s.as_str()).map(String::from);
            let state = r.get("state").and_then(|s| s.as_str()).unwrap_or("?");
            return Probe {
                ok: true,
                detail: crate::t!(
                    "probe.moonraker",
                    port = port,
                    state = state,
                    host = hostname.as_deref().map(|h| crate::t!("probe.host", host = h)).unwrap_or_default()
                ),
                hostname,
                api: Some("moonraker".into()),
                port,
            };
        }
        Err(e1) => {
            // Fallback: OctoPrint-compatible identification.
            match get_json(&format!("{b}/api/version")).await {
                Ok(v) => Probe {
                    ok: true,
                    detail: crate::t!(
                        "probe.octoprint",
                        port = port,
                        name = v.get("text").and_then(|s| s.as_str()).map(String::from).unwrap_or_else(|| crate::t!("probe.the_printer"))
                    ),
                    hostname: None,
                    api: Some("octoprint".into()),
                    port,
                },
                Err(e2) => {
                    Probe { ok: false, detail: crate::t!("probe.none", port = port, e1 = e1, e2 = e2), hostname: None, api: None, port }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Typical answer of a Snapmaker U1 (Klipper + Moonraker) while printing.
    const SAMPLE: &str = r#"{"result":{"eventtime":4210.1,"status":{
      "print_stats":{"filename":"Frame_200x200_PLA_1h28m.gcode","state":"printing",
        "print_duration":1832.4,"total_duration":1901.0,"filament_used":4218.7,"message":"",
        "info":{"current_layer":42,"total_layer":118}},
      "display_status":{"progress":0.3612},
      "virtual_sdcard":{"progress":0.3598,"is_active":true},
      "extruder":{"temperature":219.8,"target":220.0},
      "extruder1":{"temperature":168.2,"target":170.0},
      "extruder2":{"temperature":25.4,"target":0.0},
      "extruder3":{"temperature":25.1,"target":0.0},
      "heater_bed":{"temperature":59.8,"target":60.0},
      "toolhead":{"extruder":"extruder1","position":[110.2,98.4,8.6,214.3]},
      "gcode_move":{"speed_factor":1.15},
      "fan":{"speed":0.85}}}}"#;

    #[test]
    fn decode_u1_status() {
        let v: Value = serde_json::from_str(SAMPLE).unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);

        assert_eq!(st.state, "printing");
        assert_eq!(st.job.as_deref(), Some("Frame_200x200_PLA_1h28m.gcode"));
        assert_eq!(st.layer, Some((42, 118)));
        assert!((st.progress.unwrap() - 0.3612).abs() < 1e-4);
        // Remaining time from the progress: 1832 s for 36 % => ~3241 s.
        let rem = st.remaining_s.unwrap();
        assert!((rem - 3240.0).abs() < 60.0, "restant = {rem}");

        // Four heads, T1 active.
        assert_eq!(st.nozzles.len(), 4);
        assert_eq!(st.nozzles[1].index, 1);
        assert!(st.nozzles[1].active);
        assert!(!st.nozzles[0].active);
        assert!((st.nozzles[0].current - 219.8).abs() < 0.01);

        assert!((st.bed.as_ref().unwrap().target - 60.0).abs() < 0.01);
        assert!((st.fan.unwrap() - 0.85).abs() < 0.01);
        assert!((st.speed_factor.unwrap() - 1.15).abs() < 0.01);
    }

    /// Camera of a real U1: `CAMERA_HOST=192.168.x.x cargo test camera_on_real_printer`.
    #[test]
    fn camera_on_real_printer() {
        let Ok(host) = std::env::var("CAMERA_HOST") else { return };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            camera_start(&host, 80).await.expect("start");
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let mut sizes = Vec::new();
            for _ in 0..3 {
                let jpg = camera_frame(&host, 80).await.expect("image");
                assert_eq!(&jpg[..2], &[0xFF, 0xD8], "JPEG");
                sizes.push(jpg.len());
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            println!("images : {sizes:?} octets");
            camera_stop(&host, 80).await.expect("stop");
        });
    }

    /// Print preparation, as Snapmaker Orca sends it.
    #[test]
    fn preparation_matches_snapmaker_orca() {
        let s = map_script(&[0, 2], &[]);
        assert_eq!(
            s,
            "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=0\n\
             SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=2 MAP_EXTRUDER=2\n\
             SET_PRINT_USED_EXTRUDERS EXTRUDERS=0,2"
        );
        let o = StartOptions { bed_leveling: true, flow_calibration: false, timelapse: true };
        // Integers, never `true`: the firmware reads them with `get_int`.
        assert_eq!(
            preference_script(&o),
            "SET_PRINT_PREFERENCE KEY=bed_level VALUE=1\n\
             SET_PRINT_PREFERENCE KEY=flow_calibrate VALUE=0\n\
             SET_PRINT_PREFERENCE KEY=time_lapse_camera VALUE=1"
        );
        assert_eq!(legacy_preferences_script(&o), "SET_PRINT_PREFERENCES BED_LEVEL=1 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=1");
        assert_eq!(
            legacy_preferences_script(&StartOptions::default()),
            "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0"
        );
    }

    /// `server.files.start_local_print`, shaped as Snapmaker Orca's.
    #[test]
    fn start_request_matches_snapmaker_orca() {
        let o = StartOptions { bed_leveling: false, flow_calibration: true, timelapse: true };
        let r = start_request("Cube-3f9a0c.gcode", &o, &[0, 2], &[(2, 3)]);
        assert_eq!(
            r,
            serde_json::json!({
                "type": "gcode",
                "path": "Cube-3f9a0c.gcode",
                "print_plate": 1,
                "options": {
                    "bed_level": 0,
                    "flow_calibrate": 1,
                    "time_lapse_camera": 1,
                    "map_table": [[0, 0], [2, 3]],
                },
            })
        );
        // Values are numbers, not booleans (Moonraker passes `str(v)` on).
        assert!(r["options"]["time_lapse_camera"].is_u64());
        // A file in a folder, an upper-case extension, no extension.
        assert_eq!(start_request("a.b/Part.GCODE", &o, &[1], &[])["type"], "gcode");
        assert_eq!(start_request("dir.v2/part", &o, &[1], &[])["type"], "gcode");
        assert_eq!(start_request("x.gcode", &o, &[1], &[])["options"]["map_table"], serde_json::json!([[1, 1]]));
    }

    #[test]
    fn unknown_commands_are_failures() {
        let script = preference_script(&StartOptions::default());
        let replies = vec![
            "// Unknown command:\"SET_PRINT_PREFERENCE\"".to_string(),
            "// Unknown command:\"SET_PRINT_PREFERENCE\"".to_string(),
            "// Unknown command:\"SOMETHING_ELSE\"".to_string(),
            "ok".to_string(),
        ];
        assert_eq!(unknown_commands(&replies, &script), vec!["SET_PRINT_PREFERENCE"]);
        assert!(unknown_commands(&["// Klipper state: Ready".to_string()], &script).is_empty());
        assert!(unknown_commands(&[], &script).is_empty());
    }

    #[test]
    fn substituted_heads_are_mapped() {
        let s = map_script(&[0, 2], &[(2, 3)]);
        assert_eq!(
            s,
            "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=0\n\
             SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=2 MAP_EXTRUDER=3\n\
             SET_PRINT_USED_EXTRUDERS EXTRUDERS=0,3"
        );
        assert_eq!(map_table(&[0, 2], &[(2, 3)]), vec![[0, 0], [2, 3]]);
        // Swap: still one tool per head.
        let s = map_script(&[0, 1], &[(0, 1), (1, 0)]);
        assert!(s.contains("CONFIG_EXTRUDER=0 MAP_EXTRUDER=1") && s.contains("CONFIG_EXTRUDER=1 MAP_EXTRUDER=0"));
        assert!(s.ends_with("EXTRUDERS=0,1"));
        assert_eq!(map_table(&[0, 1], &[(0, 1), (1, 0)]), vec![[0, 1], [1, 0]]);
        assert!(check_map(&[0, 1], &[(0, 1), (1, 0)]).is_ok());
        assert!(check_map(&[0, 2], &[(2, 0)]).is_err(), "T0 and T2 on head 0");
        assert!(check_map(&[0], &[(0, 4)]).is_err(), "no head 4");
        assert!(check_map(&[0], &[(1, 2)]).is_err(), "T1 is not used");
        assert_eq!(head_of(1, &[(2, 3)]), 1);
        assert!(is_remap(&[(1, 3)]) && !is_remap(&[]) && !is_remap(&[(2, 2)]));
        let id = identity_map_script();
        assert_eq!(id.lines().count(), 4);
        assert!(id.ends_with("CONFIG_EXTRUDER=3 MAP_EXTRUDER=3"));
    }

    #[test]
    fn unapplied_options_are_reported() {
        let o = StartOptions { bed_leveling: true, flow_calibration: false, timelapse: true };
        let cfg = serde_json::json!({"auto_bed_leveling": true, "flow_calibrate": false, "time_lapse_camera": false});
        assert_eq!(unapplied_options(&cfg, &o), vec!["send.timelapse"]);
        let cfg = serde_json::json!({"auto_bed_leveling": 0, "flow_calibrate": "false", "time_lapse_camera": 1});
        assert_eq!(unapplied_options(&cfg, &o), vec!["send.leveling"]);
        assert!(unapplied_options(&serde_json::json!({}), &o).is_empty(), "nothing exposed: nothing to report");
    }

    /// Loaded spools, in the format the U1 actually emits.
    #[test]
    fn decode_loaded_filaments() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_task_config":{
              "filament_type":["PLA","PLA","PLA","PETG"],
              "filament_sub_type":["","","",""],
              "filament_color":[4294967295,4278190080,4278204278,4278190080],
              "filament_color_rgba":["FFFFFFFF","000000FF","003776FF","000000FF"],
              "filament_exist":[true,true,true,false],
              "filament_vendor":[],
              "extruders_used":[2]}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);

        assert_eq!(st.filaments.len(), 4);
        assert_eq!(st.filaments[0].kind, "PLA");
        assert_eq!(st.filaments[0].color.as_deref(), Some("#ffffff"));
        assert_eq!(st.filaments[2].color.as_deref(), Some("#003776"));
        assert_eq!(st.filaments[3].kind, "PETG");
        assert!(st.filaments[1].present);
        assert!(!st.filaments[3].present, "T3 is reported empty");
        assert!(st.filaments[2].used, "T2 is used by the job");
        assert!(!st.filaments[0].used);
    }

    /// An unloaded slot, as a U1 reports it after "Unload": type, subtype
    /// and vendor "NONE", filament_exist false, the colour left white.
    #[test]
    fn decode_unloaded_slot() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_task_config":{
              "filament_vendor":["Generic","Generic","NONE","Generic"],
              "filament_type":["PLA","PLA","NONE","PETG"],
              "filament_sub_type":["","","NONE",""],
              "filament_color_rgba":["FFFFFFFF","000000FF","FFFFFFFF","000000FF"],
              "filament_exist":[true,true,false,true]}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);
        let t2 = &st.filaments[2];
        assert_eq!((t2.kind.as_str(), t2.sub_type.as_str(), t2.vendor.as_str(), t2.present), ("", "", "", false));
        assert_eq!(st.filaments[3].vendor, "Generic");
    }

    /// Fallback when only the ARGB integer is given.
    #[test]
    fn decode_filament_color_from_int() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_task_config":{
              "filament_type":["PLA"],"filament_color":[4278204278]}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);
        assert_eq!(st.filaments[0].color.as_deref(), Some("#003776"));
        assert!(st.filaments[0].present, "type given => slot occupied");
    }

    /// A plain Klipper printer (single nozzle, no layer counter).
    #[test]
    fn decode_minimal_klipper() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_stats":{"state":"standby","filename":""},
              "extruder":{"temperature":24.5,"target":0.0},
              "heater_bed":{"temperature":23.9,"target":0.0}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);
        assert_eq!(st.state, "standby");
        assert!(st.job.is_none());
        assert_eq!(st.nozzles.len(), 1);
        assert!(st.nozzles[0].active);
        assert!(st.progress.is_none());
        assert!(st.remaining_s.is_none());
        assert!(st.filaments.is_empty(), "no print_task_config on an ordinary Klipper");
    }

    fn printing(progress: f32, file: f32, elapsed: f32) -> Status {
        let v = serde_json::json!({
            "print_stats": {"state": "printing", "filename": "a.gcode", "print_duration": elapsed},
            "display_status": {"progress": progress},
            "virtual_sdcard": {"progress": file},
        });
        let mut st = Status::default();
        apply_status(&v, &mut st);
        st
    }

    fn est(seconds: f32) -> Option<SlicerEstimate> {
        Some(SlicerEstimate { seconds, time_based: false, gcode: None })
    }

    /// The progress follows the file: the estimate minus the time printed.
    #[test]
    fn time_left_from_the_slicer_estimate() {
        let v: Value = serde_json::from_str(SAMPLE).unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);
        apply_estimate(&mut st, est(5280.0));
        // 5280 s estimated, 1832 s printed (the extrapolation gave ~3240 s).
        assert!((st.remaining_s.unwrap() - 3448.0).abs() < 1.0, "{:?}", st.remaining_s);
    }

    /// A time-based `M73 P`, apart from the file position: its share of the estimate.
    #[test]
    fn time_left_from_a_time_based_progress() {
        let mut st = printing(0.25, 0.60, 2000.0);
        apply_estimate(&mut st, est(6000.0));
        assert!((st.remaining_s.unwrap() - 4500.0).abs() < 1.0, "{:?}", st.remaining_s);
        // Shown from the start, where the extrapolation waits for 2 %.
        let mut st = printing(0.0, 0.01, 240.0);
        assert!(st.remaining_s.is_none());
        apply_estimate(&mut st, est(6000.0));
        assert_eq!(st.remaining_s, Some(6000.0));
        // Once seen time-based, a whole percentage meeting the file position
        // keeps the same count (no jump by the print's lead or delay).
        let mut st = printing(0.60, 0.6023, 4000.0);
        apply_estimate(&mut st, Some(SlicerEstimate { seconds: 6000.0, time_based: true, gcode: None }));
        assert!((st.remaining_s.unwrap() - 2400.0).abs() < 1.0, "{:?}", st.remaining_s);
    }

    /// No estimate, an overrun estimate or no print: the extrapolation stays.
    #[test]
    fn extrapolation_without_a_usable_estimate() {
        let extrapolated = printing(0.5, 0.5, 1000.0).remaining_s;
        assert!((extrapolated.unwrap() - 1000.0).abs() < 1.0);
        for e in [None, est(0.0), est(900.0)] {
            let mut st = printing(0.5, 0.5, 1000.0);
            apply_estimate(&mut st, e);
            assert_eq!(st.remaining_s, extrapolated, "estimate {e:?}");
        }
        let mut st = printing(0.5, 0.5, 1000.0);
        st.state = "paused".into();
        apply_estimate(&mut st, est(3000.0));
        assert_eq!(st.remaining_s, extrapolated);
    }

    fn job(name: Option<&str>, state: &str, progress: f32, file: f32) -> Status {
        Status {
            job: name.map(String::from),
            state: state.into(),
            progress: Some(progress),
            file_progress: Some(file),
            ..Default::default()
        }
    }

    fn answer(c: &mut std::collections::HashMap<String, JobEstimate>, k: &str, estimate: Option<f32>) {
        let e = c.get_mut(k).unwrap();
        e.answered = true;
        e.estimate = estimate;
    }

    /// The estimate is read again at each new job, even under the same name.
    #[test]
    fn estimate_read_again_at_each_new_job() {
        let mut c = std::collections::HashMap::new();
        let k = "http://u1:7125";
        let t = Instant::now();
        let a = |state| job(Some("a.gcode"), state, 0.1, 0.1);
        let b = |state| job(Some("b.gcode"), state, 0.1, 0.1);
        // First status of a print: fetch, nothing known yet.
        assert_eq!(estimate_entry(&mut c, k, &a("printing"), t), (None, Some(1)));
        answer(&mut c, k, Some(600.0));
        // Same job, paused then printing again: kept.
        assert_eq!(estimate_entry(&mut c, k, &a("paused"), t), (est(600.0), None));
        assert_eq!(estimate_entry(&mut c, k, &a("printing"), t), (est(600.0), None));
        // Another file: a new job.
        assert_eq!(estimate_entry(&mut c, k, &b("printing"), t), (None, Some(2)));
        answer(&mut c, k, Some(900.0));
        // Over, then the same name printed again (maybe rewritten by the slicer).
        assert_eq!(estimate_entry(&mut c, k, &b("complete"), t), (None, None));
        assert_eq!(estimate_entry(&mut c, k, &b("printing"), t), (None, Some(3)));
        // Another printer has its own job.
        assert_eq!(estimate_entry(&mut c, "http://u1b:7125", &b("printing"), t), (None, Some(1)));
        // No job name: nothing to read.
        assert_eq!(estimate_entry(&mut c, "http://u1c:7125", &job(None, "printing", 0.1, 0.1), t), (None, None));
    }

    /// A read with no answer is tried again after a while; an answer without
    /// an estimate (another slicer) is not.
    #[test]
    fn estimate_read_again_after_no_answer() {
        let mut c = std::collections::HashMap::new();
        let k = "http://u1:7125";
        let t = Instant::now();
        let a = job(Some("a.gcode"), "printing", 0.1, 0.1);
        assert_eq!(estimate_entry(&mut c, k, &a, t), (None, Some(1)));
        assert_eq!(estimate_entry(&mut c, k, &a, t + Duration::from_secs(10)), (None, None));
        assert_eq!(estimate_entry(&mut c, k, &a, t + ESTIMATE_RETRY), (None, Some(2)));
        answer(&mut c, k, None);
        assert_eq!(estimate_entry(&mut c, k, &a, t + ESTIMATE_RETRY * 3), (None, None));
    }

    /// The share of the print's G-code read, header and trailing settings aside.
    #[test]
    fn share_of_the_gcode() {
        // Bytes of a U1 print (Snapmaker Orca 2.4, 645 501 bytes).
        let range = (50_673, 617_849);
        assert_eq!(share_of_gcode(0, range), 0.0);
        assert_eq!(share_of_gcode(50_673, range), 0.0);
        assert!((share_of_gcode(334_261, range) - 0.5).abs() < 1e-4);
        assert_eq!(share_of_gcode(617_849, range), 1.0);
        assert_eq!(share_of_gcode(645_501, range), 1.0);
        assert_eq!(share_of_gcode(10, (5, 5)), 0.0);
    }

    /// The percentage as on the printer's screen, the time left from `M73 P`.
    #[test]
    fn progress_as_on_the_screen() {
        // Measured on a U1: M73 P24 at 22.6 % of the file, 17 % on the screen.
        let mut st = printing(0.24, 0.226, 84.0);
        st.file_position = Some(145_883);
        let gcode = Some((50_673, 617_849));
        apply_estimate(&mut st, Some(SlicerEstimate { seconds: 347.0, time_based: true, gcode }));
        assert_eq!((st.progress.unwrap() * 100.0).round(), 17.0);
        assert!((st.remaining_s.unwrap() - 347.0 * 0.76).abs() < 1.0, "{:?}", st.remaining_s);
        // Paused: the percentage too.
        let mut st = printing(0.24, 0.226, 84.0);
        st.state = "paused".into();
        st.file_position = Some(145_883);
        apply_estimate(&mut st, Some(SlicerEstimate { seconds: 0.0, time_based: false, gcode }));
        assert_eq!((st.progress.unwrap() * 100.0).round(), 17.0);
        // Without the G-code bytes, or over: the printer's percentage stays.
        let mut st = printing(0.24, 0.226, 84.0);
        st.file_position = Some(145_883);
        apply_estimate(&mut st, est(347.0));
        assert_eq!(st.progress, Some(0.24));
        let mut st = printing(1.0, 1.0, 360.0);
        st.state = "complete".into();
        st.file_position = Some(645_501);
        apply_estimate(&mut st, Some(SlicerEstimate { seconds: 347.0, time_based: true, gcode }));
        assert_eq!(st.progress, Some(1.0));
    }

    /// The file's G-code bytes are kept with the job, without an estimate too.
    #[test]
    fn gcode_bytes_kept_with_the_job() {
        let mut c = std::collections::HashMap::new();
        let k = "http://u1:7125";
        let t = Instant::now();
        let a = job(Some("a.gcode"), "printing", 0.1, 0.1);
        estimate_entry(&mut c, k, &a, t);
        let e = c.get_mut(k).unwrap();
        e.answered = true;
        e.gcode = Some((100, 900));
        let known = Some(SlicerEstimate { seconds: 0.0, time_based: false, gcode: Some((100, 900)) });
        assert_eq!(estimate_entry(&mut c, k, &a, t), (known, None));
        estimate_entry(&mut c, k, &job(Some("b.gcode"), "printing", 0.1, 0.1), t);
        assert_eq!(c[k].gcode, None);
    }

    /// A time-based progress, once seen, holds for the job and not the next.
    #[test]
    fn time_based_progress_kept_for_the_job() {
        let mut c = std::collections::HashMap::new();
        let k = "http://u1:7125";
        let t = Instant::now();
        let at = |p, f| job(Some("a.gcode"), "printing", p, f);
        estimate_entry(&mut c, k, &at(0.0, 0.0), t);
        answer(&mut c, k, Some(5592.0));
        assert_eq!(estimate_entry(&mut c, k, &at(0.0, 0.0), t).0, est(5592.0));
        // Measured on a U1: M73 P20 while 10.9 % of the file is read.
        let seen = Some(SlicerEstimate { seconds: 5592.0, time_based: true, gcode: None });
        assert_eq!(estimate_entry(&mut c, k, &at(0.20, 0.1094), t).0, seen);
        // M73 P60 at 59.77 %: still time-based.
        assert_eq!(estimate_entry(&mut c, k, &at(0.60, 0.5977), t).0, seen);
        // The next job starts over.
        estimate_entry(&mut c, k, &job(Some("b.gcode"), "printing", 0.0, 0.0), t);
        answer(&mut c, k, Some(100.0));
        assert_eq!(estimate_entry(&mut c, k, &job(Some("b.gcode"), "printing", 0.0, 0.0), t).0, est(100.0));
    }
}

/// A text of `print_task_config`; the U1 reports an empty slot's type,
/// subtype and vendor as "NONE": read as nothing.
fn str_at(v: Option<&Value>, i: usize) -> String {
    let s = v.and_then(|a| a.get(i)).and_then(|x| x.as_str()).unwrap_or("").trim();
    if s.eq_ignore_ascii_case("none") {
        String::new()
    } else {
        s.to_string()
    }
}

/// Color of a slot: "RRGGBBAA" string or ARGB integer depending on firmware.
fn slot_color(cfg: &Value, i: usize) -> Option<String> {
    if let Some(s) = cfg.get("filament_color_rgba").and_then(|a| a.get(i)).and_then(|x| x.as_str()) {
        let h = s.trim().trim_start_matches('#');
        // `get`: a non-ASCII character at the cut (a firmware's string) must
        // not panic, least of all in the jobs monitor.
        if let Some(h6) = h.get(..6) {
            return Some(format!("#{}", h6.to_ascii_lowercase()));
        }
    }
    let n = cfg.get("filament_color")?.get(i)?.as_u64()?;
    Some(format!("#{:06x}", n & 0x00ff_ffff))
}

/// `print_task_config`: Klipper object specific to the Snapmaker U1
/// describing the loaded spools, an array of four values per field.
pub fn apply_filaments(cfg: Option<&Value>, st: &mut Status) {
    let Some(cfg) = cfg else { return };
    let len = ["filament_type", "filament_exist", "filament_color_rgba", "filament_color"]
        .iter()
        .filter_map(|k| cfg.get(*k).and_then(|a| a.as_array()).map(|a| a.len()))
        .max()
        .unwrap_or(0)
        .min(8);

    // `extruders_used` lists either indices, or a boolean per slot.
    let used = cfg.get("extruders_used").and_then(|x| x.as_array());
    let is_used = |i: usize| -> bool {
        let Some(u) = used else { return false };
        u.iter().enumerate().any(|(j, v)| match v {
            Value::Bool(b) => *b && j == i,
            Value::Number(n) => n.as_u64() == Some(i as u64),
            _ => false,
        })
    };

    for i in 0..len {
        let kind = str_at(cfg.get("filament_type"), i);
        let color = slot_color(cfg, i);
        let present = cfg.get("filament_exist").and_then(|a| a.get(i)).and_then(|x| x.as_bool()).unwrap_or(!kind.is_empty());
        if kind.is_empty() && color.is_none() && !present {
            continue;
        }
        st.filaments.push(Filament {
            index: i as u8,
            kind,
            sub_type: str_at(cfg.get("filament_sub_type"), i),
            color,
            vendor: str_at(cfg.get("filament_vendor"), i),
            present,
            used: is_used(i),
        });
    }
}

#[cfg(test)]
mod hex_tests {
    use super::slot_color;
    use serde_json::json;

    #[test]
    fn slot_colours_cut_safely() {
        let cfg = json!({ "filament_color_rgba": ["#FF8000FF", "aaaaaé", "#é"], "filament_color": [0, 0xff00ff, 0x123456] });
        assert_eq!(slot_color(&cfg, 0).as_deref(), Some("#ff8000"));
        // Not six characters at the cut: the integer form stands in.
        assert_eq!(slot_color(&cfg, 1).as_deref(), Some("#ff00ff"));
        assert_eq!(slot_color(&cfg, 2).as_deref(), Some("#123456"));
    }
}

#[cfg(test)]
mod address_tests {
    use super::{apply_status, authority, base, ws_url, Status, WsError};

    #[test]
    fn one_rule_for_every_address() {
        assert_eq!(authority("192.168.1.50", 7125), "192.168.1.50:7125");
        // A scheme and a trailing slash, as a user may type them: the saved port stands.
        assert_eq!(base("http://192.168.1.50/", 7125), "http://192.168.1.50:7125");
        // TLS stays when the host says so (a reverse proxy), for both.
        assert_eq!(ws_url("https://u1.local/", 7125), "wss://u1.local:7125/websocket");
        assert_eq!(base("https://u1.local/", 7125), "https://u1.local:7125");
        assert_eq!(base("wss://u1.local:443", 7125), "https://u1.local:443");
        // A port in the host wins over the saved one.
        assert_eq!(base(" 192.168.1.50:80 ", 7125), "http://192.168.1.50:80");
        assert_eq!(ws_url("ws://192.168.1.50:80", 7125), "ws://192.168.1.50:80/websocket");
    }

    #[test]
    fn only_a_missing_method_is_tried_another_way() {
        let method = "server.files.start_local_print";
        let missing = WsError::Rpc { method: method.into(), code: -32601, message: "Method not found".into() };
        let refused = WsError::Rpc { method: method.into(), code: -32000, message: "Printer is busy".into() };
        let late = WsError::Timeout { method: method.into() };
        assert!(missing.method_missing());
        assert!(!refused.method_missing());
        assert!(!late.method_missing());
        assert_eq!(refused.to_string(), "server.files.start_local_print : Printer is busy");
        // Through anyhow, the kind is still told.
        let e: anyhow::Error = late.into();
        assert!(matches!(e.downcast_ref::<WsError>(), Some(WsError::Timeout { .. })));
    }

    #[test]
    fn a_cleared_message_goes_away() {
        let mut st = Status { message: Some("old error".into()), ..Default::default() };
        apply_status(&serde_json::json!({"print_stats": {"state": "standby", "message": ""}}), &mut st);
        assert_eq!(st.message, None);
        apply_status(&serde_json::json!({"print_stats": {"state": "error", "message": "Heater failed"}}), &mut st);
        assert_eq!(st.message.as_deref(), Some("Heater failed"));
        // Not given (a partial update): the last message stands.
        apply_status(&serde_json::json!({"print_stats": {"state": "error"}}), &mut st);
        assert_eq!(st.message.as_deref(), Some("Heater failed"));
    }
}
