//! What may reach the model: Snappy's privacy filter.
//!
//! Everything sent to Claude on Snappy's behalf — tool results, the app
//! context of each message, its memory — goes through here first: no
//! printer serials, filesystem paths, IP addresses or hostnames. Printers
//! and files are named by their display names only.

use serde_json::Value;

/// What a removed identifier is replaced with.
pub const REDACTED: &str = "[redacted]";

/// Object keys whose values are identifiers, dropped whole.
const SECRET_KEYS: [&str; 14] =
    ["host", "hostname", "ip", "address", "addr", "serial", "serial_number", "sn", "mac", "path", "file", "dir", "url", "port"];

/// A JSON value with its identifiers removed: secret keys dropped, every
/// string filtered (see [`text`]), `known` values (a printer's host…)
/// replaced wherever they appear.
pub fn json(v: &Value, known: &[String]) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !SECRET_KEYS.contains(&k.to_ascii_lowercase().as_str()))
                .map(|(k, v)| (k.clone(), json(v, known)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|x| json(x, known)).collect()),
        Value::String(s) => Value::String(text(s, known)),
        other => other.clone(),
    }
}

/// A text with its identifiers replaced by [`REDACTED`]: `known` values,
/// then IPv4 and IPv6 addresses, URLs' hosts, filesystem paths, local
/// hostnames (`.local`, `.lan`…), and serial-like codes.
pub fn text(s: &str, known: &[String]) -> String {
    let mut out = s.to_string();
    // Longest first: a hostname that contains a shorter known value.
    let mut known: Vec<&String> = known.iter().filter(|k| k.len() >= 3).collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.len()));
    for k in known {
        if out.contains(k.as_str()) {
            out = out.replace(k.as_str(), REDACTED);
        }
    }
    out.split_inclusive(char::is_whitespace).map(word).collect()
}

/// One word (with its trailing space) filtered.
fn word(w: &str) -> String {
    let body = w.trim_end();
    let space = &w[body.len()..];
    // Punctuation around the word stays: "(192.168.1.4)," keeps its brackets.
    let start = body.find(|c: char| !matches!(c, '(' | '[' | '{' | '"' | '\'' | '<' | '«' | '`')).unwrap_or(body.len());
    // After the last kept character, counted in bytes: "Désactivé" ends
    // on a two-byte letter.
    let end = body
        .char_indices()
        .rev()
        .find(|&(_, c)| !matches!(c, ')' | ']' | '}' | '"' | '\'' | '>' | '»' | '`' | ',' | ';' | '.' | ':' | '!' | '?'))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(start);
    if start >= end {
        return w.to_string();
    }
    let core = &body[start..end];
    if is_identifier(core) {
        format!("{}{REDACTED}{}{space}", &body[..start], &body[end..])
    } else {
        w.to_string()
    }
}

fn is_identifier(w: &str) -> bool {
    is_url(w) || is_path(w) || is_ipv4(w.split(':').next().unwrap_or(w)) || is_ipv6(w) || is_local_host(w) || is_serial(w)
}

fn is_url(w: &str) -> bool {
    let l = w.to_ascii_lowercase();
    ["http://", "https://", "ws://", "wss://", "ftp://", "file://", "smb://"].iter().any(|p| l.starts_with(p))
}

/// `/a/b`, `~/a`, `C:\a`, `\\server\share`: a path, not a fraction or a
/// lone slash ("PLA/PETG" has no leading slash).
fn is_path(w: &str) -> bool {
    let b = w.as_bytes();
    (w.starts_with('/') && w[1..].contains('/'))
        || (w.starts_with('/')
            && w.len() > 1
            && ["Users", "home", "Volumes", "tmp", "var", "private", "etc", "mnt", "media", "opt"].iter().any(|d| w[1..].starts_with(d)))
        || w.starts_with("~/")
        || w.starts_with("\\\\")
        || (b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
}

fn is_ipv4(w: &str) -> bool {
    let parts: Vec<&str> = w.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|c| c.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n <= 255))
}

fn is_ipv6(w: &str) -> bool {
    let w = w.trim_start_matches('[').split(']').next().unwrap_or(w);
    let w = w.split('%').next().unwrap_or(w);
    w.matches(':').count() >= 2
        && w.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        && w.chars().any(|c| c.is_ascii_hexdigit())
        && w.parse::<std::net::Ipv6Addr>().is_ok()
}

/// A machine's name on the local network.
fn is_local_host(w: &str) -> bool {
    let l = w.to_ascii_lowercase();
    let host = l.split(':').next().unwrap_or(&l);
    [".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa"].iter().any(|s| host.ends_with(s) && host.len() > s.len())
}

/// A code shaped like a serial number: ten or more capitals and digits,
/// with at least three of each ("SM1A2B3C4D5E"). Model names, layer
/// heights and file names (lower case) do not look like it.
fn is_serial(w: &str) -> bool {
    let w = w.trim_start_matches("SN:").trim_start_matches("S/N:");
    w.len() >= 10
        && w.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
        && w.chars().filter(|c| c.is_ascii_digit()).count() >= 3
        && w.chars().filter(|c| c.is_ascii_uppercase()).count() >= 3
}

/// What the app knows that must never reach the model: its printers'
/// addresses (and the hostnames they reported).
pub fn known() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in crate::printers::load() {
        out.push(p.host.clone());
        if let Some(short) = p.host.split('.').next().filter(|s| s.len() >= 4 && *s != p.host) {
            out.push(short.to_string());
        }
    }
    for l in crate::jobs::snapshot() {
        if let Some(h) = l.status.hostname {
            out.push(h);
        }
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.to_string_lossy().to_string());
        if let Some(user) = home.file_name() {
            // The account name, as paths and prompts show it.
            out.push(format!("/{}", user.to_string_lossy()));
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn addresses_are_removed() {
        let s = text("The printer is at 192.168.1.42:7125, try (10.0.0.7).", &[]);
        assert_eq!(s, "The printer is at [redacted], try ([redacted]).");
        assert_eq!(text("fe80::1c2b:3cff:fe4d:5e6f%en0 answered", &[]), "[redacted] answered");
        assert_eq!(text("see http://u1.local/server/info now", &[]), "see [redacted] now");
        assert_eq!(text("Version 2.4.1 and 0.20 mm", &[]), "Version 2.4.1 and 0.20 mm", "not addresses");
        assert_eq!(text("ratio 12:30 at 10:45:00", &[]), "ratio 12:30 at 10:45:00", "times are not IPv6");
    }

    #[test]
    fn hostnames_and_known_values_are_removed() {
        assert_eq!(text("Ping snapmaker-u1.local please", &[]), "Ping [redacted] please");
        assert_eq!(text("Ping workshop-printer now", &["workshop-printer".into()]), "Ping [redacted] now");
        // Known values are replaced inside words too.
        assert_eq!(text("x-workshop-printer-y", &["workshop-printer".into()]), "x-[redacted]-y");
    }

    #[test]
    fn paths_are_removed() {
        for p in ["/Users/someone/Models/benchy.3mf", "~/Desktop/x.stl", "C:\\Users\\a\\b.gcode", "/home/a/b", "\\\\nas\\share\\f"] {
            assert_eq!(text(&format!("open {p} now"), &[]), "open [redacted] now", "{p}");
        }
        assert_eq!(text("PLA/PETG and 1/2 of 3D", &[]), "PLA/PETG and 1/2 of 3D", "not paths");
        assert_eq!(text("benchy.3mf", &[]), "benchy.3mf", "a display name stays");
    }

    #[test]
    fn serials_are_removed() {
        assert_eq!(text("serial SM1U2A3B4C5D6 ok", &[]), "serial [redacted] ok");
        assert_eq!(text("Snapmaker U1, PLA, 0.4 nozzle, HF-PLA", &[]), "Snapmaker U1, PLA, 0.4 nozzle, HF-PLA");
        assert_eq!(text("job 3f9a0c7e21b4d5e6", &[]), "job 3f9a0c7e21b4d5e6", "lower-case ids are not serials");
    }

    /// Words ending on a letter of several bytes are kept whole, not cut
    /// inside it (which panicked, and closed Snappy's tool connection).
    #[test]
    fn non_ascii_words_stay_whole() {
        for w in ["Désactivé", "Activé.", "«Gyroïde»", "20 °C", "填充", "(Brillé)", "Ironing · top"] {
            assert_eq!(text(w, &[]), w);
        }
        assert_eq!(text("«192.168.1.4»", &[]), "«[redacted]»");
    }

    #[test]
    fn json_loses_its_secret_keys() {
        let v = json!({
            "name": "Workshop U1",
            "host": "192.168.1.42",
            "Serial": "SM1U2A3B4C5D6",
            "status": { "state": "printing", "hostname": "u1", "message": "Klippy on 192.168.1.42 ready" },
            "files": [{ "name": "benchy.gcode", "path": "/home/lava/printer_data/gcodes/benchy.gcode" }],
        });
        let out = json(&v, &[]);
        assert_eq!(out["name"], "Workshop U1");
        assert!(out.get("host").is_none() && out.get("Serial").is_none());
        assert!(out["status"].get("hostname").is_none());
        assert_eq!(out["status"]["message"], "Klippy on [redacted] ready");
        assert_eq!(out["files"][0], json!({ "name": "benchy.gcode" }));
        let s = out.to_string();
        assert!(!s.contains("192.168") && !s.contains("/home/"), "{s}");
    }
}
