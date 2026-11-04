//! Files kept on a printer: the print files it was sent (Moonraker's
//! `gcodes` root) and its timelapse videos.
//!
//! Everything goes through Moonraker's file API, as Fluidd and Snapmaker
//! Orca do: `/server/files/roots`, `/server/files/list`,
//! `/server/files/metadata`, `/server/files/directory` (disk usage),
//! `/server/files/move`, `DELETE /server/files/{root}/{path}` and
//! `GET /server/files/{root}/{path}` (download, with byte ranges), plus
//! `/server/history/list` for each file's last print.
//!
//! Where the videos are. A stock Snapmaker U1 writes its timelapses into
//! the `camera` root (`/oem/printer_data/camera`, next to `monitor.jpg`,
//! read-only: Snapmaker's wiki has them downloaded from Fluidd's
//! Configuration › CAMERA). The moonraker-timelapse component, found on
//! other Klipper printers and in some U1 custom firmwares, registers a
//! `timelapse` root instead. The roots the printer declares are read
//! first and every candidate is listed, so both layouts work, and a root's
//! own permissions decide whether its videos can be deleted.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::printers::base;

/* ------------------------------------------------------------ types */

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Root {
    pub name: String,
    pub path: String,
    /// "r" or "rw", as Moonraker reports it.
    pub permissions: String,
}

impl Root {
    pub fn writable(&self) -> bool {
        self.permissions.contains('w')
    }
}

/// What Moonraker read in a print file's header.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct FileMeta {
    pub estimated_time: Option<f64>,
    pub slicer: Option<String>,
    pub slicer_version: Option<String>,
    pub layer_height: Option<f64>,
    pub object_height: Option<f64>,
    pub nozzle_diameter: Option<f64>,
    pub layer_count: Option<u64>,
    pub filament_name: Option<String>,
    /// Per tool, in tool order.
    pub filament_types: Vec<String>,
    /// "#rrggbb", per tool.
    pub filament_colors: Vec<String>,
    /// Grams, per tool.
    pub filament_weights: Vec<f64>,
    pub filament_weight_total: Option<f64>,
    /// Tools the print uses.
    pub tools: Vec<u8>,
    /// True when `tools` comes from the file (the slicer's list or the
    /// filament it consumes); false: T0 by default, nothing said.
    pub tools_known: bool,
    /// Largest thumbnail, as a path in the same root.
    pub thumb: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LastPrint {
    /// completed | cancelled | error | klippy_shutdown | interrupted | in_progress
    pub status: String,
    pub end_time: Option<f64>,
    pub duration: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RemoteFile {
    pub root: String,
    pub path: String,
    pub size: u64,
    /// Seconds since the epoch.
    pub modified: f64,
    pub writable: bool,
    pub meta: Option<FileMeta>,
    /// Picture of a video, in the same root (`name.jpg` next to `name.mp4`).
    pub thumb: Option<String>,
    pub last: Option<LastPrint>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Disk {
    pub total: u64,
    pub used: u64,
    pub free: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Overview {
    pub files: Vec<RemoteFile>,
    pub videos: Vec<RemoteFile>,
    /// Roots the videos were looked for in, in that order.
    pub video_roots: Vec<Root>,
    pub disk: Option<Disk>,
    /// File being printed (or paused), relative to `gcodes`.
    pub printing: Option<String>,
}

/* ------------------------------------------------------------ pure logic */

/// `/server/files/roots`.
pub fn parse_roots(v: &Value) -> Vec<Root> {
    v.get("result")
        .and_then(|r| r.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(Root {
                        name: r.get("name")?.as_str()?.to_string(),
                        path: r.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string(),
                        permissions: r.get("permissions").and_then(|p| p.as_str()).unwrap_or("r").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Roots that may hold timelapses, most likely first: moonraker-timelapse's
/// `timelapse`, then the U1's `camera`, then any other root named after
/// timelapses or videos. Without the list (an old Moonraker), the two usual
/// names are tried.
pub fn timelapse_roots(roots: Option<&[Root]>) -> Vec<Root> {
    let Some(roots) = roots else {
        return ["timelapse", "camera"]
            .iter()
            .map(|n| Root { name: n.to_string(), path: String::new(), permissions: if *n == "timelapse" { "rw" } else { "r" }.into() })
            .collect();
    };
    let rank = |r: &Root| -> Option<u8> {
        let n = r.name.to_ascii_lowercase();
        match n.as_str() {
            "timelapse" => Some(0),
            "camera" => Some(1),
            "timelapse_frames" => None,
            _ if n.contains("timelapse") || n.contains("video") => Some(2),
            _ => None,
        }
    };
    let mut out: Vec<(u8, Root)> = roots.iter().filter_map(|r| rank(r).map(|k| (k, r.clone()))).collect();
    out.sort_by_key(|(k, _)| *k);
    out.into_iter().map(|(_, r)| r).collect()
}

/// One entry of `/server/files/list`: (path, size, modified). Older
/// Moonraker versions name the path `filename`.
pub fn parse_list(v: &Value) -> Vec<(String, u64, f64)> {
    v.get("result")
        .and_then(|r| r.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    let path = f.get("path").or_else(|| f.get("filename"))?.as_str()?.to_string();
                    let size = f.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                    let modified = f.get("modified").and_then(|m| m.as_f64()).unwrap_or(0.0);
                    Some((path, size, modified))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn ext(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// A hidden folder (`.thumbs/`, `.tmp/`): never shown.
fn hidden(path: &str) -> bool {
    path.split('/').any(|s| s.starts_with('.'))
}

/// What the printer can print: G-code (Snap Studio and Snapmaker Orca send
/// `.gcode`), and a 3MF should the firmware keep one there.
pub fn is_print_file(path: &str) -> bool {
    !hidden(path) && matches!(ext(path).as_str(), "gcode" | "g" | "gco" | "3mf")
}

/// Videos a web view plays.
pub fn is_video(path: &str) -> bool {
    !hidden(path) && matches!(ext(path).as_str(), "mp4" | "m4v" | "mov" | "webm")
}

/// The picture of a video: same name, image extension, same folder.
pub fn video_thumb(video: &str, all: &[&str]) -> Option<String> {
    let stem = video.rsplit_once('.').map(|(s, _)| s)?;
    ["jpg", "jpeg", "png", "JPG", "PNG"].iter().map(|e| format!("{stem}.{e}")).find(|c| all.contains(&c.as_str()))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect(),
        // Some firmwares give "PLA;PETG" rather than a list.
        Some(Value::String(s)) => s.split([';', ',']).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        _ => Vec::new(),
    }
}

fn color(s: &str) -> Option<String> {
    let h = s.trim().trim_start_matches('#');
    // `get`: a non-ASCII character at the cut gives None, not a panic.
    h.get(..6).filter(|h| h.chars().all(|c| c.is_ascii_hexdigit())).map(|h| format!("#{}", h.to_ascii_lowercase()))
}

/// `/server/files/metadata`. `file_dir` is the file's folder in its root:
/// thumbnail paths are relative to it.
pub fn parse_meta(v: &Value, file_dir: &str) -> FileMeta {
    let r = v.get("result").unwrap_or(v);
    let f = |k: &str| r.get(k).and_then(|x| x.as_f64());
    let s = |k: &str| r.get(k).and_then(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    let colors: Vec<String> = {
        let c = strings(r.get("filament_colors"));
        let c = if c.is_empty() { strings(r.get("extruder_colors")) } else { c };
        c.iter().map(|x| color(x).unwrap_or_default()).collect()
    };
    let weights: Vec<f64> = r
        .get("filament_weights")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
        .unwrap_or_default();
    let thumb = r.get("thumbnails").and_then(|t| t.as_array()).and_then(|a| {
        a.iter()
            .filter_map(|t| {
                Some((
                    t.get("width")?.as_u64().unwrap_or(0) * t.get("height").and_then(|h| h.as_u64()).unwrap_or(0),
                    t.get("relative_path")?.as_str()?,
                ))
            })
            .max_by_key(|(area, _)| *area)
            .map(|(_, p)| if file_dir.is_empty() { p.to_string() } else { format!("{file_dir}/{p}") })
    });
    let mut m = FileMeta {
        estimated_time: f("estimated_time"),
        slicer: s("slicer"),
        slicer_version: s("slicer_version"),
        layer_height: f("layer_height"),
        object_height: f("object_height"),
        nozzle_diameter: f("nozzle_diameter"),
        layer_count: r.get("layer_count").and_then(|x| x.as_u64()),
        filament_name: s("filament_name"),
        filament_types: strings(r.get("filament_type")),
        filament_colors: colors,
        filament_weights: weights,
        filament_weight_total: f("filament_weight_total"),
        tools: Vec::new(),
        tools_known: false,
        thumb,
    };
    let referenced: Vec<u8> = r
        .get("referenced_tools")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_u64()).filter(|x| *x < 16).map(|x| x as u8).collect())
        .unwrap_or_default();
    m.tools = tools_of(&referenced, &m);
    m.tools_known = !referenced.is_empty() || m.filament_weights.iter().any(|w| *w > 0.0);
    m
}

/// Tools a G-code really uses, read from the file itself.
pub fn gcode_tools(path: &Path) -> Option<Vec<u8>> {
    let d = crate::gcode::parse(std::fs::File::open(path).ok()?).ok()?;
    let t = crate::gcode::stats(&d).tools;
    (!t.is_empty()).then_some(t)
}

fn tools_cache() -> &'static Mutex<HashMap<MetaKey, Vec<u8>>> {
    static C: OnceLock<Mutex<HashMap<MetaKey, Vec<u8>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Tools a print file on the printer uses: from Moonraker's metadata when
/// it says so; otherwise the G-code is read (fetched to a temporary folder).
/// A multi-color file must not be prepared as a single-color one. The
/// answer is kept until the file changes (`modified`): the G-code is read
/// once, not at each opening of the send sheet.
pub async fn tools(host: &str, port: u16, path: &str, modified: f64) -> Result<Vec<u8>> {
    let b = base(host, port);
    let key = (b.clone(), path.to_string(), modified.to_bits());
    if let Some(t) = tools_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(t);
    }
    let t = tools_uncached(host, port, &b, path).await?;
    if let Ok(mut c) = tools_cache().lock() {
        c.insert(key, t.clone());
    }
    Ok(t)
}

async fn tools_uncached(host: &str, port: u16, b: &str, path: &str) -> Result<Vec<u8>> {
    let url = format!("{b}/server/files/metadata?filename={}", urlencoding::encode(path));
    let meta = get(&url, 6).await.ok().map(|v| parse_meta(&v, ""));
    if let Some(m) = meta.as_ref().filter(|m| m.tools_known) {
        return Ok(m.tools.clone());
    }
    let tmp = std::env::temp_dir().join("snapstudio-pfiles").join(crate::printers::new_id());
    std::fs::create_dir_all(&tmp)?;
    let read = async {
        let f = download(host, port, "gcodes", path, &tmp).await?;
        let p = f.clone();
        Ok::<_, anyhow::Error>(tokio::task::spawn_blocking(move || gcode_tools(&p)).await.ok().flatten())
    }
    .await;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(read?.unwrap_or_else(|| meta.map(|m| m.tools).unwrap_or_else(|| vec![0])))
}

/// Tools a print uses: the slicer's own list, otherwise the filaments
/// actually consumed, otherwise a single-color print on T0.
pub fn tools_of(referenced: &[u8], m: &FileMeta) -> Vec<u8> {
    if !referenced.is_empty() {
        let mut t = referenced.to_vec();
        t.sort_unstable();
        t.dedup();
        return t;
    }
    let used: Vec<u8> = m.filament_weights.iter().enumerate().filter(|(_, w)| **w > 0.0).map(|(i, _)| i as u8).collect();
    if !used.is_empty() {
        return used;
    }
    vec![0]
}

/// `/server/history/list`, newest first: the last print of each file.
pub fn last_prints(v: &Value) -> HashMap<String, LastPrint> {
    let mut out = HashMap::new();
    let Some(jobs) = v.pointer("/result/jobs").and_then(|j| j.as_array()) else { return out };
    for j in jobs {
        let Some(name) = j.get("filename").and_then(|f| f.as_str()) else { continue };
        out.entry(name.to_string()).or_insert_with(|| LastPrint {
            status: j.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            end_time: j.get("end_time").and_then(|t| t.as_f64()).filter(|t| *t > 0.0),
            duration: j.get("print_duration").and_then(|t| t.as_f64()),
        });
    }
    out
}

/// `/server/files/directory`: the disk the root lives on.
pub fn parse_disk(v: &Value) -> Option<Disk> {
    let d = v.pointer("/result/disk_usage")?;
    Some(Disk {
        total: d.get("total")?.as_u64()?,
        used: d.get("used").and_then(|x| x.as_u64()).unwrap_or(0),
        free: d.get("free").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

/// The file the printer is busy with, relative to `gcodes`.
pub fn printing_path(state: &str, job: Option<&str>) -> Option<String> {
    matches!(state, "printing" | "paused").then(|| job.map(String::from)).flatten()
}

/// A file being printed cannot be deleted, nor renamed.
pub fn check_change(root: &str, path: &str, printing: Option<&str>) -> Result<()> {
    if root == "gcodes" && printing.is_some_and(|p| p.trim_start_matches('/') == path.trim_start_matches('/')) {
        return Err(anyhow!(crate::t!("pfiles.err.printing")));
    }
    Ok(())
}

/// New path for a rename: same folder, the old extension kept when the new
/// name has none. Refuses separators, a hidden name and an empty one.
pub fn rename_target(path: &str, new_name: &str) -> Result<String> {
    let n = new_name.trim();
    if n.is_empty() || n.starts_with('.') || n.contains(['/', '\\']) || n.chars().any(|c| c.is_control()) {
        return Err(anyhow!(crate::t!("pfiles.err.bad_name")));
    }
    let old_ext = ext(path);
    let n = if !old_ext.is_empty() && ext(n) != old_ext { format!("{n}.{old_ext}") } else { n.to_string() };
    Ok(match path.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/{n}"),
        None => n,
    })
}

/// A path within a root, each segment escaped for the URL. Refuses `..`.
pub fn file_url(base: &str, root: &str, path: &str) -> Result<String> {
    if !valid_root(root) || path.split('/').any(|s| s == ".." || s == ".") || path.contains('\\') || path.is_empty() {
        return Err(anyhow!("invalid path"));
    }
    let enc: Vec<String> = path.trim_start_matches('/').split('/').map(|s| urlencoding::encode(s).into_owned()).collect();
    Ok(format!("{base}/server/files/{root}/{}", enc.join("/")))
}

/// The roots this view reads or changes: print files and timelapses, never
/// the configuration or the logs.
pub fn served_root(root: &str) -> bool {
    valid_root(root)
        && (root == "gcodes" || root == "camera" || ((root.contains("timelapse") || root.contains("video")) && root != "timelapse_frames"))
}

pub fn valid_root(root: &str) -> bool {
    !root.is_empty() && root.len() <= 40 && root.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The byte range asked of the printer for a range the web view asked of
/// us, at most `cap` bytes: a video plays from 4 MB pieces rather than
/// from the whole file read into memory. None: the whole file.
pub fn clamp_range(header: Option<&str>, cap: u64) -> Option<(u64, u64)> {
    let h = header?.trim();
    let spec = h.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if a.is_empty() {
        return None; // suffix range ("-500"): rare, the whole file is fine
    }
    let start: u64 = a.trim().parse().ok()?;
    let end = match b.trim() {
        "" => start + cap - 1,
        e => e.parse::<u64>().ok()?.min(start + cap - 1),
    };
    (end >= start).then_some((start, end))
}

pub fn mime_of(path: &str) -> &'static str {
    match ext(path).as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

/// An MP4 box header: (size, type, header length). Size 0: up to the end.
pub fn box_header(b: &[u8]) -> Option<(u64, [u8; 4], u64)> {
    if b.len() < 8 {
        return None;
    }
    let size = u32::from_be_bytes(b[0..4].try_into().ok()?) as u64;
    let kind: [u8; 4] = b[4..8].try_into().ok()?;
    if size == 1 {
        if b.len() < 16 {
            return None;
        }
        return Some((u64::from_be_bytes(b[8..16].try_into().ok()?), kind, 16));
    }
    Some((size, kind, 8))
}

/// The duration in the `mvhd` of a `moov` box (the box itself, header
/// included), in seconds.
pub fn mvhd_duration(moov: &[u8]) -> Option<f64> {
    let (size, kind, hdr) = box_header(moov)?;
    if &kind != b"moov" {
        return None;
    }
    let end = (size as usize).min(moov.len());
    let mut i = hdr as usize;
    while i + 8 <= end {
        let (s, k, h) = box_header(&moov[i..end])?;
        if s < h {
            return None;
        }
        if &k == b"mvhd" {
            let b = &moov[i + h as usize..end];
            let version = *b.first()?;
            let (ts, dur) = if version == 1 {
                (u32::from_be_bytes(b.get(20..24)?.try_into().ok()?) as f64, u64::from_be_bytes(b.get(24..32)?.try_into().ok()?) as f64)
            } else {
                (u32::from_be_bytes(b.get(12..16)?.try_into().ok()?) as f64, u32::from_be_bytes(b.get(16..20)?.try_into().ok()?) as f64)
            };
            return (ts > 0.0).then(|| dur / ts);
        }
        i += s as usize;
    }
    None
}

/* ------------------------------------------------------------ network */

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder().connect_timeout(Duration::from_secs(3)).user_agent("Snap-Studio").build().expect("client HTTP")
    })
}

async fn get(url: &str, secs: u64) -> Result<Value> {
    let r = client().get(url).timeout(Duration::from_secs(secs)).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    Ok(r.json::<Value>().await?)
}

/// Error of a refused request, with Moonraker's message when it gives one.
async fn refused(r: reqwest::Response) -> anyhow::Error {
    let code = r.status().as_u16();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    let msg = body.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("refused").to_string();
    anyhow!("HTTP {code}: {msg}")
}

type MetaKey = (String, String, u64);
fn meta_cache() -> &'static Mutex<HashMap<MetaKey, FileMeta>> {
    static C: OnceLock<Mutex<HashMap<MetaKey, FileMeta>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

async fn metadata(b: &str, path: &str, modified: f64) -> Option<FileMeta> {
    let key = (b.to_string(), path.to_string(), modified.to_bits());
    if let Some(m) = meta_cache().lock().ok()?.get(&key) {
        return Some(m.clone());
    }
    let url = format!("{b}/server/files/metadata?filename={}", urlencoding::encode(path));
    let v = get(&url, 6).await.ok()?;
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let m = parse_meta(&v, dir);
    meta_cache().lock().ok()?.insert(key, m.clone());
    Some(m)
}

async fn list_root(b: &str, root: &str) -> Result<Vec<(String, u64, f64)>> {
    Ok(parse_list(&get(&format!("{b}/server/files/list?root={root}"), 8).await?))
}

/// Number of print files: for the sidebar.
pub async fn count(host: &str, port: u16) -> Result<usize> {
    let b = base(host, port);
    Ok(list_root(&b, "gcodes").await?.iter().filter(|(p, _, _)| is_print_file(p)).count())
}

/// Print files with their metadata and last print, timelapse videos, disk.
pub async fn overview(host: &str, port: u16, printing: Option<String>) -> Result<Overview> {
    let b = base(host, port);
    let roots = get(&format!("{b}/server/files/roots"), 4).await.ok().map(|v| parse_roots(&v));
    let gcodes_rw = roots.as_ref().and_then(|r| r.iter().find(|r| r.name == "gcodes")).map(|r| r.writable()).unwrap_or(true);
    let listed = list_root(&b, "gcodes").await?;
    let history = get(&format!("{b}/server/history/list?limit=200&order=desc"), 6).await.map(|v| last_prints(&v)).unwrap_or_default();
    let disk = get(&format!("{b}/server/files/directory?path=gcodes&extended=false"), 4).await.ok().and_then(|v| parse_disk(&v));

    let prints: Vec<(String, u64, f64)> = listed.into_iter().filter(|(p, _, _)| is_print_file(p)).collect();
    // Metadata: six at a time, each answer kept until the file changes.
    let mut metas: HashMap<String, FileMeta> = HashMap::new();
    for chunk in prints.chunks(6) {
        let mut set = tokio::task::JoinSet::new();
        for (p, _, m) in chunk {
            let (b, p, m) = (b.clone(), p.clone(), *m);
            set.spawn(async move { (p.clone(), metadata(&b, &p, m).await) });
        }
        while let Some(Ok((p, m))) = set.join_next().await {
            if let Some(m) = m {
                metas.insert(p, m);
            }
        }
    }
    let files = prints
        .into_iter()
        .map(|(path, size, modified)| RemoteFile {
            root: "gcodes".into(),
            meta: metas.remove(&path),
            last: history.get(&path).cloned(),
            path,
            size,
            modified,
            writable: gcodes_rw,
            thumb: None,
        })
        .collect();

    let video_roots = timelapse_roots(roots.as_deref());
    let videos = list_videos(&b, &video_roots).await;
    Ok(Overview { files, videos, video_roots, disk, printing })
}

/// Timelapse videos of every candidate root.
async fn list_videos(b: &str, video_roots: &[Root]) -> Vec<RemoteFile> {
    let mut videos = Vec::new();
    for r in video_roots {
        let Ok(list) = list_root(b, &r.name).await else { continue };
        let all: Vec<&str> = list.iter().map(|(p, _, _)| p.as_str()).collect();
        for (path, size, modified) in list.iter().filter(|(p, _, _)| is_video(p)) {
            videos.push(RemoteFile {
                root: r.name.clone(),
                path: path.clone(),
                size: *size,
                modified: *modified,
                writable: r.writable(),
                meta: None,
                thumb: video_thumb(path, &all),
                last: None,
            });
        }
    }
    videos
}

/// The timelapse videos alone, without the print files: the Prints record
/// looks for the one of a finished print.
pub async fn videos(host: &str, port: u16) -> Result<Vec<RemoteFile>> {
    let b = base(host, port);
    let roots = get(&format!("{b}/server/files/roots"), 4).await.ok().map(|v| parse_roots(&v));
    Ok(list_videos(&b, &timelapse_roots(roots.as_deref())).await)
}

type DurKey = (String, String, String, u64);
fn duration_cache() -> &'static Mutex<HashMap<DurKey, Option<f64>>> {
    static C: OnceLock<Mutex<HashMap<DurKey, Option<f64>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

async fn range(url: &str, start: u64, len: u64) -> Result<Vec<u8>> {
    let r =
        client().get(url).timeout(Duration::from_secs(15)).header("Range", format!("bytes={}-{}", start, start + len - 1)).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    if r.status().as_u16() == 200 {
        // A server that ignores ranges sends the whole file: read only up to
        // the piece, then drop the connection — and not past a few megabytes:
        // a `moov` at the end of a long video (ffmpeg's layout) would mean
        // reading the whole video, twice over the hops. No duration then.
        const NO_RANGE_MAX: u64 = 8 * 1024 * 1024;
        if start + len > NO_RANGE_MAX {
            return Err(anyhow!("no range support: {} bytes would be read", start + len));
        }
        let bytes = read_upto(r, start + len).await?;
        return Ok(bytes.get(start as usize..).map(<[u8]>::to_vec).unwrap_or_default());
    }
    Ok(r.bytes().await?.to_vec())
}

/// The first `n` bytes of an answer, without reading the rest.
async fn read_upto(mut r: reqwest::Response, n: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    while (out.len() as u64) < n {
        match r.chunk().await? {
            Some(c) => out.extend_from_slice(&c),
            None => break,
        }
    }
    out.truncate(n.min(out.len() as u64) as usize);
    Ok(out)
}

/// A video's duration, read from its `moov` box by following the top-level
/// box headers with small range requests: a few kilobytes, wherever the
/// box sits (before the frames, or after them as ffmpeg writes it).
pub async fn video_duration(host: &str, port: u16, root: &str, path: &str, modified: f64) -> Result<Option<f64>> {
    let b = base(host, port);
    let key = (b.clone(), root.to_string(), path.to_string(), modified.to_bits());
    if let Some(d) = duration_cache().lock().ok().and_then(|c| c.get(&key).copied()) {
        return Ok(d);
    }
    let url = file_url(&b, root, path)?;
    let mut off = 0u64;
    let mut found = None;
    for _ in 0..24 {
        let h = range(&url, off, 16).await?;
        let Some((size, kind, hdr)) = box_header(&h) else { break };
        if &kind == b"moov" {
            if size <= 16 * 1024 * 1024 {
                found = mvhd_duration(&range(&url, off, size.max(hdr)).await?);
            }
            break;
        }
        if size == 0 || size < hdr {
            break;
        }
        off += size;
    }
    if let Ok(mut c) = duration_cache().lock() {
        c.insert(key, found);
    }
    Ok(found)
}

pub async fn delete(host: &str, port: u16, root: &str, path: &str) -> Result<()> {
    let url = file_url(&base(host, port), root, path)?;
    let r = client().delete(url).timeout(Duration::from_secs(10)).send().await?;
    if !r.status().is_success() {
        return Err(refused(r).await);
    }
    Ok(())
}

/// An error worth a second try: no answer in time, no connection, or the
/// server's own failure (5xx). A refusal (403, 404, 405) is final.
fn passing(e: &anyhow::Error) -> bool {
    if let Some(r) = e.downcast_ref::<reqwest::Error>() {
        return r.is_timeout() || r.is_connect() || r.is_request();
    }
    e.to_string().starts_with("HTTP 5")
}

/// `delete`, tried up to three times when Moonraker did not answer or
/// failed on its side (busy with a file's metadata, a timeout): a file
/// deleted by a request that timed out is then found gone, not deleted
/// twice (a 404 is a refusal, taken as final — the file is gone).
pub async fn delete_retrying(host: &str, port: u16, root: &str, path: &str) -> Result<()> {
    let mut last = None;
    for i in 0..3 {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(600)).await;
            // Gone meanwhile (the timed-out request went through): done.
            if let Ok(list) = list_root(&base(host, port), root).await {
                if !list.iter().any(|(p, _, _)| p == path) {
                    return Ok(());
                }
            }
        }
        match delete(host, port, root, path).await {
            Ok(()) => return Ok(()),
            Err(e) if passing(&e) => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| anyhow!("delete failed")))
}

/// The camera service's id of a video (U1): the instance whose video has
/// this name, else the one whose id is in the name. Never guessed: without
/// the service's list, or with no instance for this video, there is none —
/// a date read from the name alone could be another video's.
pub fn date_index_of(path: &str, instances: Option<&Value>) -> Option<String> {
    let base = path.rsplit('/').next().unwrap_or(path);
    let list: Vec<(&str, &str)> = instances?
        .get("instances")?
        .as_array()?
        .iter()
        .filter_map(|i| Some((i.get("date_index")?.as_str()?, i.get("video_path").and_then(|v| v.as_str()).unwrap_or(""))))
        .filter(|(d, _)| !d.is_empty())
        .collect();
    if let Some((d, _)) = list.iter().find(|(_, v)| v.rsplit('/').next() == Some(base)) {
        return Some(d.to_string());
    }
    list.iter().find(|(d, _)| base.contains(d)).map(|(d, _)| d.to_string())
}

fn req_id() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64 % 2_000_000_000).unwrap_or(1)
}

/// Deletes a timelapse. Moonraker first; a U1 lists its videos in the
/// `camera` folder read-only (snapmakercloud.py registers it without write
/// access, and the delete is refused with 405), so the printer's own camera
/// service is asked next, as Snapmaker's apps do: `camera.delete_timelapse_instance`
/// over the websocket, which removes the video and its picture. The video must
/// then be gone from the listing.
pub async fn delete_video(host: &str, port: u16, root: &str, path: &str) -> Result<()> {
    let first = match delete(host, port, root, path).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    if !is_video(path) {
        return Err(first);
    }
    let instances = crate::printers::ws_call(
        host,
        port,
        "camera.get_timelapse_instance",
        serde_json::json!({ "req_id": req_id(), "page_index": 1, "page_rows": 1000 }),
    )
    .await
    .ok();
    let Some(instances) = instances else {
        return Err(anyhow!(crate::t!("pfiles.err.video_unlisted")));
    };
    let Some(index) = date_index_of(path, Some(&instances)) else {
        return Err(anyhow!(crate::t!("pfiles.err.video_unknown", err = first)));
    };
    let r = crate::printers::ws_call(
        host,
        port,
        "camera.delete_timelapse_instance",
        serde_json::json!({ "req_id": req_id(), "date_index": index }),
    )
    .await
    .map_err(|e| anyhow!(crate::t!("pfiles.err.video_delete", err = e)))?;
    if r.get("state").and_then(|s| s.as_str()) == Some("failed") {
        let msg = r.get("message").and_then(|m| m.as_str()).unwrap_or("failed").to_string();
        return Err(anyhow!(crate::t!("pfiles.err.video_delete", err = msg)));
    }
    // The service may delete after answering, and a long video takes a
    // moment to go: up to five seconds before the video is said to stay.
    let b = base(host, port);
    for i in 0..10 {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if let Ok(list) = list_root(&b, root).await {
            if !list.iter().any(|(p, _, _)| p == path) {
                return Ok(());
            }
        }
    }
    Err(anyhow!(crate::t!("pfiles.err.video_kept")))
}

/// Name shown for a print file: no folder, no extension, without the
/// "-a1b2c3" Snap Studio adds (six hex digits, one digit at least).
pub fn display_name(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    let stem = match base.rsplit_once('.') {
        Some((s, e)) if ["gcode", "gco", "g", "3mf"].contains(&e.to_ascii_lowercase().as_str()) => s,
        _ => base,
    };
    if let Some((head, tail)) = stem.rsplit_once('-') {
        if !head.is_empty()
            && tail.len() == 6
            && tail.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            && tail.chars().any(|c| c.is_ascii_digit())
        {
            return head.to_string();
        }
    }
    stem.to_string()
}

/// Renames a print file; returns its new path.
pub async fn rename(host: &str, port: u16, path: &str, new_name: &str) -> Result<String> {
    // The source as much as the destination: nothing outside `gcodes`.
    file_url("", "gcodes", path)?;
    let dest = rename_target(path, new_name)?;
    file_url("", "gcodes", &dest)?;
    let r = client()
        .post(format!("{}/server/files/move", base(host, port)))
        .timeout(Duration::from_secs(10))
        .json(&serde_json::json!({ "source": format!("gcodes/{path}"), "dest": format!("gcodes/{dest}") }))
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(refused(r).await);
    }
    Ok(dest)
}

/// Downloads a file into `dir`, under its own name (numbered rather than
/// overwriting). Written to a temporary name first: an interrupted
/// download leaves nothing that looks complete.
pub async fn download(host: &str, port: u16, root: &str, path: &str, dir: &Path) -> Result<PathBuf> {
    use futures_util::StreamExt;
    use std::io::Write;
    let url = file_url(&base(host, port), root, path)?;
    let name = path.rsplit('/').next().unwrap_or(path);
    let dest = crate::library::unique_path(dir, name);
    let part = dest.with_extension("part");
    let r = client().get(url).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    let mut f = std::fs::File::create(&part)?;
    let mut stream = r.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => f.write_all(&c)?,
            Err(e) => {
                drop(f);
                let _ = std::fs::remove_file(&part);
                return Err(e.into());
            }
        }
    }
    f.flush()?;
    drop(f);
    std::fs::rename(&part, &dest).with_context(|| format!("moving {} to {}", part.display(), dest.display()))?;
    Ok(dest)
}

/// Starts a file already on the printer.
pub async fn start(host: &str, port: u16, path: &str) -> Result<()> {
    let r = client()
        .post(format!("{}/printer/print/start?filename={}", base(host, port), urlencoding::encode(path)))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(refused(r).await);
    }
    Ok(())
}

/// What the `prn:` protocol answers: a printer file, by pieces when the web
/// view asks for a range (video), whole otherwise (pictures).
pub struct Proxied {
    pub status: u16,
    pub mime: &'static str,
    pub content_range: Option<String>,
    pub body: Vec<u8>,
}

pub const RANGE_CAP: u64 = 4 * 1024 * 1024;

pub async fn proxy(host: &str, port: u16, root: &str, path: &str, range_header: Option<&str>) -> Result<Proxied> {
    let url = file_url(&base(host, port), root, path)?;
    let mut req = client().get(url).timeout(Duration::from_secs(30));
    // A video is always served by pieces, even when the web view asks for
    // all of it: the protocol answers from memory, a whole video would not fit.
    let asked = clamp_range(range_header, RANGE_CAP).or_else(|| mime_of(path).starts_with("video/").then_some((0, RANGE_CAP - 1)));
    if let Some((a, b)) = asked {
        req = req.header("Range", format!("bytes={a}-{b}"));
    }
    let r = req.send().await?;
    let status = r.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(anyhow!("HTTP {status}"));
    }
    let content_range = r.headers().get("content-range").and_then(|v| v.to_str().ok()).map(String::from);
    let total = r.content_length();
    // A printer that ignores ranges: cut the piece here, reading no further.
    if let (Some((a, b)), 200) = (asked, status) {
        let body = read_upto(r, b + 1).await?;
        let len = total.unwrap_or(body.len() as u64);
        if a >= len {
            return Ok(Proxied { status: 416, mime: mime_of(path), content_range: Some(format!("bytes */{len}")), body: Vec::new() });
        }
        let end = b.min(len - 1);
        return Ok(Proxied {
            status: 206,
            mime: mime_of(path),
            content_range: Some(format!("bytes {a}-{end}/{len}")),
            body: body.get(a as usize..=(end as usize).min(body.len().saturating_sub(1))).map(<[u8]>::to_vec).unwrap_or_default(),
        });
    }
    let body = r.bytes().await?.to_vec();
    Ok(Proxied { status, mime: mime_of(path), content_range, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timelapse_roots_found_whatever_the_layout() {
        // A stock U1: no timelapse component, videos under `camera`.
        let u1 = parse_roots(&json!({"result": [
            {"name": "config", "path": "/home/lava/printer_data/config", "permissions": "r"},
            {"name": "gcodes", "path": "/userdata/gcodes", "permissions": "rw"},
            {"name": "camera", "path": "/oem/printer_data/camera", "permissions": "r"},
            {"name": "logs", "path": "/home/lava/printer_data/logs", "permissions": "r"}
        ]}));
        let t = timelapse_roots(Some(&u1));
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].name, "camera");
        assert!(!t[0].writable(), "the U1's camera root is read-only: no deleting there");
        // moonraker-timelapse: its root first, its frames never.
        let mt = parse_roots(&json!({"result": [
            {"name": "camera", "path": "/x/camera", "permissions": "r"},
            {"name": "timelapse_frames", "path": "/tmp/timelapse", "permissions": "r"},
            {"name": "timelapse", "path": "/home/pi/timelapse", "permissions": "rw"},
            {"name": "Videos", "path": "/media/v", "permissions": "rw"}
        ]}));
        let names: Vec<String> = timelapse_roots(Some(&mt)).into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["timelapse", "camera", "Videos"]);
        // No roots endpoint: the two usual names.
        let names: Vec<String> = timelapse_roots(None).into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["timelapse", "camera"]);
    }

    #[test]
    fn listing_filters_print_files_and_videos() {
        let v = json!({"result": [
            {"path": "Frame_PLA_1h28m-a1b2c3.gcode", "modified": 1760000000.5, "size": 4200000, "permissions": "rw"},
            {"path": "sub/vase.3mf", "modified": 1760000001.0, "size": 900000},
            {"path": ".thumbs/Frame_PLA_1h28m-a1b2c3-300x300.png", "modified": 1.0, "size": 9000},
            {"filename": "old-api.gcode", "modified": 2.0, "size": 10},
            {"path": "notes.txt", "modified": 3.0, "size": 10}
        ]});
        let l = parse_list(&v);
        assert_eq!(l.len(), 5);
        assert_eq!(l[3].0, "old-api.gcode", "older Moonraker: `filename`");
        let prints: Vec<&str> = l.iter().map(|(p, _, _)| p.as_str()).filter(|p| is_print_file(p)).collect();
        assert_eq!(prints, ["Frame_PLA_1h28m-a1b2c3.gcode", "sub/vase.3mf", "old-api.gcode"]);
        assert!(is_video("20260107114733.mp4") && is_video("a/b.MOV") && !is_video("monitor.jpg") && !is_video(".tmp/x.mp4"));
        let all = ["20260107114733.mp4", "20260107114733.jpg", "monitor.jpg", "other.mp4"];
        assert_eq!(video_thumb("20260107114733.mp4", &all).as_deref(), Some("20260107114733.jpg"));
        assert_eq!(video_thumb("other.mp4", &all), None);
    }

    #[test]
    fn metadata_of_an_orca_gcode() {
        let v = json!({"result": {
            "filename": "jobs/Frame.gcode", "estimated_time": 5280.0, "slicer": "OrcaSlicer", "slicer_version": "2.2.1",
            "layer_height": 0.2, "object_height": 24.6, "nozzle_diameter": 0.4, "layer_count": 123,
            "filament_name": "Snapmaker PLA;Snapmaker PETG", "filament_type": "PLA;PETG",
            "filament_colors": ["#F2D21B", "#111111", "#ffffff"], "filament_weights": [12.4, 3.1, 0.0], "filament_weight_total": 15.5,
            "thumbnails": [
                {"width": 48, "height": 48, "size": 2000, "relative_path": ".thumbs/Frame-48x48.png"},
                {"width": 300, "height": 300, "size": 40000, "relative_path": ".thumbs/Frame-300x300.png"}
            ]
        }});
        let m = parse_meta(&v, "jobs");
        assert_eq!(m.estimated_time, Some(5280.0));
        assert_eq!(m.filament_types, ["PLA", "PETG"]);
        assert_eq!(m.filament_colors, ["#f2d21b", "#111111", "#ffffff"]);
        assert_eq!(m.tools, [0, 1], "the filaments consumed, without referenced_tools");
        assert_eq!(m.thumb.as_deref(), Some("jobs/.thumbs/Frame-300x300.png"), "the largest, from the file's folder");
        assert_eq!(m.layer_count, Some(123));

        let v = json!({"result": {"referenced_tools": [3, 0, 3], "extruder_colors": ["FF0000", "00FF00"]}});
        let m = parse_meta(&v, "");
        assert_eq!(m.tools, [0, 3]);
        assert_eq!(m.filament_colors, ["#ff0000", "#00ff00"], "extruder colors when no filament colors");
        assert_eq!(parse_meta(&json!({"result": {}}), "").tools, [0], "nothing known: one color, T0");
        assert!(!parse_meta(&json!({"result": {}}), "").tools_known, "T0 by default is not knowledge");
        assert!(m.tools_known);
    }

    #[test]
    fn last_print_of_each_file() {
        let v = json!({"result": {"count": 3, "jobs": [
            {"filename": "a.gcode", "status": "cancelled", "end_time": 1760001000.0, "print_duration": 600.0},
            {"filename": "b.gcode", "status": "completed", "end_time": 1760000500.0, "print_duration": 3600.0},
            {"filename": "a.gcode", "status": "completed", "end_time": 1759000000.0, "print_duration": 3000.0}
        ]}});
        let h = last_prints(&v);
        assert_eq!(h["a.gcode"].status, "cancelled", "newest first");
        assert_eq!(h["b.gcode"].duration, Some(3600.0));
        assert_eq!(
            parse_disk(&json!({"result": {"disk_usage": {"total": 100, "used": 40, "free": 60}}})),
            Some(Disk { total: 100, used: 40, free: 60 })
        );
    }

    #[test]
    fn a_file_being_printed_is_kept() {
        let busy = printing_path("printing", Some("Frame.gcode"));
        assert_eq!(busy.as_deref(), Some("Frame.gcode"));
        assert!(check_change("gcodes", "Frame.gcode", busy.as_deref()).is_err());
        assert!(check_change("gcodes", "Other.gcode", busy.as_deref()).is_ok());
        assert!(check_change("camera", "Frame.gcode", busy.as_deref()).is_ok());
        assert_eq!(printing_path("complete", Some("Frame.gcode")), None);
        assert_eq!(printing_path("paused", Some("x.gcode")).as_deref(), Some("x.gcode"));
    }

    #[test]
    fn rename_keeps_folder_and_extension() {
        assert_eq!(rename_target("Frame.gcode", "Cadre").unwrap(), "Cadre.gcode");
        assert_eq!(rename_target("jobs/Frame.gcode", "Cadre.gcode").unwrap(), "jobs/Cadre.gcode");
        assert_eq!(rename_target("vase.3mf", "Vase v2").unwrap(), "Vase v2.3mf");
        for bad in ["", "  ", "a/b", "..", ".hidden", "a\\b"] {
            assert!(rename_target("x.gcode", bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn urls_are_escaped_and_contained() {
        let u = file_url("http://h:80", "gcodes", "jobs/Cadre 200 #1.gcode").unwrap();
        assert_eq!(u, "http://h:80/server/files/gcodes/jobs/Cadre%20200%20%231.gcode");
        assert!(file_url("http://h", "gcodes", "../config/printer.cfg").is_err());
        assert!(file_url("http://h", "../x", "a.gcode").is_err());
        assert!(file_url("http://h", "camera", "").is_err());
        assert!(valid_root("timelapse") && !valid_root("Camera/x"));
        assert!(served_root("gcodes") && served_root("camera") && served_root("timelapse") && served_root("my_videos"));
        assert!(!served_root("config") && !served_root("logs") && !served_root("timelapse_frames"));
    }

    #[test]
    fn ranges_are_cut_into_pieces() {
        assert_eq!(clamp_range(Some("bytes=0-1"), 100), Some((0, 1)));
        assert_eq!(clamp_range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(clamp_range(Some("bytes=500-100000"), 100), Some((500, 599)));
        assert_eq!(clamp_range(Some("bytes=-500"), 100), None);
        assert_eq!(clamp_range(Some("items=0-1"), 100), None);
        assert_eq!(clamp_range(None, 100), None);
        assert_eq!(clamp_range(Some("bytes=9-3"), 100), None);
        assert_eq!(mime_of("a.MP4"), "video/mp4");
    }

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn mp4_duration_from_mvhd() {
        // mvhd v0: version/flags, created, modified, timescale 1000, duration 83500.
        let mut mvhd = vec![0u8; 4];
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&83500u32.to_be_bytes());
        mvhd.extend_from_slice(&[0u8; 80]);
        let moov = bx(b"moov", &[bx(b"udta", &[0u8; 12]), bx(b"mvhd", &mvhd)].concat());
        assert_eq!(mvhd_duration(&moov), Some(83.5));
        // v1: 64-bit times.
        let mut v1 = vec![1u8, 0, 0, 0];
        v1.extend_from_slice(&[0u8; 16]);
        v1.extend_from_slice(&24u32.to_be_bytes());
        v1.extend_from_slice(&(24u64 * 3600).to_be_bytes());
        assert_eq!(mvhd_duration(&bx(b"moov", &bx(b"mvhd", &v1))), Some(3600.0));
        assert_eq!(mvhd_duration(&bx(b"free", &[0; 8])), None);
        // 64-bit box size (a large mdat).
        let mut big = 1u32.to_be_bytes().to_vec();
        big.extend_from_slice(b"mdat");
        big.extend_from_slice(&(5_000_000_000u64).to_be_bytes());
        assert_eq!(box_header(&big), Some((5_000_000_000, *b"mdat", 16)));
    }

    /// A small MP4: ftyp, a large mdat, then moov at the end (as ffmpeg
    /// writes it) with a 42.5 s mvhd.
    fn fake_mp4() -> Vec<u8> {
        let mut mvhd = vec![0u8; 4];
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&42500u32.to_be_bytes());
        mvhd.extend_from_slice(&[0u8; 80]);
        [bx(b"ftyp", b"isom\0\0\0\0"), bx(b"mdat", &vec![7u8; 200_000]), bx(b"moov", &bx(b"mvhd", &mvhd))].concat()
    }

    /// A fake Moonraker over plain HTTP, a U1's layout: `gcodes` writable,
    /// timelapses in the read-only `camera` root. `ranges`: whether it
    /// honours Range headers. Returns its port.
    fn fake_moonraker(ranges: bool) -> u16 {
        fake_moonraker_with(ranges).0
    }

    /// The same, with the camera folder's content, which its camera service
    /// (websocket, `camera.*`) can change: Moonraker itself refuses (405).
    fn fake_moonraker_with(ranges: bool) -> (u16, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let camera =
            std::sync::Arc::new(Mutex::new(vec!["monitor.jpg".to_string(), "20261019153000.mp4".into(), "20261019153000.jpg".into()]));
        let cam = camera.clone();
        std::thread::spawn(move || {
            let mp4 = fake_mp4();
            for conn in l.incoming() {
                let Ok(mut c) = conn else { continue };
                let mp4 = mp4.clone();
                let cam = cam.clone();
                std::thread::spawn(move || {
                    let mut peek = [0u8; 32];
                    let n = c.peek(&mut peek).unwrap_or(0);
                    if peek[..n].starts_with(b"GET /websocket") {
                        use tokio_tungstenite::tungstenite::{accept, Message};
                        let Ok(mut ws) = accept(c) else { return };
                        while let Ok(Message::Text(t)) = ws.read() {
                            let v: Value = serde_json::from_str(&t).unwrap();
                            let id = v["id"].clone();
                            let result = match v["method"].as_str().unwrap_or("") {
                                "camera.get_timelapse_instance" => json!({"state": "success", "instances": [
                                    {"date_index": "20261019153000", "video_path": "/userdata/.tmp_timelapse/20261019153000/timelapse.mp4"}
                                ]}),
                                "camera.delete_timelapse_instance" => {
                                    let idx = v["params"]["date_index"].as_str().unwrap_or("").to_string();
                                    let mut files = cam.lock().unwrap();
                                    let before = files.len();
                                    files.retain(|f| idx.is_empty() || !f.starts_with(&idx));
                                    if files.len() == before {
                                        json!({"state": "failed", "message": "no such instance"})
                                    } else {
                                        json!({"state": "success"})
                                    }
                                }
                                _ => json!(null),
                            };
                            let _ = ws.send(Message::Text(json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string().into()));
                        }
                        return;
                    }
                    let mut rd = BufReader::new(c.try_clone().unwrap());
                    let mut line = String::new();
                    if rd.read_line(&mut line).is_err() {
                        return;
                    }
                    let method = line.split_whitespace().next().unwrap_or("GET").to_string();
                    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let mut range = None;
                    loop {
                        let mut h = String::new();
                        if rd.read_line(&mut h).is_err() || h.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("range:") {
                            range = Some(v.trim().to_string());
                        }
                    }
                    let json = |v: serde_json::Value| (200u16, "application/json", v.to_string().into_bytes(), None::<String>);
                    let camera_list = || {
                        let files = cam.lock().unwrap();
                        json!({"result": files.iter().map(|f| json!({"path": f, "size": if f.ends_with(".mp4") { mp4.len() } else { 900 }, "modified": 1760000200.0})).collect::<Vec<_>>()})
                    };
                    let (code, mime, body, cr) = match target.as_str() {
                        _ if method == "DELETE" && target.starts_with("/server/files/camera/") => (
                            405,
                            "application/json",
                            br#"{"error": {"code": 405, "message": "Path not available for DELETE"}}"#.to_vec(),
                            None,
                        ),
                        _ if method == "DELETE" && target.starts_with("/server/files/gcodes/") => {
                            (200, "application/json", b"{}".to_vec(), None)
                        }
                        "/server/files/roots" => json(json!({"result": [
                            {"name": "gcodes", "path": "/userdata/gcodes", "permissions": "rw"},
                            {"name": "camera", "path": "/oem/printer_data/camera", "permissions": "r"},
                            {"name": "config", "path": "/home/lava/printer_data/config", "permissions": "r"}
                        ]})),
                        "/server/files/list?root=gcodes" => json(json!({"result": [
                            {"path": "Cube-1a2b3c.gcode", "size": 12345, "modified": 1760000000.0},
                            {"path": ".thumbs/Cube-1a2b3c-300x300.png", "size": 100, "modified": 1760000000.0},
                            {"path": "notes.txt", "size": 5, "modified": 1760000000.0}
                        ]})),
                        "/server/files/list?root=camera" => json(camera_list()),
                        "/server/files/metadata?filename=Cube-1a2b3c.gcode" => json(json!({"result": {
                            "estimated_time": 3600, "slicer": "OrcaSlicer", "filament_type": "PLA;PETG",
                            "filament_colors": ["#FF0000", "#00FF00"], "filament_weights": [10.0, 2.5],
                            "referenced_tools": [0, 1],
                            "thumbnails": [{"width": 300, "height": 300, "relative_path": ".thumbs/Cube-1a2b3c-300x300.png"}]
                        }})),
                        // A file Moonraker says nothing about: its G-code must be read.
                        "/server/files/metadata?filename=Bare.gcode" => json(json!({"result": {"estimated_time": 60}})),
                        "/server/files/gcodes/Bare.gcode" => {
                            (200, "text/plain", b"G1 F600\nG1 X10 Y0 E1\nT2\nG1 X10 Y20 E2\nT0\nG1 X0 Y20 E3\n".to_vec(), None)
                        }
                        "/server/history/list?limit=200&order=desc" => json(json!({"result": {"jobs": [
                            {"filename": "Cube-1a2b3c.gcode", "status": "completed", "end_time": 1760001000.0, "print_duration": 3500.0}
                        ]}})),
                        "/server/files/directory?path=gcodes&extended=false" => {
                            json(json!({"result": {"disk_usage": {"total": 1000, "used": 400, "free": 600}}}))
                        }
                        "/server/files/camera/20261019153000.mp4" => {
                            let span = range.as_deref().and_then(|r| clamp_range(Some(r), u64::MAX / 4)).filter(|_| ranges);
                            match span {
                                Some((a, b)) => {
                                    let end = b.min(mp4.len() as u64 - 1);
                                    (
                                        206,
                                        "video/mp4",
                                        mp4[a as usize..=end as usize].to_vec(),
                                        Some(format!("bytes {a}-{end}/{}", mp4.len())),
                                    )
                                }
                                None => (200, "video/mp4", mp4.clone(), None),
                            }
                        }
                        _ => (404, "application/json", b"{}".to_vec(), None),
                    };
                    let mut head =
                        format!("HTTP/1.1 {code} X\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
                    if let Some(cr) = cr {
                        head += &format!("Content-Range: {cr}\r\n");
                    }
                    let _ = c.write_all(head.as_bytes());
                    let _ = c.write_all(b"\r\n");
                    let _ = c.write_all(&body);
                });
            }
        });
        (port, camera)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn overview_of_a_fake_u1() {
        let port = fake_moonraker(true);
        let o = block_on(overview("127.0.0.1", port, Some("Cube-1a2b3c.gcode".into()))).unwrap();
        assert_eq!(o.files.len(), 1);
        let f = &o.files[0];
        assert_eq!((f.root.as_str(), f.path.as_str(), f.size, f.writable), ("gcodes", "Cube-1a2b3c.gcode", 12345, true));
        let m = f.meta.as_ref().unwrap();
        assert_eq!(m.estimated_time, Some(3600.0));
        assert_eq!(m.filament_types, vec!["PLA", "PETG"]);
        assert_eq!(m.tools, vec![0, 1]);
        assert_eq!(m.thumb.as_deref(), Some(".thumbs/Cube-1a2b3c-300x300.png"));
        assert_eq!(f.last.as_ref().unwrap().status, "completed");
        assert_eq!(o.disk, Some(Disk { total: 1000, used: 400, free: 600 }));
        assert_eq!(o.printing.as_deref(), Some("Cube-1a2b3c.gcode"));
        // The camera's video, read-only, with its picture; not monitor.jpg.
        assert_eq!(o.videos.len(), 1);
        let v = &o.videos[0];
        assert_eq!((v.root.as_str(), v.path.as_str(), v.writable), ("camera", "20261019153000.mp4", false));
        assert_eq!(v.thumb.as_deref(), Some("20261019153000.jpg"));
        assert_eq!(o.video_roots.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["camera"]);
        assert_eq!(block_on(count("127.0.0.1", port)).unwrap(), 1);
    }

    #[test]
    fn tools_come_from_the_metadata_or_the_gcode() {
        let port = fake_moonraker(true);
        // The slicer's list, as Moonraker reads it: nothing is fetched.
        assert_eq!(block_on(tools("127.0.0.1", port, "Cube-1a2b3c.gcode", 1.0)).unwrap(), vec![0, 1]);
        // Nothing said: the G-code is read, T0 and T2; then kept for that version.
        assert_eq!(block_on(tools("127.0.0.1", port, "Bare.gcode", 1.0)).unwrap(), vec![0, 2]);
        let key = (base("127.0.0.1", port), "Bare.gcode".to_string(), 1.0f64.to_bits());
        assert_eq!(tools_cache().lock().unwrap().get(&key), Some(&vec![0, 2]));
    }

    #[test]
    fn videos_are_streamed_by_pieces() {
        for ranges in [true, false] {
            let port = fake_moonraker(ranges);
            let mp4 = fake_mp4();
            let total = mp4.len();
            // The web view's usual opening request.
            let r = block_on(proxy("127.0.0.1", port, "camera", "20261019153000.mp4", Some("bytes=0-1"))).unwrap();
            assert_eq!((r.status, r.mime, r.body.as_slice()), (206, "video/mp4", &mp4[..2]), "ranges: {ranges}");
            assert_eq!(r.content_range.as_deref(), Some(format!("bytes 0-1/{total}").as_str()));
            // An open end is capped; no Range at all still gets a piece.
            let r = block_on(proxy("127.0.0.1", port, "camera", "20261019153000.mp4", Some("bytes=100-"))).unwrap();
            assert_eq!(r.body, mp4[100..]);
            let r = block_on(proxy("127.0.0.1", port, "camera", "20261019153000.mp4", None)).unwrap();
            assert_eq!((r.status, r.body.len()), (206, total));
            // Past the end.
            if !ranges {
                let r = block_on(proxy("127.0.0.1", port, "camera", "20261019153000.mp4", Some(&format!("bytes={}-", total + 5)))).unwrap();
                assert_eq!(r.status, 416);
            }
            // The duration, from the moov at the end.
            let d = block_on(video_duration("127.0.0.1", port, "camera", "20261019153000.mp4", ranges as u8 as f64)).unwrap();
            assert_eq!(d, Some(42.5), "ranges: {ranges}");
        }
        // Outside the roots: refused before asking the printer.
        assert!(block_on(proxy("127.0.0.1", 1, "camera", "../config/printer.cfg", None)).is_err());
    }

    #[test]
    fn camera_ids_of_videos() {
        let list = json!({"instances": [
            {"date_index": "20261019153000", "video_path": "/userdata/.tmp_timelapse/20261019153000/Cube_20261019153000.mp4"},
            {"date_index": "20261018120000", "video_path": ""}
        ]});
        assert_eq!(date_index_of("Cube_20261019153000.mp4", Some(&list)).as_deref(), Some("20261019153000"));
        assert_eq!(date_index_of("sub/x_20261018120000.mp4", Some(&list)).as_deref(), Some("20261018120000"));
        // Never guessed: without the service's list, or with no instance for
        // the video, there is no id — a date in the name could be another's.
        assert_eq!(date_index_of("Vase-1a2b3c_20260107114733.mp4", None), None);
        assert_eq!(date_index_of("Vase-1a2b3c_20260107114733.mp4", Some(&list)), None);
        assert_eq!(date_index_of("timelapse_f120_r24_classic.mp4", Some(&list)), None);
    }

    #[test]
    fn display_names() {
        assert_eq!(display_name("Cube-3f9a0c.gcode"), "Cube");
        assert_eq!(display_name("dir/Maison-facade.gcode"), "Maison-facade");
        assert_eq!(display_name("Vase.3mf"), "Vase");
        assert_eq!(display_name("Part-ABC123.gcode"), "Part-ABC123");
    }

    #[test]
    fn read_only_timelapses_are_deleted_by_the_camera_service() {
        let (port, camera) = fake_moonraker_with(true);
        // Moonraker refuses (405); the camera service deletes the video and its picture.
        block_on(delete_video("127.0.0.1", port, "camera", "20261019153000.mp4")).unwrap();
        assert_eq!(*camera.lock().unwrap(), vec!["monitor.jpg".to_string()]);
        // A picture is never sent to the camera service: Moonraker's answer stands.
        let e = block_on(delete_video("127.0.0.1", port, "camera", "monitor.jpg")).unwrap_err();
        assert!(e.to_string().contains("405"), "{e}");
        // A print file goes through Moonraker.
        block_on(delete_video("127.0.0.1", port, "gcodes", "Cube-1a2b3c.gcode")).unwrap();
    }
}

#[cfg(test)]
mod hex_tests {
    use super::color;

    #[test]
    fn colours_cut_safely() {
        assert_eq!(color("#FF8000FF").as_deref(), Some("#ff8000"));
        assert_eq!(color("#aaaaaé"), None);
        assert_eq!(color("zzzzzz"), None);
    }
}

#[cfg(test)]
mod rename_tests {
    #[test]
    fn a_source_outside_gcodes_is_refused() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // Refused before any request: the port is never reached.
        let e = rt.block_on(super::rename("127.0.0.1", 1, "../config/printer.cfg", "x")).unwrap_err();
        assert!(e.to_string().contains("invalid path"), "{e}");
    }
}
