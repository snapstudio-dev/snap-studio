//! The AI tab's conversations.
//!
//! Each conversation owns its folder, and that folder is its identity: the
//! folder name is also Claude Code's `--session-id`. Resuming then becomes
//! deterministic — there is never any need to dig into Claude's history or to
//! guess which session belongs to which object.
//!
//! ```text
//! ~/.config/snap-studio/ia/<uuid>/
//!   meta.json
//!   workspace/          ← mounted in the container
//!     CLAUDE.md  .claude/skills/  source.3mf  tools/  out/current.3mf  versions/v1.3mf
//! ```
//!
//! Everything is 3MF: one object made of parts, each with its color and its
//! head, so that a multicolor model stays one. Claude reads and writes them
//! through `tools/mf.py`, which writes the layout of `write3mf.rs`.
//! Conversations from before kept STL files: their current state and source
//! are converted when opened, their old versions stay readable.
//!
//! A conversation may also start from nothing, to design an object: then there
//! is no `source.3mf`, and `out/current.3mf` only exists after the first export.
//!
//! The working folder belongs to Claude. The app writes what Claude needs
//! (`CLAUDE.md`, the tools and skills, the previews) at creation and again
//! at each opening (`refresh_workspace`), keeps the chat log and the
//! attachments, and watches what comes out.

use crate::mesh::{Mat, MeshData};
use crate::write3mf::Part;
#[cfg(test)]
use crate::write3mf::SceneObject;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    /// UUID v4: folder name and Claude session id.
    pub id: String,
    pub title: String,
    /// Path of the original 3MF, as it was at creation.
    pub source: String,
    pub source_name: String,
    /// Initial request, sent on the first pass in the terminal.
    #[serde(default)]
    pub prompt: String,
    /// "sandbox" (Claude Code's built-in sandbox), "container" (yolobox) or
    /// "local".
    pub engine: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Number of the version shown.
    #[serde(default = "one")]
    pub version: u32,
    /// Path of the 3MF exported into your files, once the work is done.
    #[serde(default)]
    pub saved: Option<String>,
    /// Files written by Save, per version: number → path. The same version
    /// is not written twice while its file is still there.
    #[serde(default)]
    pub saved_versions: std::collections::BTreeMap<u32, String>,
    /// True as soon as the Claude session was created: it is resumed afterwards.
    #[serde(default)]
    pub started: bool,
    /// "create" for an object designed from scratch, empty for a modification.
    #[serde(default)]
    pub kind: String,
    /// Folder where the created object goes; a modification goes back next to
    /// its original.
    #[serde(default)]
    pub dest_dir: Option<String>,
    /// Maximum size asked for a created object, in millimeters.
    #[serde(default)]
    pub bounds: Option<[f32; 3]>,
    /// Claude model chosen for this conversation (`chat::MODELS`); none:
    /// the account's default.
    #[serde(default)]
    pub model: Option<String>,
}

impl Conversation {
    pub fn is_creation(&self) -> bool {
        self.kind == "create"
    }
}

fn one() -> u32 {
    1
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ------------------------------------------------------------ locations

/// `~/.config/snap-studio/ia`, and not the system's preferences folder.
///
/// This path is mounted as is in the container: it must stay short and
/// without spaces, which "Application Support" does not allow.
pub fn root() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    let d = base.join("snap-studio").join("ia");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// A conversation's folder. An id that is not a uuid (only a tampered
/// call sends one) maps to a folder that never exists, so every command
/// built on this path fails to find anything rather than reach elsewhere.
pub fn dir(id: &str) -> PathBuf {
    if valid_id(id) {
        root().join(id)
    } else {
        root().join("_invalid")
    }
}

pub fn workspace(id: &str) -> PathBuf {
    dir(id).join("workspace")
}

/// The object the app shows: what Claude produced last.
pub fn current(id: &str) -> PathBuf {
    workspace(id).join("out").join(CURRENT)
}

const CURRENT: &str = "current.3mf";
const SOURCE: &str = "source.3mf";

fn meta_path(id: &str) -> PathBuf {
    dir(id).join("meta.json")
}

// ------------------------------------------------------------ store

pub fn get(id: &str) -> Result<Conversation> {
    let raw = std::fs::read(meta_path(id))?;
    Ok(serde_json::from_slice(&raw)?)
}

pub fn save(c: &Conversation) -> Result<()> {
    let dst = meta_path(&c.id);
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = dst.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(c)?)?;
    std::fs::rename(&tmp, &dst)?;
    Ok(())
}

/// The conversations, from the most recently active to the oldest.
pub fn list() -> Vec<Conversation> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root()) else {
        return out;
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if let Ok(c) = get(&name) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// A valid id is the UUID we generated, nothing else.
///
/// Comparing paths is not enough: `..` stays under the root lexically, and it
/// is the kernel that resolves it afterwards — a deletion would then reach
/// much further than intended.
fn valid_id(id: &str) -> bool {
    // 8-4-4-4-12 hexadecimal digits, as uuid writes them.
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

pub fn remove(id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    std::fs::remove_dir_all(dir(id))?;
    Ok(())
}

/// Notes that a Claude session now exists for this conversation.
pub fn mark_started(id: &str) {
    if let Ok(mut c) = get(id) {
        c.started = true;
        c.updated_at = now();
        let _ = save(&c);
    }
}

/// Claude Code's configuration folders, most specific first.
///
/// `CLAUDE_CONFIG_DIR`, when set, replaces `~/.claude` for a local Claude.
/// The sandbox shares the host's `~/.claude/projects` (yolobox
/// `--claude-config`), so `~/.claude` stays a candidate even then.
pub fn claude_roots() -> Vec<PathBuf> {
    claude_roots_from(std::env::var_os("CLAUDE_CONFIG_DIR"), dirs::home_dir())
}

fn claude_roots_from(env: Option<std::ffi::OsString>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = env.filter(|v| !v.is_empty()).map(PathBuf::from) {
        // A relative value would depend on the app's current folder: ignored.
        if dir.is_absolute() {
            out.push(dir);
        }
    }
    let home = home.unwrap_or_else(std::env::temp_dir).join(".claude");
    if !out.contains(&home) {
        out.push(home);
    }
    out
}

/// Name of Claude's project folder for a working folder: each character that
/// is neither a letter nor a digit becomes a dash, so
/// `/Users/me/.config/snap-studio/ia/<id>/workspace` gives
/// `-Users-me--config-snap-studio-ia-<id>-workspace`.
fn project_slug(ws: &Path) -> String {
    ws.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Where Claude Code stores the session of a working folder: in the first
/// configuration folder that has it, otherwise where a new one would go.
pub fn session_file(id: &str) -> PathBuf {
    let rel = Path::new("projects").join(project_slug(&workspace(id))).join(format!("{id}.jsonl"));
    let roots = claude_roots();
    roots.iter().map(|r| r.join(&rel)).find(|p| p.is_file()).unwrap_or_else(|| roots[0].join(&rel))
}

/// What Claude Code keeps of one session, outside the conversation folder.
#[derive(Debug, Default, Serialize)]
pub struct Artifacts {
    /// Files and folders that belong to the session only.
    pub paths: Vec<PathBuf>,
    /// Matching names left alone: symbolic links, or out of the folder.
    pub skipped: Vec<PathBuf>,
}

/// Folders of a configuration root where Claude Code files things per
/// session, named after the session id.
const SESSION_DIRS: &[&str] = &["file-history", "session-env", "debug", "todos", "image-cache"];

/// Where a name was found, for the rules that only apply there.
#[derive(Clone, Copy, PartialEq)]
enum Place {
    /// Inside a `projects/<slug>/` folder.
    Project,
    Todos,
    Other,
}

/// True for a name that belongs to session `id` and to no other: the id
/// itself, or the id followed by a dot (`<id>.jsonl`, `<id>.txt`,
/// `<id>.jsonl.superseded-…`); in `todos`, `<id>-agent-…`; in a project,
/// `….orphaned-<id>-…`. A bare prefix never matches: `<id>0.jsonl` is
/// someone else's.
fn names_session(name: &str, id: &str, place: Place) -> bool {
    match name.strip_prefix(id) {
        Some("") => return true,
        Some(rest) if rest.starts_with('.') => return true,
        Some(rest) if place == Place::Todos && rest.starts_with("-agent-") => return true,
        _ => {}
    }
    place == Place::Project && name.contains(&format!(".orphaned-{id}-"))
}

/// The session's files under the configuration roots, after every check.
pub fn session_artifacts(id: &str) -> Result<Artifacts> {
    let mut out = Artifacts::default();
    for root in claude_roots() {
        let a = artifacts_in(&root, id)?;
        out.paths.extend(a.paths);
        out.skipped.extend(a.skipped);
    }
    Ok(out)
}

/// One root's share. Only reads.
///
/// - the id is ours (a UUID), so no `/`, `..` or wildcard can ride in it;
/// - only names that are exactly the session's are listed (`names_session`);
/// - nothing is followed: a symbolic link — the candidate or a folder on the
///   way — is skipped, never listed;
/// - each candidate must resolve inside the root, directly in the folder it
///   was found in;
/// - a project folder (`projects/<slug>`) is never a candidate, only what is
///   inside it; `history.jsonl` and the other shared files at the root are
///   never looked at.
fn artifacts_in(root: &Path, id: &str) -> Result<Artifacts> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    let mut out = Artifacts::default();
    let Ok(base) = root.canonicalize() else {
        return Ok(out); // no configuration here
    };
    let real_dir = |d: &Path| -> Option<PathBuf> {
        let m = std::fs::symlink_metadata(d).ok()?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return None;
        }
        d.canonicalize().ok().filter(|c| c.starts_with(&base))
    };
    let mut dirs: Vec<(PathBuf, Place)> = Vec::new();
    let projects = base.join("projects");
    if real_dir(&projects).is_some() {
        if let Ok(entries) = std::fs::read_dir(&projects) {
            for e in entries.flatten() {
                let p = e.path();
                if real_dir(&p).is_some() {
                    dirs.push((p, Place::Project));
                } else if names_session(&e.file_name().to_string_lossy(), id, Place::Other)
                    && std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink())
                {
                    out.skipped.push(p);
                }
            }
        }
    }
    for d in SESSION_DIRS {
        dirs.push((base.join(d), if *d == "todos" { Place::Todos } else { Place::Other }));
    }
    for (d, place) in dirs {
        let Some(real) = real_dir(&d) else { continue };
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !names_session(&name, id, place) {
                continue;
            }
            let p = e.path();
            let Ok(m) = std::fs::symlink_metadata(&p) else { continue };
            let inside = p.canonicalize().ok().and_then(|c| c.parent().map(Path::to_path_buf)) == Some(real.clone());
            if m.file_type().is_symlink() || !inside {
                out.skipped.push(p);
            } else {
                out.paths.push(p);
            }
        }
    }
    Ok(out)
}

/// Deletes what `session_artifacts` listed, checking each path again right
/// before: it must still not be a link. Returns how many went, and the
/// paths that could not be removed.
pub fn remove_artifacts(a: &Artifacts) -> (usize, Vec<PathBuf>) {
    let (mut n, mut failed) = (0, Vec::new());
    for p in &a.paths {
        let ok = match std::fs::symlink_metadata(p) {
            Ok(m) if m.file_type().is_symlink() => false,
            // `remove_dir_all` does not follow the links it meets inside.
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).is_ok(),
            Ok(_) => std::fs::remove_file(p).is_ok(),
            Err(_) => true, // already gone
        };
        if ok {
            n += 1;
        } else {
            failed.push(p.clone());
        }
    }
    (n, failed)
}

/// Gives a conversation a new title, as typed by the user.
pub fn rename(id: &str, title: &str) -> Result<Conversation> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(anyhow!(crate::t!("err.title_empty")));
    }
    let mut c = get(id)?;
    // The activity date stays: renaming is not working on the object.
    c.title = title.chars().take(120).collect();
    save(&c)?;
    Ok(c)
}

/// A copy of a conversation: same object, versions and instructions, but a
/// fresh Claude session — its chat log, attachments and initial request stay
/// with the original, so the copy starts a new exchange on the same files.
/// Links in the folder are not copied.
pub fn duplicate(id: &str) -> Result<Conversation> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    let c = get(id)?;
    let new_id = uuid::Uuid::new_v4().to_string();
    let (from, to) = (workspace(id), workspace(&new_id));
    let skip = [crate::chat::log_path(&from), crate::chat::attachments_dir(&from)];
    if let Err(e) = copy_plain(&from, &to, &skip) {
        let _ = std::fs::remove_dir_all(dir(&new_id));
        return Err(e.into());
    }
    let copy = Conversation {
        id: new_id,
        title: crate::t!("ia.copy_of", title = c.title.clone()).chars().take(120).collect(),
        prompt: String::new(),
        created_at: now(),
        updated_at: now(),
        saved: None,
        saved_versions: Default::default(),
        started: false,
        ..c
    };
    save(&copy)?;
    Ok(copy)
}

/// Copies a folder, skipping links and the paths in `skip`.
fn copy_plain(from: &Path, to: &Path, skip: &[PathBuf]) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let p = e.path();
        if skip.contains(&p) {
            continue;
        }
        let t = e.file_type()?;
        if t.is_dir() {
            copy_plain(&p, &to.join(e.file_name()), skip)?;
        } else if t.is_file() {
            std::fs::copy(&p, to.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// True if Claude really has a session to resume.
///
/// Also holds in the container, which was checked on a machine: yolobox mounts
/// the working folder at its real path, and `--claude-config` shares
/// `~/.claude/projects`. A conversation held in the sandbox therefore leaves
/// its session at this exact place, on the host.
///
/// Our own flag is not trusted: opening the terminal does not create a
/// session, only a first exchange does. Someone who opens a conversation then
/// closes it without a word leaves no trace, and a resume would then fail on
/// "No conversation found with session ID".
pub fn has_session(id: &str) -> bool {
    session_file(id).is_file()
}

// ------------------------------------------------------------ conversions

/// Full geometry of a 3MF, without sampling.
///
/// The viewer makes do with a triangle budget: the preview stays faithful. For
/// a conversion, however, everything must be kept.
pub fn mesh_of_3mf(path: &Path) -> Result<MeshData> {
    let mut zip = crate::model3mf::open(path)?;
    crate::mesh::load_mesh(&mut zip, usize::MAX)
}

/// Reads an object of the workspace: 3MF, or STL in older conversations.
pub fn read_mesh(path: &Path) -> Result<MeshData> {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("stl")) {
        crate::stl::read(path)
    } else {
        mesh_of_3mf(path)
    }
}

/// The parts of an original 3MF: one per head when the file assigns heads,
/// triangles without a color of their own taking their filament's color —
/// the colors the user sees in the slicer, painting included.
pub fn parts_of_3mf(src: &Path) -> Result<Vec<Part>> {
    let mut zip = crate::model3mf::open(src)?;
    let mut m = crate::mesh::load_mesh(&mut zip, usize::MAX)?;
    crate::plate::filament_colored(&mut zip, &mut m);
    Ok(split_by_head(m))
}

/// One part per volume head. A painted mesh is split by its volumes, never
/// by painted color: painted areas are open surfaces, which the workspace's
/// tools (trimesh booleans) cannot handle; their color stays on the
/// triangles.
fn split_by_head(m: MeshData) -> Vec<Part> {
    let heads: Vec<u8> = if m.volumes.len() == m.tris.len() {
        m.volumes
    } else if m.extruders.len() == m.tris.len() {
        m.extruders
    } else {
        vec![1; m.tris.len()]
    };
    let mut groups: std::collections::BTreeMap<u8, Vec<crate::mesh::Tri>> = Default::default();
    for (t, head) in m.tris.into_iter().zip(heads) {
        groups.entry(head.clamp(1, 16)).or_default().push(t);
    }
    groups.into_iter().map(|(head, tris)| Part { name: format!("part-{head}"), tris, extruder: head, paint: Vec::new() }).collect()
}

/// An STL as a one-part 3MF, for conversations from before 3MF.
pub fn stl_to_3mf(src: &Path, dst: &Path, name: &str) -> Result<usize> {
    let m = crate::stl::read(src)?;
    let n = m.tris.len();
    let part = Part { name: "part-1".into(), tris: m.tris, extruder: 1, paint: Vec::new() };
    write_3mf(dst, name, &[part])?;
    Ok(n)
}

/// Writes parts as one object, the way Claude's tools do, replacing `dst`
/// at once: the watch must never read a half-written file.
pub(crate) fn write_3mf(dst: &Path, name: &str, parts: &[Part]) -> Result<()> {
    let tmp = dst.with_file_name(format!(".writing-{}", dst.file_name().unwrap_or_default().to_string_lossy()));
    crate::write3mf::write_multipart(&tmp, name, parts, &on_plate(parts))?;
    std::fs::rename(&tmp, dst)?;
    Ok(())
}

/// The placement that centers the parts on the U1 plate and rests them on
/// it: objects are modeled around the origin, the plate's corner.
fn on_plate(parts: &[Part]) -> Mat {
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for v in parts.iter().flat_map(|p| p.tris.iter()).flat_map(|t| t.v) {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    let mut m = Mat::IDENTITY;
    if lo[0] <= hi[0] {
        m.0[9] = 135.0 - (lo[0] + hi[0]) / 2.0;
        m.0[10] = 135.0 - (lo[1] + hi[1]) / 2.0;
        m.0[11] = -lo[2];
    }
    m
}

/// Copies a file over another at once (same reason).
fn replace_with(src: &Path, dst: &Path) -> Result<()> {
    let tmp = dst.with_file_name(format!(".writing-{}", dst.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::copy(src, &tmp)?;
    std::fs::rename(&tmp, dst)?;
    Ok(())
}

// ------------------------------------------------------------ creation

/// Readable title from the request, otherwise from the file name.
fn title_for(prompt: &str, source: &Path) -> String {
    let p = prompt.trim();
    if !p.is_empty() {
        let mut t: String = p.chars().take(60).collect();
        if p.chars().count() > 60 {
            t.push('…');
        }
        return t;
    }
    source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| crate::t!("ia.untitled"))
}

/// Prepares a conversation: folder, instructions, tools, converted object.
/// The ways a conversation runs: Claude Code's own sandbox, a container
/// (yolobox), this computer. Anything else is refused: it would run as
/// "this computer" without saying so.
pub const ENGINES: [&str; 3] = ["sandbox", "container", "local"];

fn check_engine(engine: &str) -> Result<()> {
    if ENGINES.contains(&engine) {
        Ok(())
    } else {
        Err(anyhow!("unknown engine: {engine}"))
    }
}

pub fn create(source: &Path, prompt: &str, engine: &str) -> Result<Conversation> {
    check_engine(engine)?;
    if !source.is_file() {
        return Err(anyhow!(crate::t!("err.file_not_found")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ws = workspace(&id);
    std::fs::create_dir_all(ws.join("out"))?;
    std::fs::create_dir_all(ws.join("versions"))?;

    // Conversion first: if the object is unreadable, nothing must remain.
    let stem = source.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let src_3mf = ws.join(SOURCE);
    // A 3MF or an STL (ia_attach.rs: the same checks as an attached model).
    let parts = match crate::ia_attach::model_parts(source).and_then(|p| write_3mf(&src_3mf, &stem, &p).map(|_| p)) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(dir(&id));
            return Err(e);
        }
    };
    std::fs::copy(&src_3mf, ws.join("out").join(CURRENT))?;
    std::fs::copy(&src_3mf, ws.join("versions").join("v1.3mf"))?;

    let name = source.file_name().unwrap_or_default().to_string_lossy().to_string();
    std::fs::write(ws.join("CLAUDE.md"), instructions(&name, &Summary::of(&parts)))?;
    write_tools(&ws)?;

    let _ = write_previews(&id);

    let c = Conversation {
        id,
        title: title_for(prompt, source),
        source: source.to_string_lossy().to_string(),
        source_name: name,
        prompt: prompt.trim().to_string(),
        engine: engine.to_string(),
        created_at: now(),
        updated_at: now(),
        version: 1,
        saved: None,
        saved_versions: Default::default(),
        started: false,
        kind: String::new(),
        dest_dir: None,
        bounds: None,
        model: None,
    };
    save(&c)?;
    Ok(c)
}

/// Prepares a conversation without a starting object: Claude designs the part.
///
/// The output folder exists from the start — the watch hooks onto it — but
/// stays empty: the first exported mesh becomes v1.
pub fn create_blank(prompt: &str, engine: &str, dest_dir: &Path, bounds: Option<[f32; 3]>) -> Result<Conversation> {
    check_engine(engine)?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(anyhow!(crate::t!("ia.new.need_prompt")));
    }
    if !dest_dir.is_dir() {
        return Err(anyhow!(crate::t!("err.no_dest")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ws = workspace(&id);
    std::fs::create_dir_all(ws.join("out"))?;
    std::fs::create_dir_all(ws.join("versions"))?;
    std::fs::write(ws.join("CLAUDE.md"), instructions_creation(bounds))?;
    write_tools(&ws)?;

    let c = Conversation {
        id,
        title: title_for(prompt, Path::new(&crate::t!("ia.new_object"))),
        source: String::new(),
        source_name: String::new(),
        prompt: prompt.to_string(),
        engine: engine.to_string(),
        created_at: now(),
        updated_at: now(),
        version: 0,
        saved: None,
        saved_versions: Default::default(),
        started: false,
        kind: "create".into(),
        dest_dir: Some(dest_dir.to_string_lossy().to_string()),
        bounds,
        model: None,
    };
    save(&c)?;
    Ok(c)
}

// ------------------------------------------------------------ workspace layout

/// Folder of the tools the app leaves to Claude.
const TOOLS: &str = "tools";
/// The tools: 3MF reading and writing, measurements, and the one that
/// installs parts as the current state.
const TOOL_FILES: [(&str, &str); 3] = [
    ("mf.py", include_str!("ia_tools/mf.py")),
    ("measure.py", include_str!("ia_tools/measure.py")),
    ("export.py", include_str!("ia_tools/export.py")),
];
/// The skill with the detailed export recipe; Claude Code finds it in the
/// project's `.claude/skills/`.
const SKILL_DIR: &str = ".claude/skills/export-3mf";
const SKILL: &str = include_str!("ia_tools/SKILL.md");

/// Writes (or refreshes) the tools and the skill of a working folder.
fn write_tools(ws: &Path) -> Result<()> {
    std::fs::create_dir_all(ws.join(TOOLS))?;
    for (name, text) in TOOL_FILES {
        std::fs::write(ws.join(TOOLS).join(name), text)?;
    }
    std::fs::create_dir_all(ws.join(SKILL_DIR))?;
    std::fs::write(ws.join(SKILL_DIR).join("SKILL.md"), SKILL)?;
    Ok(())
}

/// What the original holds, for the instructions.
struct Summary {
    tris: usize,
    /// Name, color and head of each part.
    parts: Vec<(String, String, u8)>,
}

impl Summary {
    fn of(parts: &[Part]) -> Summary {
        let dominant = |p: &Part| {
            let mut count: HashMap<[u8; 3], usize> = HashMap::new();
            for t in &p.tris {
                *count.entry(t.c).or_default() += 1;
            }
            let c = count.into_iter().max_by_key(|(_, n)| *n).map(|(c, _)| c).unwrap_or(crate::render::DEFAULT_COLOR);
            format!("#{:02X}{:02X}{:02X}", c[0], c[1], c[2])
        };
        Summary {
            tris: parts.iter().map(|p| p.tris.len()).sum(),
            parts: parts.iter().map(|p| (p.name.clone(), dominant(p), p.extruder)).collect(),
        }
    }

    fn describe(&self) -> String {
        let mut s = format!("The original object has {} triangles in {} part(s):\n\n", self.tris, self.parts.len());
        for (name, color, head) in &self.parts {
            s.push_str(&format!("- `{name}` — {color}, head {head}\n"));
        }
        s
    }
}

/// What both kinds of conversation share: the files, the export, the rules
/// of a printable part.
const COMMON: &str = "## Saving your work: always 3MF

The app shows, versions and prints **3MF** files: one object made of
**parts**, each with its **color** and the **head** (1 to 4 on the
Snapmaker U1) that prints it. That is how a multicolor model stays one.
**Never hand over an STL as the result**: it has no color and no parts.

- Install a result with `python3 tools/export.py …` — the only way to make
  it the current state. Each install becomes a new version in the app.
- One part per color: `python3 tools/export.py body.stl:#E8E8E8 eyes.stl:#101010`,
  or build the parts in Python and write them with `mf.write` (see the
  `export-3mf` skill, with examples).
- Keep the colors and heads of the current state unless asked otherwise:
  read it with `mf.read(\"out/current.3mf\")`, change the parts' meshes,
  write them back with their names, colors and heads.
- Parts of different colors must not overlap: subtract one from the other
  where they meet.

## Tools

- `tools/mf.py` — `mf.read(path)` gives the parts (`name`, `color`,
  `extruder`, `mesh` as a trimesh), `mf.write(path, parts)` writes them.
  Import it with `sys.path.insert(0, \"tools\")`.
- `tools/export.py` — checks the parts and installs them.
- `tools/measure.py` — dimensions, volume, watertightness, part by part.
- `trimesh`, `manifold3d` (booleans), `numpy`.";

/// The models the user attaches (ia_attach.rs), in both kinds of
/// conversation.
const SOURCES_DOC: &str = "- `sources/` — 3D models the user attached (STL and 3MF files, each
  converted to a 3MF of this workspace's layout: one object, one part per
  head). Read them with `mf.read(\"sources/…\")`; **never modify them**. To
  build on one, read its parts, change or combine them, and install the
  result with `tools/export.py`, as usual. Each is centered on the plate:
  the positions of the original file are not kept. STL has no unit:
  millimeters are assumed; if a size looks wrong (under 1 mm or over 1 m),
  ask.";

/// The instructions left to Claude in the working folder.
fn instructions(source_name: &str, source: &Summary) -> String {
    // The language Claude must answer in: the app's, named in English.
    let lang = crate::i18n::english_name();
    let parts = source.describe();
    format!(
        "# Modifying a part to print

You work on **{source_name}**. What you install shows live in the app, next
to this conversation.

**Always answer the user in {lang}.**

## Look before acting

The `preview/` folder holds three renders of the current state — `front.png`,
`three-quarter.png`, `top.png`, in its colors — that the app renders again
after **every** install.

Open them. They are your only way to see the part: an off-center hole, a wall
that goes through, a part resting askew do not show in the coordinates. Look
before changing, and look again afterwards.

## The files

- `source.3mf` — the original object. **Never modify it.**
- `out/current.3mf` — the current state, the one shown on screen.
- `preview/` — the three renders. Read-only, the app writes them.
- `versions/` — the history, managed by the app. Do not touch it.
- `chat.jsonl`, `attachments/` — this conversation as the app shows it, and
  the images the user attached. Read attachments when asked; never modify
  either.
{SOURCES_DOC}

{parts}
{COMMON}

## How to proceed

1. `python3 tools/measure.py` then look at `preview/three-quarter.png`.
2. Write a Python script that reads `out/current.3mf` with `mf.read`,
   transforms the parts' meshes with `trimesh`, and writes `result.3mf`
   with `mf.write`.
3. Install it: `python3 tools/export.py result.3mf`
4. Look at the previews again, and start over if it is not right.

## What matters

- Units are **millimeters**, the Z axis is the height, and the part rests on
  `z = 0`. After a rotation, put it back on the ground.
- Each part must stay **watertight**: otherwise slicing will fail.
- Always start from `out/current.3mf`, never from `source.3mf`, to chain
  several changes.
- Move in small checkable steps rather than one big script.
- If a request is ambiguous — which side, which face, which dimension — ask
  rather than guess.

No Blender.
"
    )
}

/// The instructions of a conversation that starts from nothing.
fn instructions_creation(bounds: Option<[f32; 3]>) -> String {
    // The language Claude must answer in: the app's, named in English.
    let lang = crate::i18n::english_name();
    let fmt = |v: f32| format!("{v:.0}");
    let envelope = match bounds {
        Some([x, y, z]) => format!(
            "The part must fit in **{} × {} × {} mm** (X × Y × Z): it is the
  printable volume asked for. Check it with `tools/measure.py` at each export.",
            fmt(x),
            fmt(y),
            fmt(z)
        ),
        None => "No size limit is imposed; stay reasonable and ask if the size
  is not clear."
            .into(),
    };
    format!(
        "# Creating a part to print

You design a part **from scratch**, from the user's description. What you
install shows live in the app, next to this conversation.

**Always answer the user in {lang}.**

## Before modeling

If a dimension, a use, a constraint or the colors are missing — screw
diameter, thickness, bearing side, one color or several — **ask** rather
than guess. Then announce in a few lines what you are going to build: base
shapes, main dimensions, colors, print orientation.

## The files

- `out/current.3mf` — the current state, the one shown on screen. It does
  not exist yet: your first install creates it.
- `preview/` — three renders of the current state (`front.png`,
  `three-quarter.png`, `top.png`), in its colors, rendered again by the app
  after **every** install. Read-only.
- `versions/` — the history, managed by the app. Do not touch it.
- `chat.jsonl`, `attachments/` — this conversation as the app shows it, and
  the images the user attached (sketches, photos: look at them). Never modify
  either.
{SOURCES_DOC}

{COMMON}

## How to proceed

1. Write a Python script, `model.py`, that builds the part with `trimesh`
   (primitives: boxes, cylinders, profile extrusions) and `manifold3d` for
   booleans — one mesh per color. Keep the dimensions and colors as named
   variables at the top of the script: they will be revisited.
2. Write the parts with `mf.write(\"result.3mf\", …)` and install them:
   `python3 tools/export.py result.3mf`
3. Open `preview/three-quarter.png` and run `python3 tools/measure.py`.
4. Fix and start again; each install becomes a new version.

The previews are your only way to see the part: an off-center hole, a wall that
goes through do not show in the coordinates. Look after each install.

## What matters

- Units are **millimeters**, the Z axis is the height, and the part rests on
  `z = 0`, centered in X and Y.
- {envelope}
- Each part must be **watertight**: otherwise slicing will fail.
- Think FDM printing: a large flat face on the ground, overhangs under 45°,
  walls of at least 1.2 mm, 0.2 to 0.3 mm of clearance between two parts that
  fit together.
- Move in small checkable steps rather than one big script.

No Blender, no OpenSCAD.
"
    )
}

/// A conversation for other modules' tests.
#[cfg(test)]
pub fn tests_conversation() -> Conversation {
    Conversation {
        id: "11111111-2222-3333-4444-555555555555".into(),
        title: "Test".into(),
        source: "/tmp/x.3mf".into(),
        source_name: "x.3mf".into(),
        prompt: String::new(),
        engine: "local".into(),
        created_at: 0,
        updated_at: 0,
        version: 1,
        saved: None,
        saved_versions: Default::default(),
        started: false,
        kind: String::new(),
        dest_dir: None,
        bounds: None,
        model: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------- Claude session files

    const ID: &str = "0b7c3a52-9d1e-4f4a-8a51-3f0e2b6c9d10";

    /// A fresh fake configuration root, with what Claude Code leaves for
    /// session `ID`, for a neighbour whose id starts with it, and the shared
    /// files that must never go.
    fn fake_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("snapstudio-artifacts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proj = root.join("projects").join("-Users-me-ia-x-workspace");
        let other = root.join("projects").join("-Users-me-elsewhere");
        for d in [&proj, &other, &root.join("file-history").join(ID), &root.join("todos"), &root.join("debug")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let w = |p: PathBuf| std::fs::write(p, "x").unwrap();
        w(proj.join(format!("{ID}.jsonl")));
        w(proj.join(format!("old.orphaned-{ID}-9.jsonl")));
        std::fs::create_dir_all(root.join("image-cache").join(ID)).unwrap();
        std::fs::create_dir_all(proj.join(ID).join("subagents")).unwrap();
        w(proj.join(ID).join("subagents").join("agent-1.jsonl"));
        w(other.join(format!("{ID}.jsonl.superseded-1")));
        w(root.join("file-history").join(ID).join("a.txt"));
        w(root.join("todos").join(format!("{ID}-agent-{ID}.json")));
        w(root.join("debug").join(format!("{ID}.txt")));
        // Neighbours: a longer id, and shared files.
        w(proj.join(format!("{ID}0.jsonl")));
        w(proj.join(format!("x{ID}.jsonl")));
        w(root.join("todos").join(format!("{ID}0-agent-1.json")));
        w(root.join("history.jsonl"));
        w(proj.join("memory.md"));
        root
    }

    fn names(a: &Artifacts, root: &Path) -> Vec<String> {
        let base = root.canonicalize().unwrap();
        let mut v: Vec<String> = a.paths.iter().map(|p| p.strip_prefix(&base).unwrap().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn session_artifacts_match_the_exact_id_only() {
        let root = fake_root("exact");
        let a = artifacts_in(&root, ID).unwrap();
        let mut want = vec![
            format!("debug/{ID}.txt"),
            format!("file-history/{ID}"),
            format!("image-cache/{ID}"),
            format!("projects/-Users-me-elsewhere/{ID}.jsonl.superseded-1"),
            format!("projects/-Users-me-ia-x-workspace/old.orphaned-{ID}-9.jsonl"),
            format!("projects/-Users-me-ia-x-workspace/{ID}"),
            format!("projects/-Users-me-ia-x-workspace/{ID}.jsonl"),
            format!("todos/{ID}-agent-{ID}.json"),
        ];
        want.sort();
        assert_eq!(names(&a, &root), want);
        assert!(a.skipped.is_empty());

        let (n, failed) = remove_artifacts(&a);
        assert_eq!((n, failed.len()), (8, 0));
        // Neighbours, shared files and project folders are all still there.
        let proj = root.join("projects").join("-Users-me-ia-x-workspace");
        for p in [
            proj.join(format!("{ID}0.jsonl")),
            proj.join(format!("x{ID}.jsonl")),
            proj.join("memory.md"),
            root.join("todos").join(format!("{ID}0-agent-1.json")),
            root.join("history.jsonl"),
        ] {
            assert!(p.is_file(), "{} must stay", p.display());
        }
        assert!(root.join("projects").join("-Users-me-elsewhere").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_artifacts_refuse_bad_ids() {
        let root = fake_root("ids");
        let dashes = "-".repeat(36);
        for bad in [
            "",
            "..",
            "*",
            &ID[..35],
            "../../../../../../etc/passwdxxxxxxxxx",
            "0b7c3a52-9d1e-4f4a-8a51-3f0e2b6c9d1/",
            &dashes,
            "0b7c3a529d1e-4f4a-8a51-3f0e2b6c9d10-",
            "0b7c3a52-9d1e-4f4a-8a51-3f0e2b6c9d1.",
        ] {
            assert!(artifacts_in(&root, bad).is_err(), "{bad:?} must be refused");
        }
        // A missing root is simply empty.
        let none = artifacts_in(&root.join("absent"), ID).unwrap();
        assert!(none.paths.is_empty() && none.skipped.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_folder_named_like_the_id_is_never_listed() {
        let root = fake_root("projdir");
        // projects/<id>/ is a project folder: only what is inside may go.
        let p = root.join("projects").join(ID);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("keep.jsonl"), "x").unwrap();
        let a = artifacts_in(&root, ID).unwrap();
        let base = root.canonicalize().unwrap();
        assert!(!a.paths.contains(&base.join("projects").join(ID)));
        remove_artifacts(&a);
        assert!(p.join("keep.jsonl").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn session_artifacts_never_follow_links() {
        use std::os::unix::fs::symlink;
        let root = fake_root("links");
        let outside = std::env::temp_dir().join(format!("snapstudio-artifacts-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(outside.join("proj")).unwrap();
        std::fs::write(outside.join("victim.txt"), "keep").unwrap();
        std::fs::write(outside.join("proj").join(format!("{ID}.jsonl")), "keep").unwrap();
        let proj = root.join("projects").join("-Users-me-ia-x-workspace");
        // A link named like the session, pointing out of the root.
        symlink(outside.join("victim.txt"), root.join("debug").join(format!("{ID}.log"))).unwrap();
        // A whole project folder that is a link out of the root.
        symlink(outside.join("proj"), root.join("projects").join("-linked")).unwrap();
        // A session folder replaced by a link.
        std::fs::remove_dir_all(root.join("file-history").join(ID)).unwrap();
        symlink(&outside, root.join("file-history").join(ID)).unwrap();
        // A link inside a folder that will be deleted: removed, not followed.
        symlink(outside.join("victim.txt"), proj.join(ID).join("link")).unwrap();

        let a = artifacts_in(&root, ID).unwrap();
        let listed = names(&a, &root);
        assert!(!listed.iter().any(|n| n.contains("-linked") || n.ends_with(".log") || n.starts_with("file-history")), "{listed:?}");
        assert_eq!(a.skipped.len(), 2, "{:?}", a.skipped);
        remove_artifacts(&a);
        assert_eq!(std::fs::read_to_string(outside.join("victim.txt")).unwrap(), "keep");
        assert!(outside.join("proj").join(format!("{ID}.jsonl")).is_file());
        assert!(!proj.join(ID).exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_projects_folder_is_skipped() {
        use std::os::unix::fs::symlink;
        let root = fake_root("projlink");
        let outside = std::env::temp_dir().join(format!("snapstudio-artifacts-pl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(outside.join("p")).unwrap();
        std::fs::write(outside.join("p").join(format!("{ID}.jsonl")), "keep").unwrap();
        std::fs::rename(root.join("projects"), root.join("projects.real")).unwrap();
        symlink(&outside, root.join("projects")).unwrap();
        let a = artifacts_in(&root, ID).unwrap();
        assert!(!names(&a, &root).iter().any(|n| n.starts_with("projects")));
        remove_artifacts(&a);
        assert!(outside.join("p").join(format!("{ID}.jsonl")).is_file());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn claude_config_dir_comes_first() {
        let home = PathBuf::from("/Users/me");
        assert_eq!(claude_roots_from(None, Some(home.clone())), vec![home.join(".claude")]);
        assert_eq!(claude_roots_from(Some("".into()), Some(home.clone())), vec![home.join(".claude")]);
        assert_eq!(
            claude_roots_from(Some("/conf/claude".into()), Some(home.clone())),
            vec![PathBuf::from("/conf/claude"), home.join(".claude")]
        );
        // Relative: ignored. Same as the default: not twice.
        assert_eq!(claude_roots_from(Some("rel".into()), Some(home.clone())), vec![home.join(".claude")]);
        assert_eq!(claude_roots_from(Some("/Users/me/.claude".into()), Some(home.clone())), vec![home.join(".claude")]);
    }

    #[test]
    fn session_file_slug() {
        assert_eq!(project_slug(Path::new("/Users/me/.config/snap-studio/ia/x/workspace")), "-Users-me--config-snap-studio-ia-x-workspace");
        assert!(session_file(ID).ends_with(format!("{ID}.jsonl")));
    }

    #[test]
    fn a_duplicate_has_the_files_but_a_fresh_session() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-dup-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("cube.3mf");
        cube_3mf(&src);
        let mut c = create(&src, "make it taller", "local").unwrap();
        c.started = true;
        c.saved = Some("/x/y.3mf".into());
        save(&c).unwrap();
        let ws = workspace(&c.id);
        std::fs::write(crate::chat::log_path(&ws), "{}\n").unwrap();
        std::fs::create_dir_all(crate::chat::attachments_dir(&ws)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", ws.join("link")).unwrap();

        let d = duplicate(&c.id).unwrap();
        let dws = workspace(&d.id);
        assert_ne!(d.id, c.id);
        assert!(!d.started && d.saved.is_none() && d.prompt.is_empty());
        assert_eq!(d.source, c.source);
        assert!(dws.join("CLAUDE.md").is_file() && dws.join("out").join(CURRENT).is_file());
        assert!(!crate::chat::log_path(&dws).exists());
        assert!(!crate::chat::attachments_dir(&dws).exists());
        assert!(std::fs::symlink_metadata(dws.join("link")).is_err());
        assert_eq!(get(&d.id).unwrap().title, d.title);

        let r = rename(&d.id, "  New   name ").unwrap();
        assert_eq!(r.title, "New name");
        assert_eq!(r.updated_at, d.updated_at, "renaming is not activity");
        assert!(rename(&d.id, "   ").is_err());
        assert!(duplicate("../x").is_err());
        remove(&c.id).unwrap();
        remove(&d.id).unwrap();
    }

    #[test]
    fn names_session_rules() {
        use Place::*;
        assert!(names_session(ID, ID, Other));
        assert!(names_session(&format!("{ID}.jsonl"), ID, Project));
        assert!(!names_session(&format!("{ID}0.jsonl"), ID, Project));
        assert!(!names_session(&format!("{ID}-agent-x.json"), ID, Other));
        assert!(names_session(&format!("{ID}-agent-x.json"), ID, Todos));
        assert!(names_session(&format!("x.orphaned-{ID}-1.jsonl"), ID, Project));
        assert!(!names_session(&format!("x.orphaned-{ID}-1.jsonl"), ID, Other));
        assert!(!names_session(&format!("x.orphaned-{ID}0-1.jsonl"), ID, Project));
        assert!(!names_session(&format!("x.orphaned-a{ID}-1.jsonl"), ID, Project));
        assert!(!names_session("history.jsonl", ID, Other));
    }

    fn cube_3mf(dst: &Path) {
        let tris = crate::stl::tests_cube();
        crate::write3mf::write_scene(dst, &[SceneObject { name: "cube".into(), tris, transform: Mat::IDENTITY, extruder: None }]).unwrap();
    }

    /// Claude installs an object: what `tools/export.py` does.
    fn install(id: &str, tris: Vec<crate::mesh::Tri>) {
        write_3mf(&current(id), "object", &[Part { name: "part-1".into(), tris, extruder: 1, paint: Vec::new() }]).unwrap();
    }

    #[test]
    fn creates_and_removes_a_workspace() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("cube.3mf");
        cube_3mf(&src);

        let c = create(&src, "Tilt the top by 15°", "local").unwrap();
        let ws = workspace(&c.id);
        for f in [
            "CLAUDE.md",
            ".claude/skills/export-3mf/SKILL.md",
            "source.3mf",
            "tools/mf.py",
            "tools/measure.py",
            "tools/export.py",
            "out/current.3mf",
            "versions/v1.3mf",
        ] {
            assert!(ws.join(f).exists(), "{f} should exist");
        }
        assert_eq!(c.title, "Tilt the top by 15°");
        assert_eq!(c.version, 1);
        assert!(list().iter().any(|x| x.id == c.id));
        assert!(get(&c.id).is_ok());

        remove(&c.id).unwrap();
        assert!(!dir(&c.id).exists());
        assert!(!list().iter().any(|x| x.id == c.id));
        let _ = std::fs::remove_file(&src);
    }

    /// An STL dropped in the creation sheet with "Start from this model"
    /// becomes the conversation's original, as a one-part 3MF.
    #[test]
    fn a_conversation_starts_from_an_stl() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("bracket.stl");
        crate::stl::write(&src, &crate::stl::tests_cube()).unwrap();
        let c = create(&src, "", "local").unwrap();
        let ws = workspace(&c.id);
        for f in ["source.3mf", "out/current.3mf", "versions/v1.3mf"] {
            assert!(ws.join(f).is_file(), "{f} should exist");
        }
        let parts = parts_of_3mf(&ws.join("source.3mf")).unwrap();
        assert_eq!((parts.len(), parts[0].tris.len(), parts[0].extruder), (1, 12, 1));
        assert_eq!(c.title, "bracket");
        assert_eq!(c.source_name, "bracket.stl");
        let md = std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap();
        assert!(md.contains("`sources/`"), "the instructions tell about attached models");
        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// A two-color original keeps its parts, colors and heads all the way.
    #[test]
    fn a_multicolor_original_keeps_its_parts() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("deux-couleurs.3mf");
        let paint = |c: [u8; 3]| -> Vec<crate::mesh::Tri> {
            crate::stl::tests_cube()
                .into_iter()
                .map(|mut t| {
                    t.c = c;
                    t
                })
                .collect()
        };
        let parts = [
            Part { name: "body".into(), tris: paint([240, 240, 240]), extruder: 1, paint: Vec::new() },
            Part { name: "eyes".into(), tris: paint([20, 20, 20]), extruder: 2, paint: Vec::new() },
        ];
        crate::write3mf::write_multipart(&src, "duo", &parts, &Mat::IDENTITY).unwrap();

        let c = create(&src, "", "local").unwrap();
        let got = parts_of_3mf(&current(&c.id)).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].extruder, got[0].tris[0].c), (1, [240, 240, 240]));
        assert_eq!((got[1].extruder, got[1].tris[0].c), (2, [20, 20, 20]));
        let md = std::fs::read_to_string(workspace(&c.id).join("CLAUDE.md")).unwrap();
        assert!(md.contains("`part-2` — #141414, head 2"), "{md}");

        // Saved as is: the slicer finds both heads and their colors.
        let out = save_to_files(&c.id).unwrap();
        let info = crate::slice::model_info(Path::new(&out)).unwrap();
        assert_eq!(info.used, vec![1, 2]);
        assert_eq!(info.filaments[1].color.as_deref(), Some("#141414"));
        std::fs::remove_file(&out).unwrap();
        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// One part per head when the file assigns heads.
    #[test]
    fn parts_follow_the_heads() {
        let mut m = crate::mesh::MeshData {
            tris: crate::stl::tests_cube(),
            min: [0.0; 3],
            max: [1.0; 3],
            truncated: false,
            volumes: Vec::new(),
            paint: Vec::new(),
            extruders: vec![1; 12],
        };
        for e in &mut m.extruders[6..] {
            *e = 3;
        }
        let parts = split_by_head(m);
        assert_eq!(parts.iter().map(|p| (p.extruder, p.tris.len())).collect::<Vec<_>>(), vec![(1, 6), (3, 6)]);
    }

    /// A painted file reaches the AI in closed parts (per volume, never per
    /// painted color), its triangles in their filament colors.
    #[test]
    fn painted_files_stay_in_closed_parts() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("painted.3mf");
        crate::mesh::testkit::painted_cube_with(&src, &["8", "8"], Some(1), "1 0 0 0 1 0 0 0 1 50 50 0", &["#FF0000", "#0000FF"]);
        let parts = parts_of_3mf(&src).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!((parts[0].extruder, parts[0].tris.len()), (1, 12));
        assert_eq!(parts[0].tris[0].c, [0, 0, 255], "painted with filament 2");
        assert_eq!(parts[0].tris[5].c, [255, 0, 0], "the volume's filament 1");
    }

    /// A conversation from the STL days is brought to 3MF when opened; its
    /// old versions stay usable.
    #[test]
    fn stl_conversations_move_to_3mf() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("ancienne.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let ws = workspace(&c.id);
        // The old layout.
        for f in ["source.3mf", "out/current.3mf", "versions/v1.3mf"] {
            std::fs::remove_file(ws.join(f)).unwrap();
        }
        let cube = crate::stl::tests_cube();
        for f in ["source.stl", "out/current.stl", "versions/v1.stl"] {
            crate::stl::write(&ws.join(f), &cube).unwrap();
        }

        refresh_workspace(&c.id);
        assert!(current(&c.id).is_file() && ws.join("source.3mf").is_file());
        assert!(!ws.join("out/current.stl").exists() && !ws.join("source.stl").exists());
        assert_eq!(current_stats(&c.id).unwrap().triangles, 12);
        assert!(ws.join("tools/mf.py").is_file());

        install(&c.id, cube[..10].to_vec());
        assert_eq!(capture(&c.id).unwrap(), 2, "numbering goes on after v1.stl");
        assert!(ws.join("versions/v2.3mf").is_file());
        revert(&c.id, 1).unwrap();
        assert_eq!(current_stats(&c.id).unwrap().triangles, 12, "back from v1.stl");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// What `tools/mf.py` writes is read by the app with its parts, colors
    /// and heads. The fixture comes from `mf.write`; the live test below
    /// regenerates it when Python has trimesh.
    #[test]
    fn python_3mf_is_read_with_its_colors_and_heads() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mf-two-parts.3mf");
        let parts = parts_of_3mf(&p).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!((parts[0].extruder, parts[0].tris[0].c), (1, [0xF2, 0xF2, 0xF2]));
        assert_eq!((parts[1].extruder, parts[1].tris[0].c), (2, [0x15, 0x15, 0x15]));
        let info = crate::slice::model_info(&p).unwrap();
        assert_eq!(info.used, vec![1, 2]);
        let stats = crate::mesh::stats(&read_mesh(&p).unwrap());
        assert_eq!(stats.watertight, Some(true));
    }

    /// The tools for real: `export.py` installs two colored parts, the watch
    /// archives them. Needs a Python with trimesh:
    /// `SS_PYTHON=/path/to/python cargo test --lib python_tools -- --ignored`.
    #[test]
    #[ignore]
    fn python_tools_install_a_multicolor_result() {
        let Ok(python) = std::env::var("SS_PYTHON") else { return };
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("outils.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let ws = workspace(&c.id);
        let script = r#"
import sys; sys.path.insert(0, "tools")
import mf, trimesh
body = trimesh.creation.box((20, 20, 10)); body.apply_translation((0, 0, 5))
eye = trimesh.creation.icosphere(radius=3); eye.apply_translation((0, 0, 13))
body.export("body.stl"); eye.export("eye.stl")
"#;
        let run = |args: &[&str]| {
            let out = std::process::Command::new(&python).args(args).current_dir(&ws).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        run(&["-c", script]);
        println!("{}", run(&["tools/export.py", "body.stl:#F2F2F2", "eye.stl:#151515"]));
        let last = Mutex::new(hash_file(&ws.join("versions/v1.3mf")).unwrap());
        assert!(matches!(consider(&c.id, &last), Change::Archived(2, _)));
        let parts = parts_of_3mf(&current(&c.id)).unwrap();
        assert_eq!(parts.iter().map(|p| p.extruder).collect::<Vec<_>>(), vec![1, 2]);
        println!("{}", run(&["tools/measure.py"]));
        if std::env::var("SS_FIXTURE").is_ok() {
            let dst = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mf-two-parts.3mf");
            std::fs::copy(current(&c.id), dst).unwrap();
        }
        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn versions_are_captured_and_restored() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("versions.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        assert_eq!(versions(&c.id).len(), 1, "the original is version 1");

        // Claude writes a different object: one face less.
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10);
        install(&c.id, tris);
        assert_eq!(capture(&c.id).unwrap(), 2);
        assert_eq!(versions(&c.id).len(), 2);
        assert_eq!(get(&c.id).unwrap().version, 2);
        assert_eq!(read_mesh(&current(&c.id)).unwrap().tris.len(), 10);

        // Going back: the current state becomes the original again.
        revert(&c.id, 1).unwrap();
        assert_eq!(read_mesh(&current(&c.id)).unwrap().tris.len(), 12);
        assert_eq!(get(&c.id).unwrap().version, 1);
        assert_eq!(versions(&c.id).len(), 2, "going back archives nothing");
        assert!(revert(&c.id, 9).is_err(), "version that does not exist");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// The core of the watch, without window nor thread: what deserves to be
    /// archived, and what does not.
    #[test]
    fn only_real_changes_are_archived() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("veille.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let last = Mutex::new(hash_file(&current(&c.id)).unwrap());

        // Nothing moved.
        assert!(matches!(consider(&c.id, &last), Change::Nothing));

        // Claude writes a different object.
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10);
        install(&c.id, tris.clone());
        let Change::Archived(v, stats) = consider(&c.id, &last) else {
            panic!("the change should have been archived");
        };
        assert_eq!(v, 2);
        assert_eq!(stats.triangles, 10);
        assert_eq!(stats.watertight, Some(false));

        // Writing the same content again must not create one more version.
        install(&c.id, tris);
        assert!(matches!(consider(&c.id, &last), Change::Nothing));
        assert_eq!(versions(&c.id).len(), 2);

        // A file truncated mid-write: come back later.
        std::fs::write(current(&c.id), b"a half-written file").unwrap();
        assert!(matches!(consider(&c.id, &last), Change::TryAgain));
        assert_eq!(versions(&c.id).len(), 2, "nothing was archived meanwhile");

        // And going back does not trigger archiving again.
        revert(&c.id, 1).unwrap();
        *last.lock().unwrap() = hash_file(&current(&c.id)).unwrap();
        assert!(matches!(consider(&c.id, &last), Change::Nothing));

        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn stats_describe_the_current_object() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("stats.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let s = current_stats(&c.id).unwrap();
        assert_eq!(s.triangles, 12);
        assert_eq!(s.watertight, Some(true));
        assert!((s.volume_cm3 - 1.0).abs() < 1e-3);
        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// A forged id must not be able to climb out of the store: ".." stays
    /// under the root lexically, but not for the kernel.
    #[test]
    fn refuses_a_path_outside_the_store() {
        for bad in ["..", ".", "", "../evasion", "a/b", "../../Documents", "\u{e9}"] {
            assert!(remove(bad).is_err(), "“{bad}” should have been refused");
        }
        assert!(root().is_dir(), "the store is still there");
        assert!(valid_id("b703e739-e760-4642-89a6-881a754d420c"));
        assert!(!valid_id("b703e739-e760-4642-89a6-881a754d420"), "too short");
    }

    #[test]
    fn a_blank_conversation_starts_without_an_object() {
        let dest = std::env::temp_dir().join("snapstudio-ia-blank");
        std::fs::create_dir_all(&dest).unwrap();
        assert!(create_blank("  ", "local", &dest, None).is_err(), "description required");

        let c = create_blank("Wall hook for headphones", "local", &dest, Some([270.0, 270.0, 270.0])).unwrap();
        let ws = workspace(&c.id);
        assert!(c.is_creation());
        assert_eq!(c.version, 0);
        assert!(ws.join("out").is_dir(), "the watch needs the folder");
        assert!(!current(&c.id).exists());
        assert!(!ws.join("source.3mf").exists());
        let md = std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap();
        assert!(md.contains("270 × 270 × 270 mm"));
        assert!(save_to_files(&c.id).is_err(), "nothing to save before the first export");

        // First export: v1 appears, and the object goes to the chosen folder.
        install(&c.id, crate::stl::tests_cube());
        let last = Mutex::new(0);
        assert!(matches!(consider(&c.id, &last), Change::Archived(1, _)));
        assert!(previews_dir(&c.id).join("three-quarter.png").is_file());
        let out = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&out).parent(), Some(dest.as_path()));
        assert!(out.ends_with("wall-hook-for-headphones-ai.3mf"), "{out}");
        std::fs::remove_file(&out).unwrap();
        remove(&c.id).unwrap();
    }

    #[test]
    fn attachments_stay_in_their_folder() {
        let id = "11111111-2222-3333-4444-555555555555";
        for bad in ["../meta.json", "a/b.png", ".hidden", "", "x y.png"] {
            assert!(attachment(id, bad).is_err(), "{bad:?} must be refused");
        }
        assert!(attachment("not-an-id", "001-a.png").is_err());
    }

    #[test]
    fn slugs_make_tidy_file_names() {
        assert_eq!(slug("Wall hook, 60 mm"), "wall-hook-60-mm");
        assert_eq!(slug("Boîte à vis…"), "boîte-à-vis");
        assert_eq!(slug("  !!  "), "object");
    }

    #[test]
    fn title_falls_back_on_the_file_name() {
        let p = PathBuf::from("/tmp/support-v2.3mf");
        assert_eq!(title_for("", &p), "support-v2");
        assert_eq!(title_for("  Drill a hole  ", &p), "Drill a hole");
        let long = "a".repeat(80);
        assert_eq!(title_for(&long, &p).chars().count(), 61, "truncated with an ellipsis");
    }
}

#[cfg(test)]
mod essai_reel {
    use super::*;

    /// A real Claude in the sandbox designs a two-color part, following the
    /// instructions and the skill alone. Long (image, model):
    /// `IA_REAL=1 cargo test --lib real_container_multicolor -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_container_multicolor() {
        if std::env::var("IA_REAL").is_err() {
            return;
        }
        let dest = std::env::temp_dir().join("snapstudio-ia-real");
        std::fs::create_dir_all(&dest).unwrap();
        let c = create_blank(
            "A keychain tag, 40 x 20 x 3 mm, white, with a black stripe 4 mm wide inlaid across its top face. \
             Do not ask questions: choose the remaining details yourself, install the result, and stop.",
            "container",
            &dest,
            None,
        )
        .unwrap();
        let ws = workspace(&c.id);
        let argv = [
            "claude".to_string(),
            "--claude-config".into(),
            "--customize-file".into(),
            dockerfile().to_string_lossy().to_string(),
            "-p".into(),
            c.prompt.clone(),
            "--output-format".into(),
            "json".into(),
        ];
        let mut cmd = std::process::Command::new(crate::util::which("yolobox").expect("yolobox"));
        cmd.args(&argv).current_dir(&ws).stdin(std::process::Stdio::null());
        for (k, v) in crate::auth::sandbox_env("container") {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let start = text.find('{').unwrap_or(0);
        let v: serde_json::Value = serde_json::from_str(text[start..].trim()).unwrap_or_default();
        println!("claude: {}", v["result"].as_str().unwrap_or(&text));
        let parts = parts_of_3mf(&current(&c.id)).expect("out/current.3mf");
        let summary = Summary::of(&parts);
        println!("{}", summary.describe());
        assert!(!ws.join("out/current.stl").exists());
        assert!(parts.len() >= 2, "two colors, so two parts");
        let colors: std::collections::HashSet<_> = summary.parts.iter().map(|p| p.1.clone()).collect();
        let heads: std::collections::HashSet<_> = summary.parts.iter().map(|p| p.2).collect();
        assert!(colors.len() >= 2 && heads.len() >= 2, "{colors:?} {heads:?}");
        println!("folder: {}", ws.display());
        if std::env::var("IA_KEEP").is_err() {
            remove(&c.id).unwrap();
        }
    }

    /// Prepares a real conversation from a 3MF on disk.
    ///
    /// `IA_3MF=/path/object.3mf cargo test essai_reel -- --nocapture`
    #[test]
    fn prepares_a_real_file() {
        let Ok(src) = std::env::var("IA_3MF") else {
            return;
        };
        let src = PathBuf::from(src);
        let c = create(&src, "Essai", "local").unwrap();
        let ws = workspace(&c.id);
        let got = read_mesh(&ws.join(SOURCE)).unwrap();
        let orig = mesh_of_3mf(&src).unwrap();
        let parts = parts_of_3mf(&ws.join(SOURCE)).unwrap();
        println!("{} : {} triangles in {} part(s), encombrement {:?} mm", c.source_name, got.tris.len(), parts.len(), got.size());
        assert_eq!(got.tris.len(), orig.tris.len(), "no triangle lost");
        for k in 0..3 {
            assert!((got.min[k] - orig.min[k]).abs() < 1e-3);
            assert!((got.max[k] - orig.max[k]).abs() < 1e-3);
        }
        println!("folder: {}", ws.display());

        // The previews: what Claude will open to look at its work.
        write_previews(&c.id).unwrap();
        if let Ok(dest) = std::env::var("IA_PNG") {
            std::fs::create_dir_all(&dest).unwrap();
            for (name, _) in VIEWS {
                let from = previews_dir(&c.id).join(format!("{name}.png"));
                let bytes = std::fs::metadata(&from).unwrap().len();
                assert!(bytes > 2000, "{name}.png is {bytes} bytes");
                std::fs::copy(&from, std::path::Path::new(&dest).join(format!("{name}.png"))).unwrap();
                println!("preview {name}: {bytes} bytes");
            }
        }

        // And the way back into the user's files.
        let saved = save_to_files(&c.id).unwrap();
        println!("saved: {saved}");
        assert!(std::path::Path::new(&saved).is_file());
        assert_eq!(get(&c.id).unwrap().saved.as_deref(), Some(saved.as_str()));
        let back = mesh_of_3mf(std::path::Path::new(&saved)).unwrap();
        assert_eq!(back.tris.len(), orig.tris.len(), "the 3MF returned is complete");
        std::fs::remove_file(&saved).unwrap();

        remove(&c.id).unwrap();
    }
}

// ------------------------------------------------------------ sandbox

/// Dockerfile fragment added to the sandbox image.
///
/// Deliberately light: trimesh covers booleans, measurements and repairs,
/// which is enough to touch up a part. Blender would come here the day a
/// request really needs it.
const DOCKERFILE: &str = "\
# Modeling tools for Snap Studio's AI conversations.
#
# Installed as administrator, so system-wide: the container's home folder is
# covered by a volume at run time, and anything put there at build time would
# disappear.
USER root
RUN pip3 install --no-cache-dir --break-system-packages \\
      trimesh manifold3d numpy
USER yolo
";

/// The fragment on disk, written if missing.
///
/// It is shared by all conversations: the sandbox is only built once, and the
/// following ones start at once.
pub fn dockerfile() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(std::env::temp_dir)
        .join("snap-studio");
    let _ = std::fs::create_dir_all(&base);
    let p = base.join("yolobox.dockerfile");
    if std::fs::read_to_string(&p).ok().as_deref() != Some(DOCKERFILE) {
        let _ = std::fs::write(&p, DOCKERFILE);
    }
    p
}

// ------------------------------------------------------------ previews

/// The three views Claude can open to look at its work. The top view is
/// deliberately tilted by about twenty degrees: straight from above, all top
/// faces look the same and relief vanishes — a 0.5 mm engraving rendered a
/// uniform disc.
const VIEWS: [(&str, [f32; 3]); 3] = [("front", [0.0, -1.0, 0.12]), (THREE_QUARTER, [0.62, -1.0, 0.68]), ("top", [0.0, -0.36, 1.0])];
/// The view that also serves as the thumbnail of a created object.
const THREE_QUARTER: &str = "three-quarter";

/// Triangle budget for a preview: the silhouette gains nothing beyond it, and
/// a dense mesh would cost several seconds per view.
const PREVIEW_BUDGET: usize = 250_000;

/// Puts the render on a dark background.
///
/// Parts are light and the render lights them up to white: on a white
/// background the silhouette fades and judging an outline becomes
/// impossible. A slate background keeps the shape readable whatever happens.
fn flatten(img: image::RgbaImage) -> image::RgbaImage {
    const BG: [u8; 3] = [38, 42, 52];
    let mut out = img;
    for p in out.pixels_mut() {
        let a = p.0[3] as f32 / 255.0;
        for k in 0..3 {
            p.0[k] = (p.0[k] as f32 * a + BG[k] as f32 * (1.0 - a)).round() as u8;
        }
        p.0[3] = 255;
    }
    out
}

pub fn previews_dir(id: &str) -> PathBuf {
    previews_dir_of(&workspace(id))
}

pub fn previews_dir_of(ws: &Path) -> PathBuf {
    ws.join("preview")
}

/// Renders three views of the current state into `preview/`.
///
/// It is the piece that changes everything: without an image, Claude edits a
/// mesh blindly and cannot notice that a hole is off-center. It only has to
/// open these files with its reading tool.
///
/// They are written outside the watched folder, so as not to wake the watch
/// at each render.
pub fn write_previews(id: &str) -> Result<()> {
    let mut mesh = read_mesh(&current(id))?;
    crate::mesh::downsample(&mut mesh, PREVIEW_BUDGET);
    let dir = previews_dir(id);
    std::fs::create_dir_all(&dir)?;
    for (name, eye) in VIEWS {
        let img = flatten(crate::render::render_from(&mesh, 720, eye));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
        std::fs::write(dir.join(format!("{name}.png")), png)?;
    }
    Ok(())
}

/// The three-quarter view, for the thumbnail of a created object: it has no
/// original to take a thumbnail from.
pub fn preview_png(id: &str) -> Result<Vec<u8>> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    let png = previews_dir(id).join(format!("{THREE_QUARTER}.png"));
    // Conversations from before the English layout, until their next opening.
    let legacy = workspace(id).join("apercu").join("trois-quarts.png");
    Ok(std::fs::read(&png).or_else(|_| std::fs::read(legacy))?)
}

/// An image the user attached to the conversation, with its MIME type. Only a
/// plain file name of `attachments/` is accepted: no path, no way out.
pub fn attachment(id: &str, name: &str) -> Result<(Vec<u8>, &'static str)> {
    let plain = !name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !valid_id(id) || !plain {
        return Err(anyhow!("unknown attachment"));
    }
    let path = crate::chat::attachments_dir(&workspace(id)).join(name);
    let mime = match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
        Some(e) if e == "png" => "image/png",
        Some(e) if e == "jpg" || e == "jpeg" => "image/jpeg",
        Some(e) if e == "gif" => "image/gif",
        Some(e) if e == "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Ok((std::fs::read(path)?, mime))
}

/// Brings what belongs to the app in a working folder up to date.
///
/// Instructions and tools improve from version to version: a conversation
/// opened two weeks ago must benefit, otherwise Claude would work with stale
/// instructions — and without previews, which did not always exist. The
/// language Claude answers in follows the app's at each opening.
pub fn refresh_workspace(id: &str) {
    let ws = workspace(id);
    if !ws.is_dir() {
        return;
    }
    let Ok(c) = get(id) else { return };
    migrate_to_3mf(&ws);
    let text = if c.is_creation() {
        instructions_creation(c.bounds)
    } else {
        let parts = parts_of_3mf(&ws.join(SOURCE)).unwrap_or_default();
        instructions(&c.source_name, &Summary::of(&parts))
    };
    let _ = std::fs::write(ws.join("CLAUDE.md"), text);
    let _ = write_tools(&ws);
    if current(id).is_file() && !previews_dir(id).join(format!("{THREE_QUARTER}.png")).is_file() {
        let _ = write_previews(id);
    }
}

/// A conversation from the STL days: its source and current state become
/// one-part 3MF files. The old versions stay as they are, still readable.
fn migrate_to_3mf(ws: &Path) {
    for (old, new) in [("source.stl", SOURCE), ("out/current.stl", "out/current.3mf")] {
        let (old, new) = (ws.join(old), ws.join(new));
        if old.is_file() && !new.exists() && stl_to_3mf(&old, &new, "object").is_ok() {
            let _ = std::fs::remove_file(&old);
        }
    }
}

// ------------------------------------------------------------ saving

/// Free name in a folder: `support-ai.3mf`, then `support-ai-2.3mf`.
fn free_name(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}-ai.3mf"));
    if !first.exists() {
        return first;
    }
    for n in 2..999 {
        let p = dir.join(format!("{stem}-ai-{n}.3mf"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-ai-{}.3mf", now()))
}

/// File name from a title: "Wall hook, 60 mm" → `wall-hook-60-mm`.
fn slug(title: &str) -> String {
    let mut out = String::new();
    for ch in title.trim_end_matches('…').chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(40).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "object".into()
    } else {
        out
    }
}

/// Saves the current state into your files, as 3MF.
///
/// A modified object goes back next to the one it came from, a created object
/// into the folder chosen at creation; if that folder has gone, it lands in
/// Downloads rather than get lost.
pub fn save_to_files(id: &str) -> Result<String> {
    let c = get(id)?;
    if !current(id).is_file() {
        return Err(anyhow!(crate::t!("err.nothing_to_save")));
    }
    // This version is already in your files: no second copy of it.
    if let Some(p) = c.saved_versions.get(&c.version) {
        if Path::new(p).is_file() {
            return Ok(p.clone());
        }
    }
    let (home, stem) = if c.is_creation() {
        (c.dest_dir.clone().map(PathBuf::from), slug(&c.title))
    } else {
        let src = PathBuf::from(&c.source);
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "object".into());
        (src.parent().map(PathBuf::from), stem)
    };
    let dir = home.filter(|d| d.is_dir()).or_else(dirs::download_dir).ok_or_else(|| anyhow!(crate::t!("err.nowhere_to_write")))?;
    let dst = free_name(&dir, &stem);
    std::fs::copy(current(id), &dst)?;

    let mut c = c;
    c.saved = Some(dst.to_string_lossy().to_string());
    c.saved_versions.insert(c.version, dst.to_string_lossy().to_string());
    c.updated_at = now();
    save(&c)?;
    Ok(dst.to_string_lossy().to_string())
}

// ------------------------------------------------------------ versions

#[derive(Serialize, Clone)]
pub struct Version {
    pub n: u32,
    pub at: u64,
    pub bytes: u64,
}

fn versions_dir(id: &str) -> PathBuf {
    workspace(id).join("versions")
}

/// The saved versions, from the first to the last.
pub fn versions(id: &str) -> Vec<Version> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(versions_dir(id)) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(n) = name
            .strip_prefix('v')
            .and_then(|s| s.strip_suffix(".3mf").or_else(|| s.strip_suffix(".stl")))
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let meta = e.metadata().ok();
        out.push(Version {
            n,
            at: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            bytes: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by_key(|v| v.n);
    out
}

/// Fingerprint of a file's content, so as not to archive the same thing twice
/// — a save without changes happens more often than one thinks.
fn hash_file(p: &Path) -> Option<u64> {
    let data = std::fs::read(p).ok()?;
    Some(crate::util::fnv1a(&[&data]))
}

/// Archives the current state under the next number.
fn capture(id: &str) -> Result<u32> {
    let cur = current(id);
    let n = versions(id).last().map(|v| v.n).unwrap_or(0) + 1;
    std::fs::copy(&cur, versions_dir(id).join(format!("v{n}.3mf")))?;
    if let Ok(mut c) = get(id) {
        c.version = n;
        c.updated_at = now();
        let _ = save(&c);
    }
    Ok(n)
}

/// Makes an earlier version the current state.
///
/// The watch is told: this going back must not create one more version,
/// otherwise the history would swell at every round trip.
pub fn revert(id: &str, n: u32) -> Result<()> {
    let file = |ext: &str| versions_dir(id).join(format!("v{n}.{ext}"));
    if file("3mf").is_file() {
        replace_with(&file("3mf"), &current(id))?;
    } else if file("stl").is_file() {
        // A version from the STL days.
        stl_to_3mf(&file("stl"), &current(id), "object")?;
    } else {
        return Err(anyhow!(crate::t!("err.no_version", n = n)));
    }
    if let Some(h) = hash_file(&current(id)) {
        if let Some(w) = watchers().lock().unwrap().get(id) {
            *w.last.lock().unwrap() = h;
        }
    }
    if let Ok(mut c) = get(id) {
        c.version = n;
        c.updated_at = now();
        let _ = save(&c);
    }
    Ok(())
}

// ------------------------------------------------------------ watching

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct Watcher {
    stop: Arc<AtomicBool>,
    /// Fingerprint of the last mesh taken into account.
    last: Arc<Mutex<u64>>,
    /// Sequence number: a watcher only removes its own registration, otherwise
    /// it would erase its successor's when stopping.
    token: u64,
}

fn next_token() -> u64 {
    use std::sync::atomic::AtomicU64;
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

fn watchers() -> &'static Mutex<HashMap<String, Watcher>> {
    static W: OnceLock<Mutex<HashMap<String, Watcher>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
struct MeshEvent {
    id: String,
    version: u32,
    stats: crate::mesh::Stats,
}

/// Path of the current mesh and stamp of its last write.
///
/// The stamp busts the display cache: the mesh address never changes, and
/// without it the viewer would serve the previous object again. It is taken
/// from the file itself, not from the version number, which only advances
/// while a watcher runs.
#[derive(Serialize)]
pub struct CurrentDto {
    pub path: String,
    pub stamp: String,
}

pub fn current_dto(id: &str) -> Result<CurrentDto> {
    let p = current(id);
    let m = std::fs::metadata(&p)?;
    let secs = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    Ok(CurrentDto { path: p.to_string_lossy().to_string(), stamp: format!("{secs}-{}", m.len()) })
}

/// Reads the current state and takes its measurements.
pub fn current_stats(id: &str) -> Result<crate::mesh::Stats> {
    Ok(crate::mesh::stats(&read_mesh(&current(id))?))
}

/// Watches a conversation's output folder.
///
/// A script rarely writes its file in one go: so wait until the folder goes
/// quiet before reading, otherwise we would hit a mesh truncated mid-write.
pub fn watch_start(app: tauri::AppHandle, id: &str) -> Result<()> {
    if watchers().lock().unwrap().contains_key(id) {
        return Ok(());
    }
    let out = workspace(id).join("out");
    if !out.is_dir() {
        return Err(anyhow!("output folder not found"));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(hash_file(&current(id)).unwrap_or(0)));
    let token = next_token();
    watchers().lock().unwrap().insert(id.to_string(), Watcher { stop: stop.clone(), last: last.clone(), token });

    let id = id.to_string();
    std::thread::spawn(move || {
        watch_loop(&app, &id, &out, &stop, &last);
        // The possible successor carries another token: only touch our own.
        let mut m = watchers().lock().unwrap();
        if m.get(&id).map(|w| w.token) == Some(token) {
            m.remove(&id);
        }
    });
    Ok(())
}

/// What becomes of a stir in the output folder.
enum Change {
    /// New state archived: version number and measurements.
    Archived(u32, crate::mesh::Stats),
    /// Nothing new — often a write that changed nothing.
    Nothing,
    /// Unreadable file: probably a write in progress.
    TryAgain,
}

/// Decides the fate of a change, without emitting anything.
fn consider(id: &str, last: &Mutex<u64>) -> Change {
    let Some(h) = hash_file(&current(id)) else {
        return Change::Nothing;
    };
    if h == *last.lock().unwrap() {
        return Change::Nothing;
    }
    let Ok(stats) = current_stats(id) else {
        return Change::TryAgain;
    };
    *last.lock().unwrap() = h;
    match capture(id) {
        Ok(v) => {
            // Renders after archiving: Claude will find them up to date as soon as it
            // wants to look at what it just did.
            let _ = write_previews(id);
            Change::Archived(v, stats)
        }
        Err(_) => Change::Nothing,
    }
}

fn watch_loop(app: &tauri::AppHandle, id: &str, out: &Path, stop: &AtomicBool, last: &Mutex<u64>) {
    {
        use notify::{RecursiveMode, Watcher as _};
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut w) = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) else {
            return;
        };
        if w.watch(out, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        let quiet = std::time::Duration::from_millis(300);
        let mut pending: Option<std::time::Instant> = None;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(_) => pending = Some(std::time::Instant::now()),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            let Some(t) = pending else { continue };
            if t.elapsed() < quiet {
                continue;
            }
            pending = None;

            let (version, stats) = match consider(id, last) {
                Change::Archived(v, s) => {
                    crate::chat::note(id, serde_json::json!({ "type": "version", "n": v }));
                    (v, s)
                }
                Change::Nothing => continue,
                // An unreadable mesh often means a write in progress: let it go, the next
                // stir will catch it.
                Change::TryAgain => {
                    pending = Some(std::time::Instant::now());
                    continue;
                }
            };
            let _ = app.emit("ia-mesh", MeshEvent { id: id.to_string(), version, stats });
        }
    }
}

pub fn watch_stop(id: &str) {
    if let Some(w) = watchers().lock().unwrap().remove(id) {
        w.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod watch_tests {
    use notify::{RecursiveMode, Watcher as _};
    use std::time::{Duration, Instant};

    /// Measures the real delay between a write and its notification.
    ///
    /// On macOS the watch goes through FSEvents, which batches events: if this
    /// delay went beyond a second, "the object changes before your eyes" would
    /// become "the object changes, some day".
    #[test]
    fn the_file_system_reports_quickly() {
        let dir = std::env::temp_dir().join("snapstudio-watch-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let mut w = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .unwrap();
        w.watch(&dir, RecursiveMode::NonRecursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        let t0 = Instant::now();
        std::fs::write(dir.join("current.stl"), b"peu importe").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5));
        let delay = t0.elapsed();
        assert!(got.is_ok(), "no event received within 5 s");
        println!("event received in {} ms", delay.as_millis());
        assert!(delay < Duration::from_secs(2), "trop lent : {} ms", delay.as_millis());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn the_session_path_matches_claudes_naming() {
        let id = "b703e739-e760-4642-89a6-881a754d420c";
        let p = session_file(id);
        let dir = p.parent().unwrap().file_name().unwrap().to_string_lossy();
        assert!(dir.starts_with('-'), "the absolute path starts with a dash");
        assert!(dir.contains("-config-snap-studio-ia-"), "obtenu : {dir}");
        assert!(dir.ends_with("-workspace"), "obtenu : {dir}");
        assert!(dir.contains(id), "the id shows as is");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), format!("{id}.jsonl"));
    }

    /// A conversation opened then closed without a word leaves no session: that
    /// is exactly the case that made resuming fail.
    #[test]
    fn no_exchange_means_nothing_to_resume() {
        assert!(!has_session("00000000-0000-4000-8000-000000000000"));
    }
}

#[cfg(test)]
mod sortie_tests {
    use super::*;

    fn cube_3mf(dst: &Path) {
        crate::write3mf::write_scene(
            dst,
            &[SceneObject { name: "cube".into(), tris: crate::stl::tests_cube(), transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
    }

    #[test]
    fn saving_lands_next_to_the_source_without_overwriting() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-sortie");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("support.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        let first = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&first).file_name().unwrap(), "support-ai.3mf", "the object goes back next to its own");
        assert_eq!(get(&c.id).unwrap().saved.as_deref(), Some(first.as_str()));
        assert_eq!(mesh_of_3mf(Path::new(&first)).unwrap().tris.len(), 12);

        // The same version again: the file already written, no copy.
        assert_eq!(save_to_files(&c.id).unwrap(), first);
        assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 2, "source and one copy");

        // Another version must not overwrite the first.
        let mut c2 = get(&c.id).unwrap();
        c2.version = 2;
        save(&c2).unwrap();
        let second = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&second).file_name().unwrap(), "support-ai-2.3mf");
        assert!(Path::new(&first).is_file(), "the first is still there");
        let saved = get(&c.id).unwrap().saved_versions;
        assert_eq!(saved.get(&1), Some(&first));
        assert_eq!(saved.get(&2), Some(&second));

        // The file of a version removed from the Finder: written again.
        std::fs::remove_file(&second).unwrap();
        let again = save_to_files(&c.id).unwrap();
        assert!(Path::new(&again).is_file());

        remove(&c.id).unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn previews_are_written_and_refreshed() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-preview");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("cube.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        for (name, _) in VIEWS {
            let p = previews_dir(&c.id).join(format!("{name}.png"));
            assert!(p.is_file(), "{name}.png missing");
            assert!(std::fs::metadata(&p).unwrap().len() > 500);
        }

        // A conversation from before the previews finds them when opened.
        std::fs::remove_dir_all(previews_dir(&c.id)).unwrap();
        std::fs::write(workspace(&c.id).join("CLAUDE.md"), "old instructions").unwrap();
        refresh_workspace(&c.id);
        assert!(previews_dir(&c.id).join("top.png").is_file());
        let md = std::fs::read_to_string(workspace(&c.id).join("CLAUDE.md")).unwrap();
        assert!(md.contains("preview/"), "the instructions were brought up to date");
        assert!(md.contains("12 triangles"), "count read from the STL header");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
