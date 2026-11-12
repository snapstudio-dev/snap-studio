mod access;
mod analytics;
mod auth;
mod bedmesh;
mod chat;
mod claude_pty;
mod control;
mod discover;
mod engine;
mod favorites;
mod gcode;
mod gcode_thumbs;
mod i18n;
mod ia;
mod ia_attach;
mod jobs;
mod library;
mod maintenance;
mod menu;
mod mesh;
mod migrate;
mod mixcolor;
mod model3mf;
mod orient;
mod paint;
mod plate;
mod presets;
mod printer_files;
mod printers;
mod privacy;
mod pty;
mod render;
mod scan;
mod setup;
mod share;
// Simulated printers: development builds only (docs/DEVELOPMENT.md).
#[cfg(feature = "sim")]
pub mod sim;
mod slice;
mod slicers;
mod snappy;
mod snappy_eyes;
mod snappy_mcp;
mod snappy_tools;
mod stl;
mod support_hint;
mod thumbs;
mod titlebar;
mod update;
mod util;
mod watch;
mod write3mf;

use model3mf::ThumbPref;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::http::{Request, Response};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use util::ui_err;

// ---------------------------------------------------------------- DTO

#[derive(Serialize)]
pub struct FileDto {
    path: String,
    name: String,
    /// "3mf" or "gcode"
    kind: String,
    /// Subfolder relative to the scanned folder ("" at the root).
    rel: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
pub struct FilamentDto {
    kind: String,
    color: Option<String>,
    used_g: Option<f32>,
    used_m: Option<f32>,
}

#[derive(Serialize)]
pub struct MetaDto {
    path: String,
    title: Option<String>,
    designer: Option<String>,
    license: Option<String>,
    description: Option<String>,
    application: Option<String>,
    creation_date: Option<String>,
    objects: Vec<String>,
    print_time_s: Option<u32>,
    weight_g: Option<f32>,
    filaments: Vec<FilamentDto>,
    plates: usize,
    printer: Option<String>,
    has_embedded_thumb: bool,
    /// STL only: the mesh's size in file units, for a unit hint (an STL has
    /// no unit; millimeters are expected).
    size_mm: Option<[f32; 3]>,
}

#[derive(Serialize)]
pub struct AnalyzeDto {
    size_mm: [f32; 3],
    triangles: usize,
    approximated: bool,
}

#[derive(Serialize)]
pub struct PlaceDto {
    label: String,
    path: String,
}

#[derive(Serialize)]
pub struct CacheDto {
    bytes: u64,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

/// Runs blocking work (disk, conversion) off the main thread, where
/// synchronous commands run: the UI does not freeze meanwhile.
async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(ui_err)?
}

/// Off the main thread: a macOS permission prompt or a big folder does not
/// freeze the UI.
#[tauri::command]
async fn scan_folder(dir: String, recursive: bool) -> Result<Vec<FileDto>, String> {
    off_main(move || scan_folder_sync(&dir, recursive)).await
}

fn scan_folder_sync(dir: &str, recursive: bool) -> Result<Vec<FileDto>, String> {
    let root = PathBuf::from(dir);
    access::ensure_dir(&root);
    if !root.is_dir() {
        return Err(t!("err.no_folder", path = dir));
    }
    Ok(scan::scan_dir(&root, recursive)
        .into_iter()
        .map(|f| {
            let rel = f.path.parent().and_then(|p| p.strip_prefix(&root).ok()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            FileDto {
                path: f.path.to_string_lossy().to_string(),
                name: f.name,
                kind: f.kind.to_string(),
                rel,
                size: f.size,
                modified: f.modified.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            }
        })
        .collect())
}

fn meta_of(path: &str) -> MetaDto {
    access::ensure_file(Path::new(path));
    let mut dto = MetaDto {
        path: path.to_string(),
        title: None,
        designer: None,
        license: None,
        description: None,
        application: None,
        creation_date: None,
        objects: Vec::new(),
        print_time_s: None,
        weight_g: None,
        filaments: Vec::new(),
        plates: 0,
        printer: None,
        has_embedded_thumb: false,
        size_mm: None,
    };
    if scan::kind_of(Path::new(path)) == Some("stl") {
        // Triangles only: no name, settings or plates.
        dto.plates = 1;
        dto.size_mm = stl::size(Path::new(path)).ok();
        return dto;
    }
    if scan::kind_of(Path::new(path)) == Some("gcode") {
        if let Ok(f) = std::fs::File::open(path) {
            if let Ok(g) = gcode::parse(f) {
                dto.title = None;
                dto.application = g.meta.generator.or(g.meta.profile);
                dto.printer = g.meta.printer;
                dto.print_time_s = g.meta.print_time_s;
                dto.weight_g = g.meta.filament_g;
                dto.plates = 1;
                dto.has_embedded_thumb = true;
                dto.filaments =
                    g.meta.filaments.into_iter().map(|k| FilamentDto { kind: k, color: None, used_g: None, used_m: None }).collect();
            }
        }
        return dto;
    }

    if let Ok(mut zip) = model3mf::open(Path::new(path)) {
        let m = model3mf::read_meta(&mut zip);
        dto.title = m.title;
        dto.designer = m.designer;
        dto.license = m.license;
        dto.description = m.description;
        dto.application = m.application;
        dto.creation_date = m.creation_date;
        dto.objects = m.object_names;
        dto.print_time_s = m.print_time_s;
        dto.weight_g = m.weight_g;
        dto.plates = m.plates;
        dto.printer = m.printer;
        dto.has_embedded_thumb = m.has_embedded_thumb;
        dto.filaments = m
            .filaments
            .into_iter()
            .map(|f| FilamentDto {
                kind: f.kind,
                color: f.color.map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])),
                used_g: f.used_g,
                used_m: f.used_m,
            })
            .collect();
    }
    dto
}

/// Metadata of a batch of files, read in parallel. Off the async runtime:
/// a large folder would otherwise hold one of its workers for the whole
/// batch, with the status polls and the send progress behind it.
#[tauri::command]
async fn read_metas(paths: Vec<String>) -> Vec<MetaDto> {
    tauri::async_runtime::spawn_blocking(move || {
        let workers = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4);
        let chunk = paths.len().div_ceil(workers).max(1);
        let mut out: Vec<MetaDto> = Vec::with_capacity(paths.len());
        std::thread::scope(|s| {
            let mut handles = Vec::new();
            for part in paths.chunks(chunk) {
                handles.push(s.spawn(move || part.iter().map(|p| meta_of(p)).collect::<Vec<_>>()));
            }
            for h in handles {
                if let Ok(v) = h.join() {
                    out.extend(v);
                }
            }
        });
        out
    })
    .await
    .unwrap_or_default()
}

/// On-demand geometry analysis: real bounding box and triangle count.
#[tauri::command]
async fn analyze(path: String) -> Result<AnalyzeDto, String> {
    if scan::kind_of(Path::new(&path)) == Some("stl") {
        let m = stl::read(Path::new(&path)).map_err(ui_err)?;
        return Ok(AnalyzeDto { size_mm: m.size(), triangles: m.tris.len(), approximated: false });
    }
    let mut zip = model3mf::open(Path::new(&path)).map_err(ui_err)?;
    let m = mesh::load_mesh(&mut zip, 2_500_000).map_err(ui_err)?;
    Ok(AnalyzeDto { size_mm: m.size(), triangles: m.tris.len(), approximated: m.truncated })
}

#[tauri::command]
async fn trash_files(paths: Vec<String>) -> Result<usize, String> {
    off_main(move || {
        trash::delete_all(&paths).map_err(ui_err)?;
        Ok(paths.len())
    })
    .await
}

#[tauri::command]
fn reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(PathBuf::from(path)).map_err(ui_err)
}

#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(ui_err)
}

// ---------------------------------------------------------------- library

#[tauri::command]
fn lib_sites() -> Vec<library::Site> {
    library::sites()
}

/// The floating navigation's buttons: on the tab shown.
#[tauri::command]
fn lib_nav(app: tauri::AppHandle, what: String) -> Result<(), String> {
    library::nav_command(&app, &what).map_err(ui_err)
}

/// The pinned camera over a site: where the interface's pinned window is
/// and its page's settings (printer, name, texts), or None when it is not
/// shown. Async: a web view is created off the main thread (see lib_open).
#[tauri::command]
async fn cam_view_set(app: tauri::AppHandle, rect: Option<library::Rect>, setup: String) {
    library::CAM.set(&app, rect, setup);
}

/// Snappy's conversation over a site (library.rs): where the card is, or
/// None, and the page's settings (language, the context its messages
/// carry).
#[tauri::command]
async fn snappy_view_set(app: tauri::AppHandle, rect: Option<library::Rect>, setup: String) {
    library::SNAPPY.set(&app, rect, setup);
}

/// The buttons of Snappy's view over a site (close, widen, sign in):
/// passed on to the interface, which owns the card.
#[tauri::command]
fn snappy_view_action(app: tauri::AppHandle, action: serde_json::Value) {
    use tauri::Emitter;
    let _ = app.emit("snappy-view-action", action);
}

/// The camera view's buttons (open the printer, unpin, close): passed on
/// to the interface, which owns the camera.
#[tauri::command]
fn cam_view_action(app: tauri::AppHandle, what: String) {
    use tauri::Emitter;
    let _ = app.emit("cam-view-action", what);
}

/// A site's icon, as a data URL (None: not found).
#[tauri::command]
async fn lib_favicon(id: String) -> Option<String> {
    library::favicon(&id).await
}

/// Async on purpose: a sync command runs on the main thread, and creating a
/// web view from there deadlocks WebView2 on Windows (the app froze when the
/// Library opened and restored its tabs). An async command runs off the main
/// thread; the creation is dispatched to it.
#[tauri::command]
async fn lib_open(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    library::open_tab(&app, &id, &url).map_err(ui_err)
}

#[tauri::command]
fn lib_close(app: tauri::AppHandle, id: String) {
    library::close_tab(&app, &id);
}

/// Shows a tab; without an id, hides all views — which is done before
/// opening a dialog or the viewer.
#[tauri::command]
fn lib_show(app: tauri::AppHandle, id: Option<String>) {
    library::show_only(&app, id.as_deref());
}

#[tauri::command]
fn lib_rect(app: tauri::AppHandle, rect: library::Rect, viewport: f64, visible: Option<String>) {
    library::set_rect(&app, rect, viewport, visible.as_deref());
}

#[tauri::command]
fn lib_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    library::navigate(&app, &id, &url).map_err(ui_err)
}

#[tauri::command]
fn lib_command(app: tauri::AppHandle, id: String, what: String) -> Result<(), String> {
    library::command(&app, &id, &what).map_err(ui_err)
}

/// Logs a site out: its cookies only, not the others'.
#[tauri::command]
async fn lib_logout(app: tauri::AppHandle, id: String, site: String) -> Result<usize, String> {
    library::logout(&app, &id, &site).map_err(ui_err)
}

/// The address of the page a tab shows (not of its frames).
#[tauri::command]
fn lib_url(app: tauri::AppHandle, id: String) -> Option<String> {
    library::page_url(&app, &id)
}

// ---------------------------------------------------------------- favorites

#[tauri::command]
fn fav_list() -> Vec<favorites::Favorite> {
    favorites::list()
}

/// Saves the page shown as a favorite; `title` is the tab's.
#[tauri::command]
fn fav_add(url: String, title: Option<String>) -> Result<Vec<favorites::Favorite>, String> {
    favorites::add(&url, title.as_deref()).map_err(ui_err)
}

#[tauri::command]
fn fav_remove(id: String) -> Result<Vec<favorites::Favorite>, String> {
    favorites::remove(&id).map_err(ui_err)
}

// ---------------------------------------------------------------- slicing

/// Bundled slicing engine: version, installed or not, sizes.
#[tauri::command]
fn engine_status() -> engine::Status {
    engine::status()
}

/// Downloads and installs the engine; progress through `engine-progress`.
#[tauri::command]
async fn engine_install(app: tauri::AppHandle) -> Result<engine::Status, String> {
    engine::install(app).await.map_err(ui_err)
}

#[tauri::command]
fn engine_cancel() {
    engine::cancel();
}

#[tauri::command]
fn engine_remove() -> Result<engine::Status, String> {
    engine::remove().map_err(ui_err)
}

/// Effective content of a preset, for the details sheet.
#[tauri::command]
async fn slice_details(
    name: String,
    machine: String,
    simple: Option<slice::Simple>,
    overrides: Option<serde_json::Map<String, serde_json::Value>>,
    color: Option<String>,
) -> Result<presets::Details, String> {
    tauri::async_runtime::spawn_blocking(move || slice::details(&name, &machine, simple, &overrides.unwrap_or_default(), color.as_deref()))
        .await
        .map_err(ui_err)?
        .map_err(ui_err)
}

/// Saves the effective process settings as a user process preset.
#[tauri::command]
async fn slice_save_process(
    name: String,
    base: String,
    simple: Option<slice::Simple>,
    overrides: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || slice::save_process(&name, &base, simple, &overrides.unwrap_or_default()))
        .await
        .map_err(ui_err)?
        .map_err(ui_err)
}

/// Presets that can be offered for the chosen machine.
#[tauri::command]
async fn slice_lists(machine: Option<String>) -> Result<slice::PresetLists, String> {
    slice::lists(machine.as_deref()).map_err(ui_err)
}

/// Starting values of the simplified settings for a given preset.
#[tauri::command]
async fn slice_defaults(_machine: String, process: String) -> Result<slice::Simple, String> {
    // `machine` is still sent by the sheet; a process's quick settings do
    // not depend on it.
    slice::defaults(&process).map_err(ui_err)
}

/// Starts a background slice; progress arrives through the `slice-progress`
/// event.
#[tauri::command]
fn slice_start(app: tauri::AppHandle, request: slice::Request) -> Result<String, String> {
    slice::start(app, request).map_err(ui_err)
}

/// Saves a slice's preview; returns the path of the G-code written.
#[tauri::command]
async fn slice_save(id: String, dir: Option<String>) -> Result<String, String> {
    off_main(move || slice::save(&id, dir.as_deref()).map(|p| p.to_string_lossy().to_string()).map_err(ui_err)).await
}

/// Discards a slice's preview.
#[tauri::command]
fn slice_discard(id: String) {
    slice::discard(&id);
}

/// A file's objects, to put on the Prepare view's plate.
#[tauri::command]
async fn plate_items(path: String) -> Result<Vec<plate::PlateItem>, String> {
    tauri::async_runtime::spawn_blocking(move || plate::items(Path::new(&path))).await.map_err(ui_err)?.map_err(ui_err)
}

/// Convex hull of a plate object, or of a piece of it (own frame).
#[tauri::command]
async fn plate_hull(path: String, item: usize, piece: Option<usize>) -> Result<orient::Hull, String> {
    tauri::async_runtime::spawn_blocking(move || plate::hull(Path::new(&path), item, piece)).await.map_err(ui_err)?.map_err(ui_err)
}

/// The pieces of a plate object, to split it into several (Orca's "Split
/// to objects").
#[tauri::command]
async fn plate_pieces(path: String, item: usize, piece: Option<usize>) -> Result<Vec<plate::Piece>, String> {
    tauri::async_runtime::spawn_blocking(move || plate::pieces(Path::new(&path), item, piece)).await.map_err(ui_err)?.map_err(ui_err)
}

/// Auto-orientation (Orca's rules): one rotation per object.
#[tauri::command]
async fn plate_orient(items: Vec<plate::OrientItem>, process: Option<String>) -> Result<Vec<[[f64; 3]; 3]>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threshold = slice::support_threshold(process.as_deref());
        items.iter().map(|it| plate::orient(it, threshold)).collect::<anyhow::Result<Vec<_>>>()
    })
    .await
    .map_err(ui_err)?
    .map_err(ui_err)
}

/// Whether each object probably needs supports, as placed
/// (`support_hint.rs`), with the overhang angle used: the advanced
/// settings' `threshold` if given, the print profile's otherwise.
#[tauri::command]
async fn plate_support_hint(
    items: Vec<plate::HintItem>,
    process: Option<String>,
    threshold: Option<f64>,
) -> Result<support_hint::Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threshold = threshold.filter(|a| *a > 0.0 && *a < 90.0).unwrap_or_else(|| slice::support_threshold(process.as_deref()));
        // An object that cannot be read gets no hint; the others still do.
        let items = items
            .iter()
            .map(|it| plate::support_hint(it, threshold).map_err(|e| eprintln!("[support hint] {}: {e:#}", it.path)).ok())
            .collect();
        support_hint::Report { threshold, items }
    })
    .await
    .map_err(ui_err)
}

/// Saves the plate as 3MF.
#[tauri::command]
async fn plate_save(
    scene: Vec<plate::SceneItem>,
    tower: Option<plate::TowerPlace>,
    smooth_mix: Option<bool>,
    snap: Option<serde_json::Value>,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || plate::save_scene(&scene, tower, smooth_mix, snap.as_ref(), Path::new(&path)))
        .await
        .map_err(ui_err)?
        .map_err(ui_err)
}

/// A virtual head's preview color: `a` and `b` (`#rrggbb`) mixed at each
/// share of `b`, as Snapmaker Orca shows its mixed filaments.
#[tauri::command]
fn mix_colors(a: String, b: String, shares: Vec<f32>) -> Result<Vec<String>, String> {
    mixcolor::mix_hex(&a, &b, &shares).ok_or_else(|| "unreadable color".to_string())
}

/// The prime tower a 3MF keeps (its first plate's), if any.
#[tauri::command]
async fn plate_tower(path: String) -> Result<Option<plate::FileTower>, String> {
    tauri::async_runtime::spawn_blocking(move || plate::tower_of(Path::new(&path))).await.map_err(ui_err)
}

/// The machine's bed (preset): dimensions and printer model.
#[tauri::command]
async fn plate_bed(machine: Option<String>) -> Result<slice::Bed, String> {
    tauri::async_runtime::spawn_blocking(move || slice::bed(machine.as_deref())).await.map_err(ui_err)
}

/// Filaments declared by a model, to associate them with heads.
#[tauri::command]
async fn slice_model(path: String) -> Result<slice::ModelInfo, String> {
    tauri::async_runtime::spawn_blocking(move || slice::model_info(Path::new(&path))).await.map_err(ui_err)?.map_err(ui_err)
}

#[derive(serde::Deserialize)]
struct SendRequest {
    printer_id: String,
    /// Id of the slice preview to send.
    job: String,
    /// Heads that extrude, according to the G-code.
    tools: Vec<u8>,
    options: printers::StartOptions,
    /// Slicing profiles, kept on the print's record.
    #[serde(default)]
    profile: jobs::Profile,
    /// True: queue instead of starting.
    #[serde(default)]
    queue: bool,
    /// Substitutes chosen at the spool check: (G-code tool, head).
    #[serde(default)]
    map: Vec<(u8, u8)>,
}

#[derive(Serialize, Clone)]
struct SendProgress {
    /// check | prepare | upload | done | error
    phase: &'static str,
    percent: Option<f32>,
    message: Option<String>,
}

fn send_progress(app: &tauri::AppHandle, phase: &'static str, percent: Option<f32>, message: Option<String>) {
    use tauri::Emitter;
    let _ = app.emit("print-send", SendProgress { phase, percent, message });
}

/// Starts a G-code on an idle printer.
///
/// Same run as Snapmaker Orca: checks and head mapping, upload without
/// launch, then a start carrying the options (`start_printing`). Returns an
/// error message for the options the printer did not apply.
async fn launch(
    app: &tauri::AppHandle,
    p: &printers::Printer,
    gcode: &Path,
    name: &str,
    options: &printers::StartOptions,
    tools: &[u8],
    map: &[(u8, u8)],
) -> Result<Option<String>, String> {
    prepare_printer(app, p, options, tools, map).await?;
    let handle = app.clone();
    printers::upload(&p.host, p.port, gcode, name, false, move |sent, total| {
        let pct = if total > 0 { sent as f32 * 100.0 / total as f32 } else { 0.0 };
        send_progress(&handle, "upload", Some(pct), None);
    })
    .await
    .map_err(ui_err)?;
    start_printing(p, name, options, tools, map).await
}

/// Before a print starts, whatever its G-code comes from: the printer is
/// idle, every head used has a spool, the heads are mapped. The options go
/// with the start itself (`start_printing`).
async fn prepare_printer(
    app: &tauri::AppHandle,
    p: &printers::Printer,
    options: &printers::StartOptions,
    tools: &[u8],
    map: &[(u8, u8)],
) -> Result<(), String> {
    printers::check_map(tools, map).map_err(ui_err)?;
    send_progress(app, "check", None, None);
    let st = printers::status(&p.host, p.port).await;
    if !st.online {
        return Err(t!("err.printer_silent", name = p.name));
    }
    if matches!(st.state.as_str(), "printing" | "paused") {
        return Err(t!("err.printer_busy", name = p.name));
    }
    // A head used without a spool: refused, even for a job queued before it
    // was emptied.
    // Physical heads, after substitution.
    let empty: Vec<String> = tools
        .iter()
        .map(|t| printers::head_of(*t, map))
        .filter(|h| st.filaments.iter().any(|f| f.index == *h && !f.present))
        .map(|h| format!("T{h}"))
        .collect();
    if !empty.is_empty() {
        return Err(t!("err.head_empty", name = p.name, heads = empty.join(", ")));
    }

    send_progress(app, "prepare", None, None);
    let script = printers::map_script(tools, map);
    if !script.is_empty() {
        printers::gcode_script_checked(&p.host, p.port, &script).await.map_err(|e| t!("err.prepare_refused", err = e))?;
    }
    // As Snapmaker Orca, for a firmware that knows it; the options of the
    // start request are what count.
    if let Err(e) = printers::gcode_script(&p.host, p.port, &printers::preference_script(options)).await {
        eprintln!("[print] SET_PRINT_PREFERENCE: {e}");
    }
    Ok(())
}

/// Starts a file of `gcodes` with its options, then reads back what the
/// printer applied: the options it ignored come back as an error message
/// (the print has started all the same).
async fn start_printing(
    p: &printers::Printer,
    path: &str,
    options: &printers::StartOptions,
    tools: &[u8],
    map: &[(u8, u8)],
) -> Result<Option<String>, String> {
    let route = printers::start_print(&p.host, p.port, path, options, tools, map).await.map_err(|e| t!("err.start_refused", err = e))?;
    eprintln!("[print] {path} started ({route:?})");
    let Some(cfg) = printers::task_config(&p.host, p.port).await else { return Ok(None) };
    let missing: Vec<String> = printers::unapplied_options(&cfg, options).iter().map(|k| t!(*k)).collect();
    Ok((!missing.is_empty()).then(|| t!("err.options_unapplied", opts = missing.join(", "))))
}

// ---------------------------------------------------------------- printer files

fn served_root(root: &str) -> Result<(), String> {
    if printer_files::served_root(root) {
        Ok(())
    } else {
        Err("invalid path".into())
    }
}

/// The file a printer is busy with, if any.
async fn printing_file(p: &printers::Printer) -> Option<String> {
    let st = printers::status(&p.host, p.port).await;
    printer_files::printing_path(&st.state, st.job.as_deref())
}

/// A printer's print files and timelapses. Unreachable: an error, the
/// view offers to try again.
#[tauri::command]
async fn pf_overview(printer_id: String) -> Result<printer_files::Overview, String> {
    let p = printer_by_id(&printer_id)?;
    let st = printers::status(&p.host, p.port).await;
    if !st.online {
        return Err(t!("err.printer_silent", name = p.name));
    }
    let printing = printer_files::printing_path(&st.state, st.job.as_deref());
    printer_files::overview(&p.host, p.port, printing).await.map_err(ui_err)
}

/// Tools a print file on a printer uses, read from the G-code when the
/// metadata does not say.
#[tauri::command]
async fn pf_tools(printer_id: String, path: String, modified: f64) -> Result<Vec<u8>, String> {
    let p = printer_by_id(&printer_id)?;
    printer_files::tools(&p.host, p.port, &path, modified).await.map_err(ui_err)
}

/// The build plate a print file on a printer was sliced for, if it says.
#[tauri::command]
async fn pf_plate(printer_id: String, path: String, modified: f64) -> Result<Option<String>, String> {
    let p = printer_by_id(&printer_id)?;
    printer_files::plate(&p.host, p.port, &path, modified).await.map_err(ui_err)
}

/// A printer's timelapse videos, for the Prints record.
#[tauri::command]
async fn pf_videos(printer_id: String) -> Result<Vec<printer_files::RemoteFile>, String> {
    let p = printer_by_id(&printer_id)?;
    printer_files::videos(&p.host, p.port).await.map_err(ui_err)
}

/// Number of print files on a printer, for the sidebar.
#[tauri::command]
async fn pf_count(printer_id: String) -> Result<usize, String> {
    let p = printer_by_id(&printer_id)?;
    printer_files::count(&p.host, p.port).await.map_err(ui_err)
}

#[tauri::command]
async fn pf_video_duration(printer_id: String, root: String, path: String, modified: f64) -> Result<Option<f64>, String> {
    served_root(&root)?;
    let p = printer_by_id(&printer_id)?;
    printer_files::video_duration(&p.host, p.port, &root, &path, modified).await.map_err(ui_err)
}

/// Deletes files of one root; each one's error, if any, in order.
#[tauri::command]
async fn pf_delete(printer_id: String, root: String, paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    served_root(&root)?;
    let p = printer_by_id(&printer_id)?;
    let printing = printing_file(&p).await;
    let mut out = Vec::new();
    for path in &paths {
        let r = match printer_files::check_change(&root, path, printing.as_deref()) {
            Ok(()) if root == "gcodes" => printer_files::delete_retrying(&p.host, p.port, &root, path).await.map_err(ui_err),
            // Timelapses: also through the camera service when Moonraker
            // only lists them (a U1's read-only `camera` folder).
            Ok(()) => printer_files::delete_video(&p.host, p.port, &root, path).await.map_err(ui_err),
            Err(e) => Err(ui_err(e)),
        };
        out.push(r.err());
    }
    Ok(out)
}

#[tauri::command]
async fn pf_rename(printer_id: String, path: String, name: String) -> Result<String, String> {
    let p = printer_by_id(&printer_id)?;
    let printing = printing_file(&p).await;
    printer_files::check_change("gcodes", &path, printing.as_deref()).map_err(ui_err)?;
    printer_files::rename(&p.host, p.port, &path, &name).await.map_err(ui_err)
}

/// Downloads files into a folder: the Files folder for print files, the
/// Downloads folder for videos unless another is given. Returns the files
/// written; stops at the first failure.
#[tauri::command]
async fn pf_download(printer_id: String, root: String, paths: Vec<String>, dir: Option<String>) -> Result<Vec<String>, String> {
    served_root(&root)?;
    let p = printer_by_id(&printer_id)?;
    let dir = dir.map(PathBuf::from).or_else(dirs::download_dir).ok_or_else(|| t!("pfiles.err.no_folder"))?;
    if !dir.is_dir() {
        return Err(t!("pfiles.err.no_folder"));
    }
    let mut out = Vec::new();
    for path in &paths {
        let f = printer_files::download(&p.host, p.port, &root, path, &dir).await.map_err(ui_err)?;
        out.push(f.to_string_lossy().to_string());
    }
    Ok(out)
}

#[derive(serde::Deserialize)]
struct PfPrintRequest {
    /// Printer the file is on.
    source_id: String,
    path: String,
    /// Printer that prints it (the same one, or another).
    printer_id: String,
    options: printers::StartOptions,
    #[serde(default)]
    tools: Vec<u8>,
    #[serde(default)]
    map: Vec<(u8, u8)>,
    /// True: queue instead of starting.
    #[serde(default)]
    queue: bool,
}

/// Prints a file that is on a printer, as the send sheet does after a slice.
/// Started at once on that same printer: same checks and preparation as a
/// sent print, then the printer starts its own copy (nothing is uploaded).
/// Queued, or for another printer: the G-code is copied from the printer and
/// becomes an ordinary job (queued, or sent and started). Returns the job's
/// id, if one was made.
#[tauri::command]
async fn pf_print(app: tauri::AppHandle, request: PfPrintRequest) -> Result<Option<String>, String> {
    let p = printer_by_id(&request.printer_id)?;
    let mut tools = if request.tools.is_empty() { vec![0] } else { request.tools.clone() };
    // Started in place only without a substitution: a substituted print
    // needs its record (the extruder map goes back to identity when it
    // ends), so it goes the copy's way, as any sent print.
    if !request.queue && request.source_id == request.printer_id && !printers::is_remap(&request.map) {
        prepare_printer(&app, &p, &request.options, &tools, &request.map).await?;
        let warning = start_printing(&p, &request.path, &request.options, &tools, &request.map).await?;
        send_progress(&app, "done", Some(100.0), warning);
        return Ok(None);
    }
    let src = printer_by_id(&request.source_id)?;
    send_progress(&app, "fetch", None, None);
    let tmp = std::env::temp_dir().join("snapstudio-pfiles").join(printers::new_id());
    std::fs::create_dir_all(&tmp).map_err(ui_err)?;
    let result = async {
        let gcode = printer_files::download(&src.host, src.port, "gcodes", &request.path, &tmp)
            .await
            .map_err(|e| t!("pfiles.err.fetch", err = e))?;
        // The copy is here: its own tools, rather than the metadata's.
        let g = gcode.clone();
        if let Some(t) = tauri::async_runtime::spawn_blocking(move || printer_files::gcode_tools(&g)).await.ok().flatten() {
            tools = t;
        }
        let id = printers::new_id();
        let stem = printer_files::display_name(&request.path);
        let remote = jobs::remote_name(&stem, &id);
        let new = jobs::NewJob {
            id: Some(id),
            stats: None,
            name: stem,
            printer_id: p.id.clone(),
            options: request.options.clone(),
            tools: tools.clone(),
            profile: jobs::Profile::default(),
            source: None,
        };
        let add = |gcode: PathBuf, new: jobs::NewJob, state: &'static str, remote: String| {
            tauri::async_runtime::spawn_blocking(move || jobs::add(&gcode, new, state, &remote))
        };
        if request.queue {
            let job = add(gcode, new, "queued", String::new()).await.map_err(ui_err)?.map_err(ui_err)?;
            emit_jobs(&app);
            return Ok(Some(job.id));
        }
        let warning = launch(&app, &p, &gcode, &remote, &request.options, &tools, &request.map).await?;
        let id = match add(gcode, new, "printing", remote).await.map_err(|e| anyhow::anyhow!("{e}")).and_then(|r| r) {
            Ok(job) => {
                if printers::is_remap(&request.map) {
                    if let Err(e) = jobs::mark_remapped(&job.id) {
                        eprintln!("[jobs] substitution not recorded: {e}");
                    }
                }
                Some(job.id)
            }
            Err(e) => {
                eprintln!("[jobs] record not saved: {e}");
                None
            }
        };
        emit_jobs(&app);
        send_progress(&app, "done", Some(100.0), warning);
        Ok(id)
    }
    .await;
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

// ---------------------------------------------------------------- share

/// The local copy of a printer file, to share it; fetched once per version.
#[tauri::command]
async fn share_fetch(printer_id: String, root: String, path: String, modified: f64) -> Result<String, String> {
    served_root(&root)?;
    let p = printer_by_id(&printer_id)?;
    share::fetch(&p.host, p.port, &root, &path, modified)
        .await
        .map(|f| f.to_string_lossy().into_owned())
        .map_err(|e| t!("pfiles.err.fetch", err = e))
}

#[tauri::command]
fn share_caps() -> share::Caps {
    share::caps()
}

#[tauri::command]
fn share_copy(path: String) -> Result<(), String> {
    let p = share::cached(&path).map_err(ui_err)?;
    share::copy(&p).map_err(ui_err)
}

#[tauri::command]
async fn share_save(path: String, dest: String) -> Result<(), String> {
    off_main(move || {
        let p = share::cached(&path).map_err(ui_err)?;
        share::save(&p, Path::new(&dest)).map_err(ui_err)
    })
    .await
}

/// The system's share menu (AirDrop, Messages, Mail…) at (`x`, `y`) of the
/// window. macOS only.
#[tauri::command]
async fn share_native(app: tauri::AppHandle, path: String, x: f64, y: f64) -> Result<(), String> {
    let p = share::cached(&path).map_err(ui_err)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // The window, not the "webview window": once the Library has added
        // its own views to it, it is no longer one (get_webview_window: None).
        let w = app.get_window("main").ok_or("no window")?;
        let ns = w.ns_window().map_err(ui_err)? as usize;
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(share::native(ns, &p, x, y).map_err(ui_err));
        })
        .map_err(ui_err)?;
        return tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_else(|_| Err("no answer".into())))
            .await
            .map_err(ui_err)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, p, x, y);
        Err("not available on this system".into())
    }
}

/// Serves a shared file to the local network for a quarter of an hour:
/// its address and QR code. On the network that reaches the printer.
#[tauri::command]
fn share_qr_start(path: String, printer_id: String) -> Result<share::QrShare, String> {
    let p = share::cached(&path).map_err(ui_err)?;
    let printer = printer_by_id(&printer_id)?;
    share::qr_start(p, &printer.host).map_err(|e| t!("share.err.qr", err = e))
}

#[tauri::command]
fn share_qr_stop() {
    share::qr_stop();
}

/// Only the app's own page reads its protocols. Tauri attaches them to
/// every webview the app creates, the Library's tabs included, where a
/// third-party site could otherwise fetch `gcode://` or `thumb://` (the
/// answers allow any origin) and read local files.
fn own_webview<R: tauri::Runtime>(ctx: &tauri::UriSchemeContext<'_, R>) -> bool {
    ctx.webview_label() == "main"
}

fn refused() -> Response<Vec<u8>> {
    Response::builder().status(403).body(Vec::new()).unwrap()
}

/// `prn://localhost/f?id=<printer>&root=<root>&p=<path>`: a file of a
/// printer (thumbnail, timelapse picture, video by pieces).
async fn handle_prn(uri: String, range: Option<String>) -> Response<Vec<u8>> {
    let fail = |code: u16| Response::builder().status(code).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    let (Some(id), Some(root), Some(path)) = (query_param(&uri, "id"), query_param(&uri, "root"), query_param(&uri, "p")) else {
        return fail(400);
    };
    if !printer_files::served_root(&root) {
        return fail(403);
    }
    let Ok(p) = printer_by_id(&id) else {
        return fail(404);
    };
    match printer_files::proxy(&p.host, p.port, &root, &path, range.as_deref()).await {
        Ok(r) => {
            let mut b = Response::builder()
                .status(r.status)
                .header("Content-Type", r.mime)
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "no-store")
                .header("Access-Control-Allow-Origin", "*");
            if let Some(cr) = r.content_range {
                b = b.header("Content-Range", cr);
            }
            b.body(r.body).unwrap()
        }
        Err(_) => fail(502),
    }
}

/// Sends a slice's preview: immediate start, or queueing. Returns the id of
/// the job created.
#[tauri::command]
async fn print_send(app: tauri::AppHandle, request: SendRequest) -> Result<String, String> {
    let p = printer_by_id(&request.printer_id)?;
    let gcode = slice::preview_gcode(&request.job).ok_or_else(|| t!("err.no_preview"))?;
    let name = slice::preview_name(&request.job).unwrap_or_else(|| "snapstudio.gcode".into());
    let stem = name.trim_end_matches(".gcode").to_string();
    let id = printers::new_id();
    let remote = jobs::remote_name(&stem, &id);
    let new = jobs::NewJob {
        id: Some(id),
        stats: None,
        name: stem,
        printer_id: p.id.clone(),
        options: request.options,
        tools: request.tools.clone(),
        profile: request.profile,
        source: slice::preview_source(&request.job),
    };
    // G-code copy and parsing: off the async thread.
    let add = |gcode: PathBuf, new: jobs::NewJob, state: &'static str, remote: String| {
        tauri::async_runtime::spawn_blocking(move || jobs::add(&gcode, new, state, &remote))
    };
    if request.queue {
        let job = add(gcode, new, "queued", String::new()).await.map_err(ui_err)?.map_err(ui_err)?;
        emit_jobs(&app);
        return Ok(job.id);
    }
    let warning = launch(&app, &p, &gcode, &remote, &request.options, &request.tools, &request.map).await?;
    // The print's record keeps the G-code and its summary. The print has left:
    // a failure here must not make it look failed.
    let id = match add(gcode, new, "printing", remote).await.map_err(|e| anyhow::anyhow!("{e}")).and_then(|r| r) {
        Ok(job) => {
            if printers::is_remap(&request.map) {
                if let Err(e) = jobs::mark_remapped(&job.id) {
                    eprintln!("[jobs] substitution not recorded: {e}");
                }
            }
            job.id
        }
        Err(e) => {
            eprintln!("[jobs] record not saved: {e}");
            String::new()
        }
    };
    emit_jobs(&app);
    send_progress(&app, "done", Some(100.0), warning);
    Ok(id)
}

fn emit_jobs(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("jobs-changed", ());
}

/// Known prints: queue, running, history.
#[tauri::command]
fn jobs_list() -> Vec<jobs::JobView> {
    jobs::views()
}

/// Last printer state seen by the background tracking.
#[tauri::command]
fn prints_status() -> Vec<jobs::Live> {
    jobs::snapshot()
}

/// Starts a queued job (the user confirmed the bed is clear).
#[tauri::command]
async fn job_launch(app: tauri::AppHandle, id: String, map: Option<Vec<(u8, u8)>>) -> Result<(), String> {
    let job = jobs::get(&id).ok_or_else(|| t!("err.job_unknown"))?;
    if job.state != "queued" {
        return Err(t!("err.not_queued"));
    }
    let p = printer_by_id(&job.printer_id)?;
    // A name of its own for each job: two prints of the same model do not
    // overwrite each other on the printer.
    let remote = jobs::remote_name(&job.name, &job.id);
    let map = map.unwrap_or_default();
    let warning = launch(&app, &p, Path::new(&job.file), &remote, &job.options, &job.tools, &map).await?;
    if let Err(e) = jobs::mark_started(&id, &remote) {
        eprintln!("[jobs] launch not recorded: {e}");
    }
    if printers::is_remap(&map) {
        if let Err(e) = jobs::mark_remapped(&id) {
            eprintln!("[jobs] substitution not recorded: {e}");
        }
    }
    emit_jobs(&app);
    send_progress(&app, "done", Some(100.0), warning);
    Ok(())
}

#[tauri::command]
fn job_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    jobs::remove(&id).map_err(ui_err)?;
    emit_jobs(&app);
    Ok(())
}

#[tauri::command]
fn job_move(app: tauri::AppHandle, id: String, delta: i32) -> Result<(), String> {
    jobs::shift(&id, delta).map_err(ui_err)?;
    emit_jobs(&app);
    Ok(())
}

#[tauri::command]
fn job_edit(
    app: tauri::AppHandle,
    id: String,
    printer_id: Option<String>,
    options: Option<printers::StartOptions>,
) -> Result<jobs::Job, String> {
    let j = jobs::edit(&id, printer_id, options).map_err(ui_err)?;
    emit_jobs(&app);
    Ok(j)
}

#[tauri::command]
async fn job_requeue(app: tauri::AppHandle, id: String) -> Result<jobs::Job, String> {
    // G-code copy: off the main thread.
    let j = tauri::async_runtime::spawn_blocking(move || jobs::requeue(&id)).await.map_err(ui_err)?.map_err(ui_err)?;
    emit_jobs(&app);
    Ok(j)
}

/// The result of a finished print, set in its record (None clears it).
#[tauri::command]
fn job_set_result(id: String, result: Option<jobs::PrintResult>) -> Result<jobs::JobView, String> {
    jobs::set_result(&id, result).map(jobs::view).map_err(ui_err)
}

/// The timelapse matched to a finished print, kept with it.
#[tauri::command]
fn job_set_timelapse(id: String, root: String, path: String) -> Result<jobs::JobView, String> {
    served_root(&root)?;
    jobs::set_timelapse(&id, jobs::Timelapse { root, path }).map(jobs::view).map_err(ui_err)
}

/// Automatic deletion of the prints history, in days (None: never).
#[tauri::command]
fn jobs_retention() -> Option<u32> {
    jobs::retention()
}

#[tauri::command]
fn jobs_set_retention(app: tauri::AppHandle, days: Option<u32>) -> Result<(), String> {
    jobs::set_retention(days).map_err(ui_err)?;
    emit_jobs(&app);
    Ok(())
}

/// "Later": do not offer the next one again before the next print.
#[tauri::command]
fn queue_dismiss(printer_id: String) {
    jobs::dismiss(&printer_id);
}

/// Asks the question again for free printers with a queue (UI ready).
#[tauri::command]
fn queue_check(app: tauri::AppHandle) {
    jobs::ask_again(&app);
}

/// Pause, resume or cancel the running print.
#[tauri::command]
async fn print_action(printer_id: String, action: String) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    printers::print_action(&p.host, p.port, &action).await.map_err(ui_err)
}

fn printer_by_id(id: &str) -> Result<printers::Printer, String> {
    printers::load().into_iter().find(|p| p.id == id).ok_or_else(|| t!("err.unknown_printer"))
}

/// Wakes a printer's camera; to restart every 10 s.
#[tauri::command]
async fn camera_start(printer_id: String) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    printers::camera_start(&p.host, p.port).await.map_err(ui_err)
}

#[tauri::command]
async fn camera_stop(printer_id: String) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    printers::camera_stop(&p.host, p.port).await.map_err(ui_err)
}

/// `cam://localhost/f?id=<printer>`: latest image of its camera. The printer
/// is designated by its id, never by an address: the protocol can only reach
/// saved machines.
async fn handle_cam(uri: String) -> Response<Vec<u8>> {
    let fail = |code: u16| Response::builder().status(code).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    let Some(id) = query_param(&uri, "id") else {
        return fail(400);
    };
    let Ok(p) = printer_by_id(&id) else {
        return fail(404);
    };
    match printers::camera_frame(&p.host, p.port).await {
        Ok(jpg) => Response::builder()
            .status(200)
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", "*")
            .body(jpg)
            .unwrap(),
        Err(_) => fail(502),
    }
}

#[tauri::command]
fn slice_cancel(id: String) -> bool {
    slice::cancel(&id)
}

/// Slicers detected on the machine.
#[tauri::command]
fn slicers_list() -> Vec<slicers::Slicer> {
    slicers::list()
}

#[tauri::command]
fn quick_places() -> Vec<PlaceDto> {
    let mut v = Vec::new();
    let mut push = |label: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            if p.is_dir() {
                v.push(PlaceDto { label: label.to_string(), path: p.to_string_lossy().to_string() });
            }
        }
    };
    push(&t!("place.downloads"), dirs::download_dir());
    push(&t!("place.documents"), dirs::document_dir());
    push(&t!("place.desktop"), dirs::desktop_dir());
    push(&t!("place.home"), dirs::home_dir());
    v
}

// ---------------------------------------------------------------- printers

#[tauri::command]
fn printers_list() -> Vec<printers::Printer> {
    printers::load()
}

/// Adds a printer, or updates the one with the same id.
#[tauri::command]
fn printer_save(mut printer: printers::Printer) -> Result<Vec<printers::Printer>, String> {
    let mut list = printers::load();
    if printer.id.is_empty() {
        printer.id = printers::new_id();
    }
    match list.iter_mut().find(|p| p.id == printer.id) {
        Some(slot) => *slot = printer,
        None => list.push(printer),
    }
    printers::save(&list).map_err(ui_err)?;
    Ok(list)
}

#[tauri::command]
fn printer_remove(id: String) -> Result<Vec<printers::Printer>, String> {
    let mut list = printers::load();
    list.retain(|p| p.id != id);
    printers::save(&list).map_err(ui_err)?;
    Ok(list)
}

/// Tests an address typed by the user (no network exploration).
#[tauri::command]
async fn printer_probe(host: String, port: u16) -> printers::Probe {
    printers::probe(&host, port).await
}

#[tauri::command]
async fn printer_status(host: String, port: u16) -> printers::Status {
    printers::status(&host, port).await
}

/// What a printer counts (heads, hours, jobs), for its Maintenance view.
#[tauri::command]
async fn printer_maintenance(host: String, port: u16) -> Result<maintenance::Usage, String> {
    maintenance::usage(&host, port).await.map_err(ui_err)
}

/// A printer's maintenance log.
#[tauri::command]
fn maintenance_log(printer_id: String) -> Vec<maintenance::Entry> {
    maintenance::entries(&printer_id)
}

/// Logs a maintenance task done now, with the counters at that moment.
#[tauri::command]
fn maintenance_done(printer_id: String, task: String, print_hours: f64, swaps: Vec<u64>) -> Result<Vec<maintenance::Entry>, String> {
    maintenance::done(&printer_id, &task, print_hours, swaps).map_err(ui_err)
}

/// Forgets a log entry made by mistake.
#[tauri::command]
fn maintenance_remove(printer_id: String, task: String, at: u64) -> Result<Vec<maintenance::Entry>, String> {
    maintenance::remove(&printer_id, &task, at).map_err(ui_err)
}

/// A printer's bed mesh now, with its settings and progress.
#[tauri::command]
async fn bed_mesh_read(printer_id: String, light: Option<bool>) -> Result<bedmesh::Live, String> {
    let p = printer_by_id(&printer_id)?;
    bedmesh::read(&p.host, p.port, light.unwrap_or(false)).await.map_err(ui_err)
}

/// The meshes stored for a printer, oldest first.
#[tauri::command]
fn bed_mesh_history(printer_id: String) -> Vec<bedmesh::Mesh> {
    bedmesh::history(&printer_id)
}

/// Stores a full-bed mesh not seen yet; returns the history.
#[tauri::command]
fn bed_mesh_record(printer_id: String, mesh: bedmesh::Mesh, keep: usize, by_app: bool) -> Result<Vec<bedmesh::Mesh>, String> {
    bedmesh::record(&printer_id, mesh, keep, by_app).map_err(ui_err)
}

#[tauri::command]
fn bed_mesh_remove(printer_id: String, at: u64) -> Result<Vec<bedmesh::Mesh>, String> {
    bedmesh::remove(&printer_id, at).map_err(ui_err)
}

/// Keeps only the `keep` newest meshes.
#[tauri::command]
fn bed_mesh_keep(printer_id: String, keep: usize) -> Result<Vec<bedmesh::Mesh>, String> {
    bedmesh::keep(&printer_id, keep).map_err(ui_err)
}

/// Measures the bed; returns when the printer is done.
#[tauri::command]
async fn bed_mesh_measure(printer_id: String, temp: f64) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    bedmesh::measure(&p.host, p.port, temp).await.map_err(ui_err)
}

/// Care & Tuning › Control: the printer's state, with its configuration
/// when asked (`config`, once per opening).
#[tauri::command]
async fn control_read(printer_id: String, config: Option<bool>) -> Result<serde_json::Value, String> {
    let p = printer_by_id(&printer_id)?;
    let (state, cfg) = control::read(&p.host, p.port, config.unwrap_or(false)).await.map_err(ui_err)?;
    Ok(serde_json::json!({ "state": state, "config": cfg }))
}

/// Carries out one of Control's actions (never raw G-code: `control::Action`).
#[tauri::command]
async fn control_run(printer_id: String, action: control::Action) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    control::run(&p.host, p.port, &action).await.map_err(ui_err)
}

/// Stops the probing cleanly (the U1, once its leveling has begun).
#[tauri::command]
async fn bed_mesh_abort(printer_id: String) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    bedmesh::abort(&p.host, p.port).await.map_err(ui_err)
}

/// Emergency stop of a measurement going wrong (then Klipper restarts).
#[tauri::command]
async fn bed_mesh_stop(printer_id: String) -> Result<(), String> {
    let p = printer_by_id(&printer_id)?;
    bedmesh::stop(&p.host, p.port).await.map_err(ui_err)
}

/// A system notification (the end of a measurement while the app is
/// elsewhere).
#[tauri::command]
fn app_notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    #[cfg(feature = "sim")]
    let title = sim::tag(&title);
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Opens the live feeds (Printers tab shown).
#[tauri::command]
fn printers_watch_start(app: tauri::AppHandle) {
    watch::start(app);
}

#[tauri::command]
fn printers_watch_stop() {
    watch::stop();
}

/// Folder passed as an argument at launch: `snap-studio ~/Downloads`.
#[tauri::command]
fn initial_dir() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).is_dir())
}

#[tauri::command]
async fn cache_info() -> Result<CacheDto, String> {
    off_main(|| Ok(CacheDto { bytes: thumbs::size_on_disk() })).await
}

#[tauri::command]
async fn clear_cache() -> Result<usize, String> {
    off_main(|| Ok(thumbs::clear())).await
}

// ---------------------------------------------------------------- thumb:// protocol

type Job = Box<dyn FnOnce() + Send + 'static>;

fn pool() -> &'static Sender<Job> {
    static POOL: OnceLock<Sender<Job>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let rx = std::sync::Arc::new(Mutex::new(rx));
        let n = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4);
        for _ in 0..n {
            let rx = rx.clone();
            std::thread::spawn(move || loop {
                let job = { rx.lock().unwrap().recv() };
                match job {
                    Ok(job) => job(),
                    Err(_) => break,
                }
            });
        }
        tx
    })
}

/// Answers a request on the pool. A handler that panics answers 500: the
/// thread survives (a dead one is never replaced, and once all are gone
/// every preview and thumbnail would hang).
fn serve_on_pool(responder: tauri::UriSchemeResponder, uri: String, handle: fn(&str) -> Response<Vec<u8>>) {
    let _ = pool().send(Box::new(move || {
        let response = std::panic::catch_unwind(|| handle(&uri)).unwrap_or_else(|_| {
            eprintln!("[protocol] {uri}: the handler panicked");
            Response::builder().status(500).body(Vec::new()).unwrap_or_default()
        });
        responder.respond(response);
    }));
}

/// A message as a header value: `http` refuses control characters (a
/// newline in an error would make the response builder fail).
fn header_text(msg: &str) -> String {
    msg.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

fn query_param(uri: &str, key: &str) -> Option<String> {
    let q = uri.split_once('?')?.1;
    for kv in q.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return urlencoding::decode(v).ok().map(|s| s.to_string());
            }
        }
    }
    None
}

/// A G-code's toolpaths for the viewer.
fn handle_gcode(uri: &str) -> Response<Vec<u8>> {
    let fail = |code: u16, msg: &str| {
        Response::builder()
            .status(code)
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Error", header_text(msg))
            .body(Vec::new())
            .unwrap()
    };
    let Some(path) = query_param(uri, "p") else {
        return fail(400, "missing path");
    };
    access::ensure_file(Path::new(&path));
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => return fail(404, &ui_err(e)),
    };
    match gcode::parse(file) {
        Ok(d) => Response::builder()
            .status(200)
            .header("Content-Type", "application/octet-stream")
            .header("Cache-Control", "public, max-age=3600")
            .header("Access-Control-Allow-Origin", "*")
            .body(gcode::encode(&d))
            .unwrap(),
        Err(e) => fail(422, &ui_err(e)),
    }
}

/// Raw mesh for the 3D viewer.
/// Saves the current state into the user's files, as 3MF.
#[tauri::command]
async fn ia_save(id: String) -> Result<String, String> {
    off_main(move || ia::save_to_files(&id).map_err(ui_err)).await
}

#[tauri::command]
fn ia_versions(id: String) -> Vec<ia::Version> {
    ia::versions(&id)
}

#[tauri::command]
async fn ia_revert(id: String, n: u32) -> Result<(), String> {
    off_main(move || ia::revert(&id, n).map_err(ui_err)).await
}

#[tauri::command]
async fn ia_stats(id: String) -> Result<mesh::Stats, String> {
    off_main(move || ia::current_stats(&id).map_err(ui_err)).await
}

// ---------------------------------------------------------------- AI chat

/// A conversation's past, for the chat view: its log, or Claude's transcript.
#[tauri::command]
fn ia_chat_history(id: String) -> Vec<serde_json::Value> {
    chat::history(&id)
}

/// Sends a message (and its images and models), starting Claude when
/// needed. Slow enough (process start, image writing, model conversion) to
/// stay off the main thread. `models`: paths of STL or 3MF files.
#[tauri::command]
async fn ia_chat_send(
    app: tauri::AppHandle,
    id: String,
    text: String,
    images: Vec<chat::Attachment>,
    models: Option<Vec<String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = ia::get(&id).map_err(ui_err)?;
        let models: Vec<PathBuf> = models.unwrap_or_default().into_iter().map(PathBuf::from).collect();
        chat::send(&app, &c, &text, &images, &models).map_err(ui_err)
    })
    .await
    .map_err(ui_err)?
}

/// Checks files the user wants to attach to an AI message (dropped, chosen
/// or pasted): images come back in base64, models with what their chip
/// shows, the others with the reason they are refused. A big model takes a
/// while to read: off the main thread.
#[tauri::command]
async fn ia_attach_files(paths: Vec<String>) -> Result<Vec<ia_attach::Staged>, String> {
    off_main(move || Ok(paths.iter().map(|p| ia_attach::inspect(Path::new(p))).collect())).await
}

#[tauri::command]
fn ia_chat_stop(id: String) -> Result<(), String> {
    chat::stop(&id).map_err(ui_err)
}

/// Answers a permission request; `input` carries an `AskUserQuestion`'s answers.
#[tauri::command]
fn ia_chat_answer(id: String, request_id: String, allow: bool, always: bool, input: Option<serde_json::Value>) -> Result<(), String> {
    chat::answer(&id, &request_id, allow, always, input).map_err(ui_err)
}

/// Claude model of the conversation; none: the account's default. An idle
/// Claude closes to resume with it: off the main thread.
#[tauri::command]
async fn ia_chat_model(id: String, model: Option<String>) -> Result<(), String> {
    off_main(move || chat::set_model(&id, model.as_deref()).map_err(ui_err)).await
}

/// What the conversation's terminal showed so far (base64), for its
/// Terminal tab; the rest arrives as `ia-screen` events.
#[tauri::command]
fn ia_term_screen(id: String) -> String {
    chat::screen(&id)
}

/// The conversation's Terminal tab shown or left: its terminal's bytes come
/// as `ia-screen` events only while it is shown.
#[tauri::command]
fn ia_term_view(id: String, on: bool) {
    chat::set_viewed(&id, on);
}

/// The Terminal tab's size, for the conversation's terminal.
#[tauri::command]
fn ia_term_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    chat::resize(&id, cols, rows).map_err(ui_err)
}

/// True while Claude runs for this conversation in chat mode.
#[tauri::command]
fn ia_chat_running(id: String) -> bool {
    chat::is_open(&id)
}

#[tauri::command]
async fn ia_chat_close(id: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || chat::close(&id)).await;
}

// ---------------------------------------------------------------- Snappy

/// Snappy's conversation so far.
#[tauri::command]
fn snappy_history() -> Vec<serde_json::Value> {
    snappy::history()
}

/// Sends a message to Snappy with the app's current context (view,
/// printer, Prepare); starts its Claude when needed.
#[tauri::command]
async fn snappy_send(text: String, context: serde_json::Value, images: Option<Vec<chat::Attachment>>) -> Result<(), String> {
    off_main(move || snappy::send(&text, &context, &images.unwrap_or_default()).map_err(ui_err)).await
}

/// An image attached to a message to Snappy, for its card (a data URL).
#[tauri::command]
fn snappy_attachment(name: String) -> Result<String, String> {
    snappy_eyes::attachment_url(&name).map_err(ui_err)
}

/// Snappy's memory as saved (Settings › AI › Snappy).
#[tauri::command]
fn snappy_memory() -> String {
    snappy::memory_raw()
}

/// Saves Snappy's memory as edited by the user (filtered, within its limits).
#[tauri::command]
fn snappy_memory_set(content: String) -> Result<(), String> {
    snappy::set_memory(&content).map_err(ui_err)
}

/// Forgets everything Snappy remembers.
#[tauri::command]
fn snappy_memory_clear() -> Result<(), String> {
    snappy::clear_memory().map_err(ui_err)
}

#[tauri::command]
fn snappy_stop() -> Result<(), String> {
    snappy::stop().map_err(ui_err)
}

/// True while Snappy answers.
#[tauri::command]
fn snappy_busy() -> bool {
    snappy::is_busy()
}

/// Whether Snappy is on (Settings › AI).
#[tauri::command]
fn snappy_enabled() -> bool {
    snappy::enabled()
}

/// Switches Snappy on or off; off, its Claude stops: off the main thread.
#[tauri::command]
async fn snappy_set_enabled(on: bool) -> Result<(), String> {
    off_main(move || {
        snappy::set_enabled(on);
        Ok(())
    })
    .await
}

/// Snappy's model (Settings › AI); none: the account's default.
#[tauri::command]
fn snappy_model() -> Option<String> {
    snappy::model()
}

/// Sets Snappy's model; an idle Snappy closes to resume with it: off the
/// main thread.
#[tauri::command]
async fn snappy_set_model(model: Option<String>) -> Result<(), String> {
    off_main(move || snappy::set_model(model.as_deref().filter(|m| !m.is_empty())).map_err(ui_err)).await
}

/// How full Snappy's conversation is (Settings › AI).
#[tauri::command]
fn snappy_usage() -> snappy::Usage {
    snappy::usage()
}

/// A new conversation: the current one is deleted, the memory stays.
#[tauri::command]
async fn snappy_reset() -> Result<(), String> {
    off_main(|| snappy::reset().map_err(ui_err)).await
}

/// The drawer opened or closed: closed, what waits for approval is refused.
#[tauri::command]
fn snappy_drawer(open: bool) {
    snappy_tools::set_drawer(open);
}

/// What waits for the user now (cards and questions), for a card drawn
/// again.
#[tauri::command]
fn snappy_waiting() -> Vec<serde_json::Value> {
    snappy_tools::waiting_shown()
}

/// The user's answer to an approval card.
#[tauri::command]
fn snappy_approve(id: String, yes: bool) {
    snappy_tools::answer(&id, yes);
}

/// The user's answer to Snappy's question (None: skipped).
#[tauri::command]
fn snappy_reply(id: String, answer: Option<String>) {
    snappy_tools::reply(&id, answer);
}

/// The UI's answer to a question from a tool (Prepare's state, the Files
/// view).
#[tauri::command]
fn snappy_ui_reply(id: String, result: serde_json::Value) {
    snappy_tools::ui_reply(&id, result);
}

// ---------------------------------------------------------------- Claude sign-in

/// Claude's sign-in on this Mac ("local") or in the sandbox ("container"),
/// as Claude reports it. Slow in the sandbox (a container starts).
#[tauri::command]
async fn auth_status(engine: String) -> Result<auth::Status, String> {
    tauri::async_runtime::spawn_blocking(move || auth::status(&engine)).await.map_err(ui_err)
}

/// A real check of the sign-in: one tiny call to the model.
#[tauri::command]
async fn auth_verify(engine: String) -> Result<auth::Check, String> {
    tauri::async_runtime::spawn_blocking(move || auth::verify(&engine)).await.map_err(ui_err)
}

/// True if the sandbox has a token of its own.
#[tauri::command]
fn auth_sandbox_present() -> bool {
    auth::sandbox_token().is_some()
}

/// Stores a sandbox token pasted by hand.
#[tauri::command]
fn auth_sandbox_set(token: String) -> Result<(), String> {
    auth::set_sandbox_token(&token).map_err(ui_err)
}

/// Forgets the sandbox token: the sandbox goes back to the Mac's login.
#[tauri::command]
fn auth_sandbox_clear() -> Result<(), String> {
    auth::clear_sandbox_token().map_err(ui_err)
}

/// Opens the sign-in terminal: "login" (this Mac) or "setup" (sandbox token).
#[tauri::command]
fn auth_term_open(app: tauri::AppHandle, kind: String, cols: u16, rows: u16) -> Result<(), String> {
    auth::term_open(&app, &kind, cols, rows).map_err(ui_err)
}

/// Keystrokes for the sign-in terminal (`auth_term_open`).
#[tauri::command]
fn pty_write(id: String, data: String) -> Result<(), String> {
    pty::write(&id, &data).map_err(ui_err)
}

#[tauri::command]
fn pty_close(id: String) {
    pty::close(&id);
}

/// True if Claude has a saved session for this conversation.
#[tauri::command]
fn ia_resumable(id: String) -> bool {
    ia::has_session(&id)
}

/// Working folder, to open it in the Finder.
#[tauri::command]
fn ia_workspace(id: String) -> String {
    ia::workspace(&id).to_string_lossy().to_string()
}

#[tauri::command]
fn ia_get(id: String) -> Result<ia::Conversation, String> {
    ia::get(&id).map_err(ui_err)
}

// ---------------------------------------------------------------- IA

/// What the AI needs, mode by mode (built-in sandbox, container, this Mac).
/// A few seconds: Python, and the container engines when `scope` asks.
#[tauri::command]
async fn ai_check(scope: Option<setup::CheckScope>) -> Result<setup::Report, String> {
    tauri::async_runtime::spawn_blocking(move || setup::check(scope.unwrap_or_default())).await.map_err(ui_err)
}

#[tauri::command]
fn ia_list() -> Vec<ia::Conversation> {
    ia::list()
}

#[tauri::command]
async fn ia_create(source: String, prompt: String, engine: String, model: Option<String>) -> Result<ia::Conversation, String> {
    let model = creation_model(model)?;
    // The source is converted to 3MF: a big mesh takes a while.
    off_main(move || {
        let c = ia::create(Path::new(&source), &prompt, &engine).map_err(ui_err)?;
        with_model(c, model)
    })
    .await
}

#[tauri::command]
fn ia_create_blank(
    prompt: String,
    engine: String,
    dest: String,
    bounds: Option<[f32; 3]>,
    model: Option<String>,
) -> Result<ia::Conversation, String> {
    let model = creation_model(model)?;
    let c = ia::create_blank(&prompt, &engine, Path::new(&dest), bounds).map_err(ui_err)?;
    with_model(c, model)
}

/// Model chosen in the creation sheet, checked before anything is created.
/// Empty or none: the account's default.
fn creation_model(model: Option<String>) -> Result<Option<String>, String> {
    match model.filter(|m| !m.is_empty()) {
        Some(m) if !chat::MODELS.contains(&m.as_str()) => Err(format!("unknown model: {m}")),
        m => Ok(m),
    }
}

/// The new conversation with its model, kept for its first start.
fn with_model(c: ia::Conversation, model: Option<String>) -> Result<ia::Conversation, String> {
    let Some(m) = model else { return Ok(c) };
    chat::set_model(&c.id, Some(&m)).map_err(ui_err)?;
    ia::get(&c.id).map_err(ui_err)
}

#[tauri::command]
async fn ia_delete(id: String) -> Result<IaDeleted, String> {
    tauri::async_runtime::spawn_blocking(move || delete_conversation(&id)).await.map_err(ui_err)?
}

/// What a deletion left behind, for the toast.
#[derive(serde::Serialize)]
struct IaDeleted {
    list: Vec<ia::Conversation>,
    /// Claude session files removed.
    removed: usize,
    /// Paths that were kept: links, out of place, or not removable.
    kept: Vec<String>,
}

fn delete_conversation(id: &str) -> Result<IaDeleted, String> {
    // Only one of our conversations: its id is then a session we created,
    // never someone else's Claude session.
    ia::get(id).map_err(|_| t!("err.conv_unknown"))?;
    // Deleting under a running Claude would leave it running without a
    // directory, and still writing its transcript: it closes first, and the
    // close waits for its process to exit.
    chat::close(id);
    ia::watch_stop(id);
    // Listed before the folder goes: the project folder's name derives from it.
    let found = ia::session_artifacts(id).map_err(ui_err)?;
    ia::remove(id).map_err(ui_err)?;
    let (removed, failed) = ia::remove_artifacts(&found);
    let kept = found.skipped.iter().chain(&failed).map(|p| p.to_string_lossy().into_owned()).collect();
    Ok(IaDeleted { list: ia::list(), removed, kept })
}

/// What deleting a conversation would remove, for its confirmation.
#[derive(serde::Serialize)]
struct IaDeletePlan {
    /// Claude session files found for it.
    files: usize,
    /// A Claude process is open for it (chat or terminal).
    running: bool,
}

#[tauri::command]
async fn ia_delete_plan(id: String) -> Result<IaDeletePlan, String> {
    off_main(move || {
        ia::get(&id).map_err(|_| t!("err.conv_unknown"))?;
        let found = ia::session_artifacts(&id).map_err(ui_err)?;
        Ok(IaDeletePlan { files: found.paths.len(), running: chat::is_open(&id) })
    })
    .await
}

#[tauri::command]
async fn ia_duplicate(id: String) -> Result<ia::Conversation, String> {
    off_main(move || ia::duplicate(&id).map_err(ui_err)).await
}

#[tauri::command]
fn ia_rename(id: String, title: String) -> Result<ia::Conversation, String> {
    ia::rename(&id, &title).map_err(ui_err)
}

/// Path of the current mesh and stamp of its last write.
#[tauri::command]
fn ia_current(id: String) -> Result<ia::CurrentDto, String> {
    ia::current_dto(&id).map_err(|_| t!("err.conv_empty"))
}

fn handle_mesh(uri: &str) -> Response<Vec<u8>> {
    let fail = |code: u16, msg: &str| {
        Response::builder()
            .status(code)
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Error", header_text(msg))
            .body(Vec::new())
            .unwrap()
    };
    let Some(path) = query_param(uri, "p") else {
        return fail(400, "missing path");
    };
    // Beyond this, display gets heavy without gaining readability: the loader
    // then samples the triangles.
    let budget: usize = query_param(uri, "b").and_then(|s| s.parse().ok()).unwrap_or(900_000).clamp(10_000, 3_000_000);

    // STL and 3MF go through the same protocol (older AI conversations kept
    // STL versions); the extension decides.
    let is_stl = Path::new(&path).extension().is_some_and(|e| e.eq_ignore_ascii_case("stl"));
    // `i`: a single object of the file, in its own frame (Prepare view).
    if let Some(index) = query_param(uri, "i").and_then(|s| s.parse::<usize>().ok()) {
        // `c`: one piece of it, once split.
        let piece = query_param(uri, "c").and_then(|s| s.parse::<usize>().ok());
        return match plate::display_mesh(Path::new(&path), index, piece, budget) {
            Ok(m) => Response::builder()
                .status(200)
                .header("Content-Type", "application/octet-stream")
                .header("Cache-Control", "public, max-age=3600")
                .header("Access-Control-Allow-Origin", "*")
                .body(mesh::encode(&m))
                .unwrap(),
            Err(e) => fail(422, &ui_err(e)),
        };
    }
    let loaded = if is_stl {
        stl::read(Path::new(&path)).map(|mut m| {
            mesh::downsample(&mut m, budget);
            m
        })
    } else {
        match model3mf::open(Path::new(&path)) {
            Ok(mut zip) => mesh::load_mesh(&mut zip, budget).map(|mut m| {
                plate::filament_colored(&mut zip, &mut m);
                m
            }),
            Err(e) => return fail(404, &ui_err(e)),
        }
    };
    match loaded {
        Ok(m) => Response::builder()
            .status(200)
            .header("Content-Type", "application/octet-stream")
            .header("Cache-Control", "public, max-age=3600")
            .header("Access-Control-Allow-Origin", "*")
            .body(mesh::encode(&m))
            .unwrap(),
        Err(e) => fail(422, &ui_err(e)),
    }
}

fn handle_thumb(uri: &str) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(404).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    // An object created by the AI has no original: its thumbnail is the
    // preview the app renders for Claude.
    if let Some(id) = query_param(uri, "ia") {
        // An image attached in the conversation view.
        if let Some(name) = query_param(uri, "att") {
            return match ia::attachment(&id, &name) {
                Ok((bytes, mime)) => Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                Err(_) => not_found(),
            };
        }
        return match ia::preview_png(&id) {
            Ok(png) => Response::builder()
                .status(200)
                .header("Content-Type", "image/png")
                .header("Access-Control-Allow-Origin", "*")
                .body(png)
                .unwrap(),
            Err(_) => not_found(),
        };
    }
    let Some(path) = query_param(uri, "p") else {
        return not_found();
    };
    let size: u32 = query_param(uri, "s").and_then(|s| s.parse().ok()).unwrap_or(320).clamp(64, 1600);
    let pref = match query_param(uri, "k").as_deref() {
        Some("1") => ThumbPref::Plate,
        Some("2") => ThumbPref::Model,
        Some("3") => ThumbPref::Render,
        _ => ThumbPref::Auto,
    };
    match thumbs::get(Path::new(&path), size, pref) {
        Ok(t) => Response::builder()
            .status(200)
            .header("Content-Type", "image/png")
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .header("Access-Control-Allow-Origin", "*")
            .body(t.png)
            .unwrap(),
        Err(_) => not_found(),
    }
}

// ---------------------------------------------------------------- analytics

/// The anonymous usage count: whether this build can send, the choice,
/// and whether the notice was answered (analytics.rs).
#[tauri::command]
fn analytics_status() -> analytics::Status {
    analytics::status()
}

/// Development builds only: `SNAP_PREVIEW_NOTICES=1` shows the first-launch
/// notice at every start with all its steps, answering nothing (to see it
/// without a fresh profile or an Aptabase key). Always off in a release.
#[tauri::command]
fn notices_preview() -> bool {
    cfg!(debug_assertions) && std::env::var_os("SNAP_PREVIEW_NOTICES").is_some_and(|v| v == "1")
}

/// The first-launch notice answered, with the switch as left.
#[tauri::command]
fn analytics_answer(app: tauri::AppHandle, enabled: bool) -> Result<analytics::Status, String> {
    analytics::answer(&app, enabled).map_err(ui_err)
}

/// The switch in Settings › Application, effective at once.
#[tauri::command]
fn analytics_set(app: tauri::AppHandle, enabled: bool) -> Result<analytics::Status, String> {
    analytics::set_enabled(&app, enabled).map_err(ui_err)
}

// ---------------------------------------------------------------- language

/// Switches language; the native menu bar is rebuilt to follow.
#[tauri::command]
fn language_set(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    i18n::set(&lang).map_err(ui_err)?;
    // The floating navigation over a site is a page of its own.
    library::nav_relabel(&app);
    #[cfg(target_os = "macos")]
    if let Ok(menu) = menu::app_menu(&app) {
        let _ = app.set_menu(menu);
    }
    Ok(())
}

// ---------------------------------------------------------------- app

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First of all: carry over the data of the former "3MF Studio".
    migrate::run();
    // Simulated printers, before anything reads the saved printers.
    #[cfg(feature = "sim")]
    sim::boot();
    std::thread::spawn(thumbs::prune_old);
    std::thread::spawn(slice::cleanup_stale);

    let builder = tauri::Builder::default();
    // The anonymous usage count: a release build with its key only.
    let builder = match analytics::plugin() {
        Some(p) => builder.plugin(p),
        None => builder,
    };
    // Native menu bar on macOS; elsewhere, the UI keeps its shortcuts.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| menu::app_menu(app));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(update::Pending::default())
        .manage(discover::Discovery::default())
        .register_asynchronous_uri_scheme_protocol("cam", |ctx, request: Request<Vec<u8>>, responder| {
            // Ours, and the pinned camera's view over a site (library.rs).
            if !own_webview(&ctx) && !library::is_cam_view(ctx.webview_label()) {
                return responder.respond(refused());
            }
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(handle_cam(uri).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("prn", |ctx, request: Request<Vec<u8>>, responder| {
            if !own_webview(&ctx) {
                return responder.respond(refused());
            }
            let uri = request.uri().to_string();
            let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(String::from);
            tauri::async_runtime::spawn(async move {
                responder.respond(handle_prn(uri, range).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("gcode", |ctx, request: Request<Vec<u8>>, responder| {
            if !own_webview(&ctx) {
                return responder.respond(refused());
            }
            let uri = request.uri().to_string();
            serve_on_pool(responder, uri, handle_gcode);
        })
        .register_asynchronous_uri_scheme_protocol("mesh", |ctx, request: Request<Vec<u8>>, responder| {
            if !own_webview(&ctx) {
                return responder.respond(refused());
            }
            let uri = request.uri().to_string();
            serve_on_pool(responder, uri, handle_mesh);
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request: Request<Vec<u8>>, responder| {
            if !own_webview(&ctx) {
                return responder.respond(refused());
            }
            let uri = request.uri().to_string();
            serve_on_pool(responder, uri, handle_thumb);
        })
        .on_menu_event(|app, event| menu::forward(app, event.id().as_ref()))
        .setup(|app| {
            // This launch's count, if the notice was answered with it on.
            analytics::start(app.handle());
            // Snappy's events and tools reach the window through it.
            snappy::init(app.handle());
            use tauri::Manager;
            // Background tracking of prints: end of print, queue.
            jobs::start(app.handle().clone());
            // The main window is declared with `create: false` so that it can
            // receive the translation catalogs before any of its scripts run.
            if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main") {
                let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), cfg)?.initialization_script(i18n::init_script());
                // Settings › Developer and the simulation's badges.
                #[cfg(feature = "sim")]
                let builder = builder.initialization_script(sim::init_script());
                // Linux: the system title bar when the user prefers it
                // (titlebar.rs); the interface draws its own otherwise.
                #[cfg(target_os = "linux")]
                let builder = builder.decorations(titlebar::system_bar());
                builder.build()?;
            }
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(feature = "sim")]
                if sim::active() {
                    let _ = window.set_title(&format!("{} — Simulation", window.title().unwrap_or_default()));
                }
                // Whole window vibrant: the CSS makes the content area opaque and leaves
                // the sidebar translucent.
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ =
                        apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::FollowsWindowActiveState), None);
                }
                // Linux, without decorations: resizing from the edges,
                // rounded corners.
                #[cfg(target_os = "linux")]
                let _ = window.with_webview(|pw| {
                    use gtk::prelude::*;
                    titlebar::edge_resize::attach(pw.inner().upcast_ref());
                    titlebar::round_corners::attach(pw.inner().upcast_ref());
                });
                #[cfg(target_os = "linux")]
                if let Ok(gw) = window.gtk_window() {
                    use gtk::prelude::*;
                    titlebar::round_corners::attach_window(gw.upcast_ref());
                }
                // Created invisible to avoid the white flash before the first render.
                // Showing it does not bring the app forward on macOS: focus it too.
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            language_set,
            analytics_status,
            analytics_answer,
            analytics_set,
            titlebar::titlebar_info,
            titlebar::titlebar_system_set,
            update::app_version,
            update::system_name,
            update::update_check,
            update::update_install,
            discover::printer_discover_start,
            discover::printer_discover_stop,
            pick_folder,
            scan_folder,
            read_metas,
            analyze,
            trash_files,
            reveal,
            open_file,
            quick_places,
            slicers_list,
            slice_lists,
            slice_details,
            engine_status,
            engine_install,
            engine_cancel,
            engine_remove,
            slice_defaults,
            slice_save_process,
            slice_start,
            slice_cancel,
            slice_save,
            slice_discard,
            slice_model,
            plate_items,
            plate_bed,
            plate_hull,
            plate_pieces,
            plate_orient,
            plate_support_hint,
            plate_save,
            plate_tower,
            mix_colors,
            print_send,
            pf_overview,
            pf_count,
            pf_videos,
            pf_tools,
            pf_plate,
            share_fetch,
            share_caps,
            share_copy,
            share_save,
            share_native,
            share_qr_start,
            share_qr_stop,
            pf_video_duration,
            pf_delete,
            pf_rename,
            pf_download,
            pf_print,
            jobs_list,
            prints_status,
            job_launch,
            job_remove,
            job_move,
            job_edit,
            job_requeue,
            job_set_result,
            job_set_timelapse,
            jobs_retention,
            jobs_set_retention,
            queue_dismiss,
            queue_check,
            print_action,
            camera_start,
            camera_stop,
            lib_sites,
            lib_nav,
            cam_view_set,
            cam_view_action,
            snappy_view_set,
            notices_preview,
            snappy_reply,
            snappy_view_action,
            lib_favicon,
            lib_open,
            lib_close,
            lib_show,
            lib_rect,
            lib_navigate,
            lib_command,
            lib_url,
            lib_logout,
            ai_check,
            ia_list,
            ia_create,
            ia_create_blank,
            ia_delete,
            ia_delete_plan,
            ia_rename,
            ia_duplicate,
            ia_current,
            ia_get,
            ia_workspace,
            ia_save,
            ia_versions,
            ia_revert,
            ia_stats,
            ia_chat_history,
            ia_chat_send,
            ia_attach_files,
            ia_chat_stop,
            ia_chat_answer,
            ia_chat_model,
            ia_chat_running,
            ia_chat_close,
            ia_term_screen,
            ia_term_resize,
            ia_term_view,
            snappy_history,
            snappy_send,
            snappy_attachment,
            snappy_memory,
            snappy_memory_set,
            snappy_memory_clear,
            snappy_stop,
            snappy_busy,
            snappy_enabled,
            snappy_set_enabled,
            snappy_usage,
            snappy_reset,
            snappy_model,
            snappy_set_model,
            snappy_drawer,
            snappy_approve,
            snappy_waiting,
            snappy_ui_reply,
            auth_status,
            auth_verify,
            auth_sandbox_present,
            auth_sandbox_set,
            auth_sandbox_clear,
            auth_term_open,
            pty_write,
            pty_close,
            ia_resumable,
            fav_list,
            fav_add,
            fav_remove,
            initial_dir,
            printers_list,
            printer_save,
            printer_remove,
            printer_probe,
            printer_status,
            printer_maintenance,
            maintenance_log,
            maintenance_done,
            maintenance_remove,
            bed_mesh_read,
            bed_mesh_history,
            bed_mesh_record,
            bed_mesh_remove,
            bed_mesh_keep,
            bed_mesh_measure,
            bed_mesh_stop,
            bed_mesh_abort,
            control_read,
            control_run,
            app_notify,
            printers_watch_start,
            printers_watch_stop,
            cache_info,
            clear_cache,
            menu::popup_menu,
            #[cfg(feature = "sim")]
            sim::sim_status,
            #[cfg(feature = "sim")]
            sim::sim_config,
            #[cfg(feature = "sim")]
            sim::sim_new_printer,
            #[cfg(feature = "sim")]
            sim::sim_set,
            #[cfg(feature = "sim")]
            sim::sim_fault,
            #[cfg(feature = "sim")]
            sim::sim_spool
        ])
        .build(tauri::generate_context!())
        .expect("error while starting the application")
        .run(|_app, event| {
            // A terminal would outlive the window: close it with the window.
            if let tauri::RunEvent::Exit = event {
                pty::close_all();
                chat::close_all();
                share::cleanup();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_header_never_breaks_the_response() {
        let msg = "line one\nline two\r\u{7f}é";
        assert!(Response::builder().header("X-Error", msg).body(()).is_err(), "raw: refused by http");
        assert_eq!(header_text(msg), "line one line two  é");
        assert!(Response::builder().header("X-Error", header_text(msg)).body(()).is_ok());
    }

    /// The interface every build bundles names nothing of the simulator:
    /// its labels come from `sim_status`, its Developer section lives in
    /// `src-tauri/sim/ui/`, added by `sim` builds only.
    #[test]
    fn the_bundled_interface_has_no_simulator() {
        let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
        for e in walkdir::WalkDir::new(&ui).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            for word in ["SIMULATED", "SIMULATION", "sim_status", "sim_config", "sim_set", "sim_fault", "sim_spool"] {
                assert!(!text.contains(word), "{} names {word}", e.path().display());
            }
        }
    }

    #[test]
    fn creation_model_is_checked_first() {
        assert_eq!(creation_model(None), Ok(None));
        assert_eq!(creation_model(Some(String::new())), Ok(None));
        assert_eq!(creation_model(Some("claude-opus-5-5".into())), Ok(Some("claude-opus-5-5".into())));
        assert!(creation_model(Some("gpt-9".into())).is_err());
    }

    #[test]
    fn parse_query() {
        let u = "thumb://localhost/t?p=%2FUsers%2Fa%2FMon%20fichier%20%2B%20test.3mf&s=320&k=2&v=12";
        assert_eq!(query_param(u, "p").as_deref(), Some("/Users/a/Mon fichier + test.3mf"));
        assert_eq!(query_param(u, "s").as_deref(), Some("320"));
        assert_eq!(query_param(u, "k").as_deref(), Some("2"));
        assert_eq!(query_param(u, "zz"), None);
    }

    /// On Windows the UI calls `http://thumb.localhost/…` (WebView2) with a
    /// Windows path: the same parameters come out.
    #[test]
    fn parse_query_windows_form_and_paths() {
        let cases = [
            (
                "http://thumb.localhost/t?p=C%3A%5CUsers%5CAna%5CMes%20mod%C3%A8les%5Cpi%C3%A8ce%20%231.3mf&s=46&k=0&v=3",
                r"C:\Users\Ana\Mes modèles\pièce #1.3mf",
            ),
            ("http://thumb.localhost/t?p=%5C%5CNAS%5Cprints%5Ca%26b.3mf&s=320&k=0", r"\\NAS\prints\a&b.3mf"),
            ("http://thumb.localhost/t?p=%5C%5C%3F%5CC%3A%5Clong%5Cx.3mf&s=320&k=0", r"\\?\C:\long\x.3mf"),
        ];
        for (u, want) in cases {
            assert_eq!(query_param(u, "p").as_deref(), Some(want), "{u}");
            assert!(query_param(u, "s").is_some());
        }
    }

    #[test]
    fn an_stl_has_its_size_and_one_plate() {
        let dir = std::env::temp_dir().join(format!("snap-meta-stl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cube.stl");
        stl::write(&p, &stl::tests_cube()).unwrap();
        let m = meta_of(&p.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(m.size_mm, Some([10.0, 10.0, 10.0]));
        assert_eq!(m.plates, 1);
        assert!(!m.has_embedded_thumb && m.title.is_none() && m.filaments.is_empty());
    }

    /// Shows the metadata read from real files.
    #[test]
    fn dump_meta() {
        let dir = std::env::var("PROBE_DIR").unwrap_or_else(|_| format!("{}/Downloads", std::env::var("HOME").unwrap()));
        // Local probe over real 3MFs; skip when Downloads (or PROBE_DIR) is absent (CI).
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut files: Vec<_> =
            rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("3mf")).unwrap_or(false)).collect();
        files.sort();
        for p in files.iter().take(6) {
            let m = meta_of(&p.to_string_lossy());
            println!(
                "{}\n  titre={:?}\n  createur={:?} licence={:?}\n  duree={:?}s poids={:?}g plateaux={} imprimante={:?}\n  pieces={:?}\n  filaments={:?}\n  vignette_integree={}",
                p.file_name().unwrap().to_string_lossy(),
                m.title, m.designer, m.license, m.print_time_s, m.weight_g, m.plates, m.printer,
                m.objects, m.filaments.iter().map(|f| format!("{} {:?} {:?}g", f.kind, f.color, f.used_g)).collect::<Vec<_>>(),
                m.has_embedded_thumb
            );
        }
    }
}
