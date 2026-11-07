//! Snappy's MCP server, inside the app.
//!
//! A small HTTP server on the loopback interface, speaking MCP's JSON-RPC
//! (streamable HTTP, JSON answers only): `initialize`, `tools/list`,
//! `tools/call`, plus two service methods, `ping` and the `initialized`
//! notification. Every request must carry the server's token; the token
//! and the address reach Claude through a `0600` config file
//! (`--mcp-config`), never the command line, where `ps` would show them.
//! The tools themselves are a static Rust table (`snappy_tools/`, one file per domain).

use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// The server's name, as Claude prefixes its tools (`mcp__snap-studio__…`).
pub const SERVER: &str = "snap-studio";

/// MCP protocol versions answered, the newest first.
const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// Largest request body read.
const MAX_BODY: usize = 1024 * 1024;

struct Running {
    config: PathBuf,
}

/// Set once Claude listed the tools: its MCP connection is up.
static LISTED: AtomicBool = AtomicBool::new(false);

/// Forgets the last connection, before a new Claude starts.
pub fn reset_listed() {
    LISTED.store(false, Ordering::SeqCst);
}

/// Waits until Claude listed the tools, up to `d`: its first message must
/// not leave before its tools are there.
pub fn wait_listed(d: Duration) -> bool {
    let end = std::time::Instant::now() + d;
    while !LISTED.load(Ordering::SeqCst) {
        if std::time::Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

static RUNNING: OnceLock<Running> = OnceLock::new();

/// Starts the server once, and returns its config file for Claude.
pub fn ensure_started() -> Result<PathBuf> {
    if let Some(r) = RUNNING.get() {
        return Ok(r.config.clone());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let config = crate::snappy::root().join("mcp.json");
    write_private(&config, &config_json(port, &token).to_string())?;
    let t = token.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let token = t.clone();
            std::thread::spawn(move || serve(stream, &token));
        }
    });
    let _ = RUNNING.set(Running { config: config.clone() });
    Ok(RUNNING.get().map(|r| r.config.clone()).unwrap_or(config))
}

/// The config Claude reads.
fn config_json(port: u16, token: &str) -> Value {
    json!({ "mcpServers": { SERVER: {
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "headers": { "Authorization": format!("Bearer {token}") },
    } } })
}

/// Writes a file only its owner can read, from its creation on.
fn write_private(path: &std::path::Path, text: &str) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(text.as_bytes())?;
    Ok(())
}

// ------------------------------------------------------------ HTTP

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// One HTTP/1.1 request, or None at the connection's end.
fn read_request(r: &mut impl BufRead) -> Option<Request> {
    let mut line = String::new();
    if r.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 {
            return None;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    Some(Request { method, path, headers, body })
}

fn respond(w: &mut impl Write, status: &str, body: Option<&Value>) -> std::io::Result<()> {
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let ctype = if body.is_some() { "Content-Type: application/json\r\n" } else { "" };
    write!(w, "HTTP/1.1 {status}\r\n{ctype}Content-Length: {}\r\n\r\n{text}", text.len())?;
    w.flush()
}

/// Equal without telling how far: the token is compared whole.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether a request may reach the tools: our path, our token, and not a
/// web page (a browser sends an Origin).
fn allowed(req: &Request, token: &str) -> bool {
    let bearer = req.header("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    req.path.split('?').next() == Some("/mcp") && same(bearer, token) && req.header("origin").is_none()
}

fn serve(stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(120)));
    let Ok(mut out) = stream.try_clone() else { return };
    let mut r = BufReader::new(stream);
    while let Some(req) = read_request(&mut r) {
        let sent = if !allowed(&req, token) {
            respond(&mut out, "401 Unauthorized", None)
        } else if req.method != "POST" {
            // No server-sent events stream: JSON answers only.
            respond(&mut out, "405 Method Not Allowed", None)
        } else {
            match serde_json::from_slice::<Value>(&req.body) {
                Ok(Value::Array(batch)) => {
                    let answers: Vec<Value> = batch.iter().filter_map(rpc).collect();
                    if answers.is_empty() {
                        respond(&mut out, "202 Accepted", None)
                    } else {
                        respond(&mut out, "200 OK", Some(&Value::Array(answers)))
                    }
                }
                Ok(msg) => match rpc(&msg) {
                    Some(a) => respond(&mut out, "200 OK", Some(&a)),
                    None => respond(&mut out, "202 Accepted", None),
                },
                Err(_) => respond(&mut out, "400 Bad Request", Some(&error(Value::Null, -32700, "parse error"))),
            }
        };
        if sent.is_err() {
            return;
        }
    }
}

// ------------------------------------------------------------ JSON-RPC

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// The answer to one message; None for a notification.
pub fn rpc(msg: &Value) -> Option<Value> {
    let method = msg["method"].as_str().unwrap_or_default();
    let Some(id) = msg.get("id").cloned() else {
        // `notifications/initialized` and any other notification: nothing
        // to answer.
        return None;
    };
    Some(match method {
        "initialize" => {
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or_default();
            let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]);
            ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "ping" => ok(id, json!({})),
        "tools/list" => {
            LISTED.store(true, Ordering::SeqCst);
            ok(id, json!({ "tools": crate::snappy_tools::list() }))
        }
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or_default();
            let args = msg["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
            if crate::snappy_tools::find(name).is_none() {
                return Some(error(id, -32602, &format!("unknown tool: {name}")));
            }
            // A tool that panics answers as a failed call: the connection
            // stays up and Snappy is told, instead of a reset socket.
            let called = std::panic::catch_unwind(|| crate::snappy_tools::call(name, &args));
            let (mut content, is_error) = (Vec::new(), matches!(called, Ok(Err(_)) | Err(_)));
            match called {
                Ok(Ok(mut v)) => {
                    // An image the tool saw goes as an image block, the rest as text.
                    if let Some(img) = crate::snappy_eyes::take_image(&mut v) {
                        content.push(json!({ "type": "image", "data": img["data"], "mimeType": img["mime"] }));
                    }
                    content.push(json!({ "type": "text", "text": v.to_string() }));
                }
                Ok(Err(e)) => content.push(json!({ "type": "text", "text": crate::privacy::text(&e.to_string(), &crate::privacy::known()) })),
                Err(_) => content.push(json!({ "type": "text", "text": format!("The tool {name} failed inside Snap Studio. Nothing more is known; tell the user.") })),
            }
            ok(id, json!({ "content": content, "isError": is_error }))
        }
        _ => error(id, -32601, &format!("method not found: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn the_handshake_and_the_tool_list() {
        let init =
            rpc(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER);
        let unknown =
            rpc(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).unwrap();
        assert_eq!(unknown["result"]["protocolVersion"], VERSIONS[0]);
        assert!(rpc(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert_eq!(rpc(&json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })).unwrap()["result"], json!({}));
        let list = rpc(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), crate::snappy_tools::tools().len());
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object" && t["description"].as_str().is_some_and(|d| !d.is_empty())));
        assert_eq!(rpc(&json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/list" })).unwrap()["error"]["code"], -32601);
        assert_eq!(
            rpc(&json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "nope" } })).unwrap()["error"]["code"],
            -32602
        );
    }

    #[test]
    fn only_our_token_on_our_path_from_no_page() {
        let req = |path: &str, headers: &[(&str, &str)]| Request {
            method: "POST".into(),
            path: path.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: vec![],
        };
        assert!(allowed(&req("/mcp", &[("Authorization", "Bearer secret")]), "secret"));
        assert!(!allowed(&req("/mcp", &[("Authorization", "Bearer wrong!")]), "secret"));
        assert!(!allowed(&req("/mcp", &[]), "secret"));
        assert!(!allowed(&req("/other", &[("Authorization", "Bearer secret")]), "secret"));
        assert!(!allowed(&req("/mcp", &[("Authorization", "Bearer secret"), ("Origin", "http://evil.example")]), "secret"));
    }

    #[test]
    fn the_config_file_is_private() {
        let dir = std::env::temp_dir().join(format!("snapstudio-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("mcp.json");
        write_private(&p, &config_json(4242, "tok").to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["mcpServers"][SERVER]["url"], "http://127.0.0.1:4242/mcp");
        assert_eq!(v["mcpServers"][SERVER]["headers"]["Authorization"], "Bearer tok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The server over a real socket: refused without the token, answered
    /// with it, several requests on one connection.
    #[test]
    fn the_server_answers_over_http() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in listener.incoming().flatten() {
                std::thread::spawn(move || serve(s, "tok"));
            }
        });
        let post = |conn: &mut TcpStream, auth: &str, body: &str| -> String {
            write!(conn, "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {auth}\r\nContent-Length: {}\r\n\r\n{body}", body.len())
                .unwrap();
            let mut r = BufReader::new(conn.try_clone().unwrap());
            let mut status = String::new();
            r.read_line(&mut status).unwrap();
            let mut len = 0;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h.trim().is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut b = vec![0; len];
            r.read_exact(&mut b).unwrap();
            format!("{}{}", status.trim(), String::from_utf8(b).unwrap())
        };
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(post(&mut c, "bad", "{}").starts_with("HTTP/1.1 401"));
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let a = post(&mut c, "tok", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        assert!(a.starts_with("HTTP/1.1 200") && a.contains(r#""result":{}"#), "{a}");
        let b = post(&mut c, "tok", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert!(b.starts_with("HTTP/1.1 202"), "{b}");
    }
}
