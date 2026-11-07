//! Bundled slicing engine: a slimmed-down Snapmaker Orca, downloaded when
//! first needed.
//!
//! `engine.json` (embedded at build time, updated by `scripts/engine.sh`)
//! gives, for each platform, the URL of the archive prepared by the "Engine"
//! CI, its size and its SHA-256 checksum. The engine is installed in
//! `<data>/engine/orca-<version>/`: streamed download, checksum verified,
//! extraction into a temporary folder then rename — a half-installed engine
//! is never used.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// Error given when slicing is asked for before the engine is installed.
pub fn missing() -> String {
    crate::t!("err.engine_missing")
}
/// Marker file of a complete installation.
const COMPLETE: &str = ".complete";

#[derive(Deserialize, Clone, Debug)]
pub struct Asset {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    /// Space used once extracted.
    pub unpacked: u64,
    /// Entry point: `.app`, executable or `AppRun`.
    pub entry: String,
}

#[derive(Deserialize, Debug)]
struct Manifest {
    #[serde(default)]
    version: String,
    /// Exact source code of the engine (AGPL license).
    #[serde(default)]
    source: String,
    #[serde(default)]
    platforms: HashMap<String, Asset>,
}

fn manifest() -> &'static Manifest {
    static M: OnceLock<Manifest> = OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str(include_str!("../engine.json")).unwrap_or_else(|e| {
            // Said in the console: "no engine referenced" alone would hide a
            // build whose manifest is broken.
            eprintln!("[engine] engine.json is unreadable: {e}");
            Manifest { version: String::new(), source: String::new(), platforms: HashMap::new() }
        })
    })
}

/// Key of the current platform in the manifest.
fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn asset() -> Option<&'static Asset> {
    manifest().platforms.get(&platform_key())
}

/// True when an engine is referenced: without one (development build),
/// slicing stays on the installed Snapmaker Orca.
pub fn referenced() -> bool {
    !manifest().version.is_empty() && !manifest().platforms.is_empty()
}

fn root() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("fr.carlini.snapstudio").join("engine")
}

fn install_dir() -> PathBuf {
    root().join(format!("orca-{}", manifest().version))
}

/// Entry point of the installed engine, if fully installed.
pub fn installed() -> Option<PathBuf> {
    let a = asset()?;
    let dir = install_dir();
    let entry = dir.join(&a.entry);
    (dir.join(COMPLETE).is_file() && entry.exists()).then_some(entry)
}

/// Version of a previously installed engine (before a Snap Studio update
/// that references another one).
fn previous() -> Option<String> {
    let current = format!("orca-{}", manifest().version);
    std::fs::read_dir(root())
        .ok()?
        .flatten()
        .filter(|e| e.path().join(COMPLETE).is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("orca-") && *n != current)
        .map(|n| n.trim_start_matches("orca-").to_string())
        .max()
}

#[derive(Serialize, Clone)]
pub struct Status {
    pub version: String,
    /// An engine is referenced (otherwise the installed Snapmaker Orca is the fallback).
    pub referenced: bool,
    pub source: String,
    /// An engine exists for this platform.
    pub available: bool,
    pub installed: bool,
    /// An engine of a previous version is still there: the new one is an update.
    pub previous: Option<String>,
    pub installing: bool,
    pub path: Option<String>,
    pub download_size: u64,
    pub disk_size: u64,
}

pub fn status() -> Status {
    let a = asset();
    let path = installed();
    Status {
        version: manifest().version.clone(),
        referenced: referenced(),
        source: manifest().source.clone(),
        available: a.is_some(),
        installed: path.is_some(),
        previous: if path.is_some() { None } else { previous() },
        installing: BUSY.load(Ordering::Relaxed),
        path: path.map(|p| p.to_string_lossy().to_string()),
        download_size: a.map(|a| a.size).unwrap_or(0),
        disk_size: a.map(|a| a.unpacked).unwrap_or(0),
    }
}

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct Progress {
    /// download | verify | extract | done
    phase: &'static str,
    done: u64,
    total: u64,
}

fn emit(app: &AppHandle, phase: &'static str, done: u64, total: u64) {
    let _ = app.emit("engine-progress", Progress { phase, done, total });
}

pub fn cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Downloads, checks and installs the platform's engine.
pub async fn install(app: AppHandle) -> Result<Status> {
    let a = asset().ok_or_else(|| anyhow!(crate::t!("err.engine_platform", platform = platform_key())))?;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(anyhow!(crate::t!("err.engine_busy")));
    }
    CANCEL.store(false, Ordering::Relaxed);
    let res = install_inner(&app, a).await;
    // Whatever ended it early (a failure, Cancel) leaves no `.part` behind.
    if res.is_err() {
        let _ = std::fs::remove_file(part_path());
    }
    BUSY.store(false, Ordering::SeqCst);
    res.map(|_| status())
}

fn part_path() -> PathBuf {
    root().join(format!(".download-{}.part", manifest().version))
}

/// Seconds without a byte before the download is given up: a stalled
/// connection must not keep the install busy for ever.
const STALL_S: u32 = 30;

/// `a.url` to `part`, its size and checksum verified. Cancel is read every
/// second, whether bytes come or not.
async fn download(app: &AppHandle, a: &Asset, part: &Path) -> Result<()> {
    use futures_util::StreamExt;
    let resp = reqwest::Client::builder()
        .user_agent("Snap-Studio")
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()?
        .get(&a.url)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!(crate::t!("err.download_refused", status = resp.status())));
    }
    let total = resp.content_length().unwrap_or(a.size);
    let mut file = std::fs::File::create(part)?;
    let mut hash = Sha256::new();
    let mut done = 0u64;
    let mut last = 0u64;
    let mut idle = 0u32;
    let mut stream = resp.bytes_stream();
    emit(app, "download", 0, total);
    loop {
        if CANCEL.load(Ordering::Relaxed) {
            return Err(anyhow!(crate::t!("err.download_cancelled")));
        }
        let chunk = match tokio::time::timeout(std::time::Duration::from_secs(1), stream.next()).await {
            Err(_) => {
                idle += 1;
                if idle >= STALL_S {
                    return Err(anyhow!(crate::t!("err.download_stalled")));
                }
                continue;
            }
            Ok(None) => break,
            Ok(Some(chunk)) => chunk?,
        };
        idle = 0;
        done += chunk.len() as u64;
        // More than announced: not the file the manifest describes.
        if done > a.size {
            return Err(anyhow!(crate::t!("err.download_size", got = done, want = a.size)));
        }
        file.write_all(&chunk)?;
        hash.update(&chunk);
        // One update per half megabyte is enough for the progress bar.
        if done - last > 512 * 1024 || done == total {
            emit(app, "download", done, total);
            last = done;
        }
    }
    file.flush()?;
    drop(file);
    if done != a.size {
        return Err(anyhow!(crate::t!("err.download_size", got = done, want = a.size)));
    }

    emit(app, "verify", done, total);
    let got = hex(&hash.finalize());
    if !got.eq_ignore_ascii_case(&a.sha256) {
        return Err(anyhow!(crate::t!("err.checksum")));
    }
    Ok(())
}

async fn install_inner(app: &AppHandle, a: &Asset) -> Result<()> {
    let root = root();
    std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    let part = root.join(format!(".download-{}.part", manifest().version));

    // Streamed download, checksum computed on the way.
    download(app, a, &part).await?;

    // Extraction off the async thread, into a temporary folder.
    emit(app, "extract", 0, a.unpacked);
    let staging = root.join(format!(".staging-{}", manifest().version));
    let target = install_dir();
    let part2 = part.clone();
    let staging2 = staging.clone();
    tauri::async_runtime::spawn_blocking(move || extract(&part2, &staging2)).await.map_err(|e| anyhow!("{e}"))??;
    std::fs::write(staging.join(COMPLETE), manifest().version.as_bytes())?;
    if target.exists() {
        std::fs::remove_dir_all(&target).with_context(|| format!("removing {}", target.display()))?;
    }
    std::fs::rename(&staging, &target).with_context(|| format!("moving {} to {}", staging.display(), target.display()))?;
    let _ = std::fs::remove_file(&part);
    prune_old(&root, &target);
    emit(app, "done", a.unpacked, a.unpacked);
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// tar.zst archive → folder; execute permissions and links kept.
fn extract(archive: &Path, dst: &Path) -> Result<()> {
    if dst.exists() {
        std::fs::remove_dir_all(dst).with_context(|| format!("removing {}", dst.display()))?;
    }
    std::fs::create_dir_all(dst).with_context(|| format!("creating {}", dst.display()))?;
    let f = std::io::BufReader::new(std::fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?);
    let zst = ruzstd::decoding::StreamingDecoder::new(f).map_err(|e| anyhow!(crate::t!("err.archive", err = e)))?;
    let mut tar = tar::Archive::new(zst);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    tar.unpack(dst).map_err(|e| anyhow!(crate::t!("err.extract", err = e)))?;
    Ok(())
}

/// Other engine versions and the leftovers of an interrupted install go
/// away; the engine's data stays.
fn prune_old(root: &Path, keep: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p == keep || name == "data" {
            continue;
        }
        if name.starts_with("orca-") || name.starts_with(".staging-") {
            let _ = std::fs::remove_dir_all(&p);
        } else if name.starts_with(".download-") {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Deletes the installed engine (Snap Studio's settings and data stay).
pub fn remove() -> Result<Status> {
    // Taken, not just read: an install starting at the same moment would
    // otherwise rename its engine into a folder being removed.
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(anyhow!(crate::t!("err.engine_busy")));
    }
    let dir = install_dir();
    let r: Result<()> = if dir.exists() { std::fs::remove_dir_all(&dir).map_err(anyhow::Error::from) } else { Ok(()) };
    BUSY.store(false, Ordering::SeqCst);
    r?;
    Ok(status())
}

/// Reads an archive from memory: used by the tests.
#[cfg(test)]
fn read_all(r: &mut impl std::io::Read) -> Vec<u8> {
    let mut v = Vec::new();
    r.read_to_end(&mut v).unwrap();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_manifest_is_not_referenced() {
        // The repository starts from an empty manifest: slicing stays on the installed Orca.
        if manifest().version.is_empty() {
            assert!(!referenced());
            assert!(installed().is_none());
        }
        assert!(platform_key().contains('-'));
    }

    #[test]
    fn extracts_a_tar_zst_with_permissions() {
        let tmp = std::env::temp_dir().join("snapstudio-engine-extract");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src/bin")).unwrap();
        std::fs::write(tmp.join("src/bin/tool"), b"#!/bin/sh\necho ok\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(tmp.join("src/bin/tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // tar, then zstd (ruzstd's compressor).
        let mut tarball = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tarball);
            b.append_dir_all(".", tmp.join("src")).unwrap();
            b.finish().unwrap();
        }
        let zst = ruzstd::encoding::compress_to_vec(&tarball[..], ruzstd::encoding::CompressionLevel::Fastest);
        let archive = tmp.join("e.tar.zst");
        std::fs::write(&archive, &zst).unwrap();
        extract(&archive, &tmp.join("out")).unwrap();
        let mut f = std::fs::File::open(tmp.join("out/bin/tool")).unwrap();
        assert_eq!(read_all(&mut f), b"#!/bin/sh\necho ok\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tmp.join("out/bin/tool")).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "executable kept");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
