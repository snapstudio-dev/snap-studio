//! Snappy's tools over the rest of the workshop, beside slicing and the
//! first wave (`snappy_tools.rs`, which holds the table): the printers'
//! controls and states, their files, the queue, Create's conversations,
//! Explore, Prepare's plate, the Files view and Settings.
//!
//! What lives in Rust is called directly, through the same commands the
//! interface uses; what only the page holds (the plate, the Files view,
//! Explore's tabs, Settings' fields) goes through `ui_call`, and the page
//! words the confirmation card itself. Printers, files and conversations
//! are named by their display names, never by a path or an address.

use crate::snappy_tools::{block_on, printer_file, printer_named, str_arg, ui_call, ui_call_within, SHEET_TIMEOUT};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

/// No parameters.
pub fn no_params_value() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn app() -> Result<tauri::AppHandle> {
    crate::snappy::app().cloned().ok_or_else(|| anyhow!("app not ready"))
}

fn printer_only() -> Value {
    json!({ "type": "object", "properties": { "printer": { "type": "string", "description": "The printer's display name." } }, "required": ["printer"] })
}

// ------------------------------------------------------------ printers

pub fn printer_details_params() -> Value {
    printer_only()
}

/// What Control shows: temperatures, positions, fans, heads, light; and
/// the maintenance log.
pub fn printer_details(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let state = block_on(crate::control_read(p.id.clone(), Some(false))).map_err(|e| anyhow!(e))?;
    let log = crate::maintenance_log(p.id.clone());
    Ok(json!({ "printer": p.name, "control": state["state"], "maintenance": log }))
}

/// Control's actions Snappy may take: never a firmware restart or an
/// emergency stop, which stay the user's.
const CONTROL_KINDS: [&str; 18] = [
    "home",
    "jog",
    "tool",
    "nozzle_temp",
    "bed_temp",
    "heaters_off",
    "load",
    "unload",
    "extrude",
    "retract",
    "clean",
    "purge_position",
    "part_fan",
    "chamber_fan",
    "purifier",
    "light",
    "motors_off",
    "filament",
];

pub fn printer_control_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string" },
            "action": {
                "type": "object",
                "description": "`kind` and its fields: home {axes: \"xyz\" or some}, jog {axis, dist mm}, tool {n}, nozzle_temp {n, temp}, bed_temp {temp}, heaters_off, load {n}, unload {n}, extrude {n}, retract {n}, clean, purge_position, part_fan {pct}, chamber_fan {pct}, purifier {on}, light {on}, motors_off, filament {n, vendor, material, sub_type, color \"#rrggbb\"}. Heads count from 0.",
                "properties": { "kind": { "type": "string", "enum": CONTROL_KINDS } },
                "required": ["kind"],
            },
        },
        "required": ["printer", "action"],
    })
}

fn control_action(args: &Value) -> Result<(crate::printers::Printer, crate::control::Action)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let kind = args["action"]["kind"].as_str().unwrap_or_default();
    if !CONTROL_KINDS.contains(&kind) {
        return Err(anyhow!("invalid action kind: {kind}"));
    }
    let action = serde_json::from_value(args["action"].clone()).map_err(|e| anyhow!("invalid action: {e}"))?;
    Ok((p, action))
}

/// The action in the user's words.
fn control_words(a: &crate::control::Action) -> String {
    use crate::control::Action as A;
    let onoff = |b: bool| crate::t!(if b { "snappy.ask.on" } else { "snappy.ask.off" });
    let head = |n: &u8| format!("T{n}");
    match a {
        A::Home { axes } => crate::t!("snappy.ctl.home", axes = axes.to_uppercase()),
        A::Jog { axis, dist } => crate::t!("snappy.ctl.jog", axis = axis.to_uppercase(), dist = dist),
        A::Tool { n } => crate::t!("snappy.ctl.tool", head = head(n)),
        A::NozzleTemp { n, temp } => crate::t!("snappy.ctl.nozzle_temp", head = head(n), temp = temp),
        A::BedTemp { temp } => crate::t!("snappy.ctl.bed_temp", temp = temp),
        A::HeatersOff => crate::t!("snappy.ctl.heaters_off"),
        A::Load { n } => crate::t!("snappy.ctl.load", head = head(n)),
        A::Unload { n } => crate::t!("snappy.ctl.unload", head = head(n)),
        A::Extrude { n } => crate::t!("snappy.ctl.extrude", head = head(n)),
        A::Retract { n } => crate::t!("snappy.ctl.retract", head = head(n)),
        A::Clean => crate::t!("snappy.ctl.clean"),
        A::PurgePosition => crate::t!("snappy.ctl.purge_position"),
        A::PartFan { pct } => crate::t!("snappy.ctl.part_fan", pct = pct),
        A::ChamberFan { pct } => crate::t!("snappy.ctl.chamber_fan", pct = pct),
        A::Purifier { on } => crate::t!("snappy.ctl.purifier", state = onoff(*on)),
        A::Light { on } => crate::t!("snappy.ctl.light", state = onoff(*on)),
        A::MotorsOff => crate::t!("snappy.ctl.motors_off"),
        A::Filament { n, material, color, .. } => crate::t!("snappy.ctl.filament", head = head(n), material = material, color = color),
        A::FirmwareRestart | A::EmergencyStop => String::new(),
    }
}

pub fn ask_printer_control(args: &Value) -> Result<String> {
    let (p, action) = control_action(args)?;
    Ok(crate::t!("snappy.ask.control", printer = p.name, what = control_words(&action)))
}

pub fn printer_control(args: &Value) -> Result<Value> {
    let (p, action) = control_action(args)?;
    block_on(crate::control_run(p.id, action)).map_err(|e| anyhow!(e))?;
    Ok(json!({ "done": true }))
}

pub fn print_control_params() -> Value {
    json!({
        "type": "object",
        "properties": { "printer": { "type": "string" }, "action": { "type": "string", "enum": ["pause", "resume", "cancel"] } },
        "required": ["printer", "action"],
    })
}

fn print_control_of(args: &Value) -> Result<(crate::printers::Printer, &str)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let action = str_arg(args, "action")?;
    if !matches!(action, "pause" | "resume" | "cancel") {
        return Err(anyhow!("invalid action: {action}"));
    }
    Ok((p, action))
}

pub fn ask_print_control(args: &Value) -> Result<String> {
    let (p, action) = print_control_of(args)?;
    Ok(crate::t!(&format!("snappy.ask.print_{action}"), printer = p.name))
}

pub fn print_control(args: &Value) -> Result<Value> {
    let (p, action) = print_control_of(args)?;
    block_on(crate::print_action(p.id, action.to_string())).map_err(|e| anyhow!(e))?;
    Ok(json!({ "done": action }))
}

// ------------------------------------------------------------ printer files

pub fn rename_params() -> Value {
    json!({
        "type": "object",
        "properties": { "printer": { "type": "string" }, "file": { "type": "string", "description": "Its name, from printer_files." }, "name": { "type": "string", "description": "The new name." } },
        "required": ["printer", "file", "name"],
    })
}

pub fn ask_rename(args: &Value) -> Result<String> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let file = str_arg(args, "file")?;
    printer_file(&p, file)?;
    Ok(crate::t!("snappy.ask.rename_file", file = file, printer = p.name, name = str_arg(args, "name")?))
}

pub fn rename(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    let new_path = block_on(crate::pf_rename(p.id, f.path, str_arg(args, "name")?.to_string())).map_err(|e| anyhow!(e))?;
    Ok(json!({ "renamed": new_path.rsplit('/').next().unwrap_or_default() }))
}

pub fn download_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string" },
            "file": { "type": "string", "description": "Its name, from printer_files, or from timelapses with `timelapse`." },
            "timelapse": { "type": "boolean", "description": "A timelapse video rather than a print file." },
        },
        "required": ["printer", "file"],
    })
}

/// The file asked: a print file, or a timelapse video.
fn download_file(args: &Value) -> Result<(crate::printers::Printer, crate::printer_files::RemoteFile)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let name = str_arg(args, "file")?;
    if !args["timelapse"].as_bool().unwrap_or(false) {
        let f = printer_file(&p, name)?;
        return Ok((p, f));
    }
    let v = block_on(crate::pf_videos(p.id.clone())).map_err(|e| anyhow!(e))?;
    let f = v
        .into_iter()
        .find(|f| f.path.rsplit('/').next() == Some(name))
        .ok_or_else(|| anyhow!("no timelapse named “{name}” on {}", p.name))?;
    Ok((p, f))
}

pub fn ask_download(args: &Value) -> Result<String> {
    let (p, _) = download_file(args)?;
    Ok(crate::t!("snappy.ask.download_file", file = str_arg(args, "file")?, printer = p.name))
}

/// To the user's Downloads folder, as Printer files' Download does.
pub fn download(args: &Value) -> Result<Value> {
    let (p, f) = download_file(args)?;
    let saved = block_on(crate::pf_download(p.id, f.root, vec![f.path], None)).map_err(|e| anyhow!(e))?;
    Ok(json!({ "downloaded": saved.len() }))
}

// ------------------------------------------------------------ bed mesh and maintenance

/// The meshes kept for a printer, newest first, each summed up: when, its
/// profile, how flat (the spread between its highest and lowest points).
pub fn bed_mesh(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let mut list: Vec<Value> = crate::bed_mesh_history(p.id.clone())
        .into_iter()
        .map(|m| {
            let z = m.points.iter().flatten().copied();
            let (lo, hi) = z.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(v), b.max(v)));
            json!({ "at": m.at, "profile": m.profile, "spread_mm": ((hi - lo) * 1000.0).round() / 1000.0, "partial": m.partial, "by_app": m.by_app })
        })
        .collect();
    list.reverse();
    Ok(json!({ "printer": p.name, "meshes": list }))
}

pub fn bed_mesh_action_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string" },
            "action": { "type": "string", "enum": ["measure", "stop", "abort", "keep", "remove"] },
            "temp": { "type": "number", "description": "measure: the bed temperature, °C (60 by default)." },
            "count": { "type": "integer", "description": "keep: how many of the newest meshes to keep." },
            "at": { "type": "integer", "description": "remove: the mesh's `at`, from bed_mesh." },
        },
        "required": ["printer", "action"],
    })
}

pub fn ask_bed_mesh_action(args: &Value) -> Result<String> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let a = str_arg(args, "action")?;
    Ok(match a {
        "measure" => crate::t!("snappy.ask.mesh_measure", printer = p.name, temp = args["temp"].as_f64().unwrap_or(60.0)),
        "stop" | "abort" => crate::t!(&format!("snappy.ask.mesh_{a}"), printer = p.name),
        "keep" => {
            crate::t!("snappy.ask.mesh_keep", printer = p.name, n = args["count"].as_u64().ok_or_else(|| anyhow!("keep needs `count`"))?)
        }
        "remove" => crate::t!(
            "snappy.ask.mesh_remove",
            printer = p.name,
            date = ymd(args["at"].as_u64().ok_or_else(|| anyhow!("remove needs `at`"))?)
        ),
        _ => return Err(anyhow!("invalid action: {a}")),
    })
}

/// A Unix time as its UTC day, "2026-11-06", for a card (Howard Hinnant's
/// civil-from-days).
fn ymd(at: u64) -> String {
    let z = (at / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Measuring takes minutes: it answers with a task id.
pub fn bed_mesh_action(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let e = |e: String| anyhow!(e);
    match str_arg(args, "action")? {
        "measure" => {
            let temp = args["temp"].as_f64().unwrap_or(60.0);
            let (id, name) = (p.id.clone(), p.name.clone());
            Ok(crate::snappy_tools::spawn_task(format!("bed mesh on {name}"), async move {
                crate::bed_mesh_measure(id, temp).await.map(|_| json!({ "measured": true }))
            }))
        }
        "stop" => block_on(crate::bed_mesh_stop(p.id)).map(|_| json!({ "stopped": true })).map_err(e),
        "abort" => block_on(crate::bed_mesh_abort(p.id)).map(|_| json!({ "aborted": true })).map_err(e),
        "keep" => crate::bed_mesh_keep(p.id, args["count"].as_u64().unwrap_or(0) as usize).map(|l| json!({ "kept": l.len() })).map_err(e),
        "remove" => crate::bed_mesh_remove(p.id, args["at"].as_u64().unwrap_or(0)).map(|l| json!({ "left": l.len() })).map_err(e),
        a => Err(anyhow!("invalid action: {a}")),
    }
}

/// Maintenance tasks: the same ids as `ui/maint.js` MT_TASKS (a second list,
/// for the tool's schema; the page holds their intervals).
const MAINT_TASKS: [&str; 6] = ["contacts", "docking", "rails", "zscrews", "nozzles", "plate"];

pub fn maintenance_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string" },
            "action": { "type": "string", "enum": ["done", "remove"] },
            "task": { "type": "string", "enum": MAINT_TASKS },
            "at": { "type": "integer", "description": "remove: the log entry's `at`, from printer_details." },
        },
        "required": ["printer", "action", "task"],
    })
}

fn maint_of(args: &Value) -> Result<(crate::printers::Printer, &str, &str)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let task = str_arg(args, "task")?;
    if !MAINT_TASKS.contains(&task) {
        return Err(anyhow!("unknown task: {task}"));
    }
    let action = str_arg(args, "action")?;
    if !matches!(action, "done" | "remove") {
        return Err(anyhow!("invalid action: {action}"));
    }
    Ok((p, task, action))
}

pub fn ask_maintenance(args: &Value) -> Result<String> {
    let (p, task, action) = maint_of(args)?;
    Ok(crate::t!(&format!("snappy.ask.maint_{action}"), printer = p.name, task = crate::t!(&format!("maint.t.{task}"))))
}

/// Logged done with the printer's counters now, as Maintenance does.
pub fn maintenance(args: &Value) -> Result<Value> {
    let (p, task, action) = maint_of(args)?;
    let e = |e: String| anyhow!(e);
    if action == "remove" {
        let at = args["at"].as_u64().ok_or_else(|| anyhow!("remove needs `at`"))?;
        return crate::maintenance_remove(p.id, task.into(), at).map(|l| json!({ "entries": l.len() })).map_err(e);
    }
    let u = block_on(crate::printer_maintenance(p.host.clone(), p.port)).map_err(e)?;
    let swaps = u.heads.iter().map(|h| h.switch_count).collect();
    crate::maintenance_done(p.id, task.into(), u.print_hours, swaps).map(|l| json!({ "entries": l.len() })).map_err(e)
}

// ------------------------------------------------------------ prints

pub fn history_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["requeue", "result", "dismiss"] },
            "job": { "type": "string", "description": "requeue, result: the print's id, from print_queue." },
            "success": { "type": "boolean", "description": "result: whether it came out well." },
            "note": { "type": "string", "description": "result: a note, optional." },
            "printer": { "type": "string", "description": "dismiss: the printer whose queue reminder to hide." },
        },
        "required": ["action"],
    })
}

pub fn ask_history(args: &Value) -> Result<String> {
    match str_arg(args, "action")? {
        "requeue" => Ok(crate::t!("snappy.ask.hist_requeue", name = job_of(args)?.0.name)),
        "result" => {
            let ok = args["success"].as_bool().ok_or_else(|| anyhow!("result needs `success`"))?;
            Ok(crate::t!(if ok { "snappy.ask.hist_ok" } else { "snappy.ask.hist_failed" }, name = job_of(args)?.0.name))
        }
        "dismiss" => Ok(crate::t!("snappy.ask.hist_dismiss", printer = printer_named(str_arg(args, "printer")?)?.name)),
        a => Err(anyhow!("invalid action: {a}")),
    }
}

pub fn history(args: &Value) -> Result<Value> {
    let e = |e: String| anyhow!(e);
    match str_arg(args, "action")? {
        "requeue" => {
            let (job, _) = job_of(args)?;
            block_on(crate::job_requeue(app()?, job.id)).map(|j| json!({ "queued": j.name })).map_err(e)
        }
        "result" => {
            let (job, _) = job_of(args)?;
            let result = crate::jobs::PrintResult {
                success: args["success"].as_bool(),
                reason: None,
                note: args["note"].as_str().unwrap_or_default().to_string(),
                at: 0,
            };
            crate::job_set_result(job.id, Some(result)).map(|_| json!({ "noted": job.name })).map_err(e)
        }
        "dismiss" => {
            crate::queue_dismiss(printer_named(str_arg(args, "printer")?)?.id);
            Ok(json!({ "dismissed": true }))
        }
        a => Err(anyhow!("invalid action: {a}")),
    }
}

/// A printer's timelapse videos, newest first.
pub fn timelapses(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let mut v = block_on(crate::pf_videos(p.id)).map_err(|e| anyhow!(e))?;
    v.sort_by(|a, b| b.modified.total_cmp(&a.modified));
    let list: Vec<Value> = v
        .iter()
        .map(|f| json!({ "name": f.path.rsplit('/').next().unwrap_or_default(), "size": f.size, "modified": f.modified as u64 }))
        .collect();
    Ok(json!({ "printer": p.name, "videos": list }))
}

// ------------------------------------------------------------ the queue

fn job_of(args: &Value) -> Result<(crate::jobs::Job, String)> {
    let id = str_arg(args, "job")?;
    let job = crate::jobs::get(id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
    let printer = crate::printers::load().into_iter().find(|p| p.id == job.printer_id).map(|p| p.name).unwrap_or_default();
    Ok((job, printer))
}

pub fn queue_move_params() -> Value {
    json!({
        "type": "object",
        "properties": { "job": { "type": "string", "description": "From print_queue." }, "delta": { "type": "integer", "description": "Places to move: negative is earlier." } },
        "required": ["job", "delta"],
    })
}

pub fn ask_queue_move(args: &Value) -> Result<String> {
    let (job, printer) = job_of(args)?;
    let delta = args["delta"].as_i64().filter(|d| *d != 0).ok_or_else(|| anyhow!("`delta` must be a non-zero integer"))?;
    Ok(crate::t!(
        if delta < 0 { "snappy.ask.queue_up" } else { "snappy.ask.queue_down" },
        name = job.name,
        printer = printer,
        n = delta.abs()
    ))
}

pub fn queue_move(args: &Value) -> Result<Value> {
    let (job, _) = job_of(args)?;
    let delta = args["delta"].as_i64().unwrap_or(0) as i32;
    crate::job_move(app()?, job.id, delta).map_err(|e| anyhow!(e))?;
    Ok(json!({ "moved": delta }))
}

pub fn job_only() -> Value {
    json!({ "type": "object", "properties": { "job": { "type": "string", "description": "From print_queue." } }, "required": ["job"] })
}

pub fn ask_queue_remove(args: &Value) -> Result<String> {
    let (job, printer) = job_of(args)?;
    Ok(crate::t!("snappy.ask.queue_remove", name = job.name, printer = printer))
}

pub fn queue_remove(args: &Value) -> Result<Value> {
    let (job, _) = job_of(args)?;
    crate::job_remove(app()?, job.id).map_err(|e| anyhow!(e))?;
    Ok(json!({ "removed": job.name }))
}

pub fn queue_edit_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "job": { "type": "string" },
            "printer": { "type": "string", "description": "Another printer for it (optional)." },
            "bed_leveling": { "type": "boolean" },
            "flow_calibration": { "type": "boolean" },
            "timelapse": { "type": "boolean" },
        },
        "required": ["job"],
    })
}

/// The printer and options asked, the job's own for what is not given.
fn queue_edit_of(args: &Value) -> Result<(crate::jobs::Job, crate::printers::Printer, crate::printers::StartOptions)> {
    let (job, _) = job_of(args)?;
    let printer = match args["printer"].as_str() {
        Some(name) => printer_named(name)?,
        None => {
            crate::printers::load().into_iter().find(|p| p.id == job.printer_id).ok_or_else(|| anyhow!(crate::t!("err.unknown_printer")))?
        }
    };
    let flag = |k: &str, d: bool| args[k].as_bool().unwrap_or(d);
    let o = &job.options;
    let options = crate::printers::StartOptions {
        bed_leveling: flag("bed_leveling", o.bed_leveling),
        flow_calibration: flag("flow_calibration", o.flow_calibration),
        timelapse: flag("timelapse", o.timelapse),
    };
    Ok((job, printer, options))
}

pub fn ask_queue_edit(args: &Value) -> Result<String> {
    let (job, p, o) = queue_edit_of(args)?;
    let yn = |b: bool| crate::t!(if b { "snappy.ask.on" } else { "snappy.ask.off" });
    Ok(crate::t!(
        "snappy.ask.queue_edit",
        name = job.name,
        printer = p.name,
        level = yn(o.bed_leveling),
        flow = yn(o.flow_calibration),
        timelapse = yn(o.timelapse)
    ))
}

pub fn queue_edit(args: &Value) -> Result<Value> {
    let (job, p, o) = queue_edit_of(args)?;
    crate::job_edit(app()?, job.id, Some(p.id), Some(o)).map_err(|e| anyhow!(e))?;
    Ok(json!({ "changed": job.name }))
}

// ------------------------------------------------------------ Create

/// Create's conversations: title, object, when, mode. The id names one.
pub fn create_list(_: &Value) -> Result<Value> {
    let list: Vec<Value> = crate::ia_list()
        .into_iter()
        .map(|c| json!({ "id": c.id, "title": c.title, "object": c.source_name, "updated_at": c.updated_at, "mode": c.engine }))
        .collect();
    Ok(json!({ "conversations": list }))
}

fn conversation(args: &Value) -> Result<crate::ia::Conversation> {
    let id = str_arg(args, "conversation")?;
    crate::ia_list().into_iter().find(|c| c.id == id || c.title == id).ok_or_else(|| anyhow!("no Create conversation “{id}”"))
}

pub fn create_send_params() -> Value {
    json!({
        "type": "object",
        "properties": { "conversation": { "type": "string", "description": "Its id or title, from create_list." }, "text": { "type": "string" } },
        "required": ["conversation", "text"],
    })
}

pub fn ask_create_send(args: &Value) -> Result<String> {
    let c = conversation(args)?;
    Ok(crate::t!("snappy.ask.create_send", title = c.title, text = str_arg(args, "text")?))
}

/// The message goes to that object's Claude, as typed in its conversation.
pub fn create_send(args: &Value) -> Result<Value> {
    let c = conversation(args)?;
    block_on(crate::ia_chat_send(app()?, c.id, str_arg(args, "text")?.to_string(), Vec::new(), None)).map_err(|e| anyhow!(e))?;
    Ok(json!({ "sent": c.title }))
}

pub fn create_open_params() -> Value {
    json!({ "type": "object", "properties": { "conversation": { "type": "string", "description": "Its id or title." } }, "required": ["conversation"] })
}

pub fn create_open(args: &Value) -> Result<Value> {
    let c = conversation(args)?;
    ui_call("create_open", json!({ "id": c.id }))
}

pub fn create_new_params() -> Value {
    json!({
        "type": "object",
        "properties": { "prompt": { "type": "string", "description": "What to model, in the user's words." } },
        "required": ["prompt"],
    })
}

pub fn ask_create_new(args: &Value) -> Result<String> {
    Ok(crate::t!("snappy.ask.create_new", prompt = str_arg(args, "prompt")?))
}

/// As Create's New object sheet does, with its defaults (mode, model,
/// folder, bed size).
pub fn create_new(args: &Value) -> Result<Value> {
    ui_call_within("create_new", json!({ "prompt": str_arg(args, "prompt")? }), SHEET_TIMEOUT)
}

/// A conversation's saved versions: number, when, size.
pub fn create_versions(args: &Value) -> Result<Value> {
    let c = conversation(args)?;
    Ok(json!({ "conversation": c.title, "versions": crate::ia_versions(c.id) }))
}

pub fn create_manage_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "conversation": { "type": "string", "description": "Its id or title, from create_list." },
            "action": { "type": "string", "enum": ["rename", "duplicate", "delete", "revert", "stop", "model"] },
            "title": { "type": "string", "description": "rename: the new title." },
            "version": { "type": "integer", "description": "revert: the version's number, from create_versions." },
            "model": { "type": "string", "description": "model: a Claude model id, or empty for the account's default." },
        },
        "required": ["conversation", "action"],
    })
}

pub fn ask_create_manage(args: &Value) -> Result<String> {
    let c = conversation(args)?;
    let a = str_arg(args, "action")?;
    Ok(match a {
        "rename" => crate::t!("snappy.ask.create_rename", title = c.title, name = str_arg(args, "title")?),
        "revert" => crate::t!(
            "snappy.ask.create_revert",
            title = c.title,
            n = args["version"].as_u64().ok_or_else(|| anyhow!("revert needs `version`"))?
        ),
        "model" => crate::t!(
            "snappy.ask.create_model",
            title = c.title,
            model = args["model"].as_str().filter(|m| !m.is_empty()).unwrap_or("default")
        ),
        "duplicate" | "delete" | "stop" => crate::t!(&format!("snappy.ask.create_{a}"), title = c.title),
        _ => return Err(anyhow!("invalid action: {a}")),
    })
}

pub fn create_manage(args: &Value) -> Result<Value> {
    let c = conversation(args)?;
    let e = |e: String| anyhow!(e);
    let r = match str_arg(args, "action")? {
        "rename" => crate::ia_rename(c.id, str_arg(args, "title")?.into()).map(|x| json!({ "renamed": x.title })).map_err(e)?,
        "duplicate" => block_on(crate::ia_duplicate(c.id)).map(|x| json!({ "copy": x.title })).map_err(e)?,
        "delete" => block_on(crate::ia_delete(c.id)).map(|_| json!({ "deleted": c.title })).map_err(e)?,
        "revert" => block_on(crate::ia_revert(c.id, args["version"].as_u64().unwrap_or(0) as u32))
            .map(|_| json!({ "reverted": true }))
            .map_err(e)?,
        "stop" => crate::ia_chat_stop(c.id).map(|_| json!({ "stopped": true })).map_err(e)?,
        "model" => {
            let m = args["model"].as_str().filter(|m| !m.is_empty()).map(String::from);
            block_on(crate::ia_chat_model(c.id, m)).map(|_| json!({ "model": true })).map_err(e)?
        }
        a => return Err(anyhow!("invalid action: {a}")),
    };
    // Create's list shows the change.
    let _ = ui_call("create_refresh", json!({}));
    Ok(r)
}

// ------------------------------------------------------------ Explore

pub fn explore_state(_: &Value) -> Result<Value> {
    let favorites: Vec<Value> = crate::fav_list().into_iter().map(|f| json!({ "id": f.id, "title": f.title, "site": f.site })).collect();
    let page = ui_call("explore_state", json!({}))?;
    Ok(json!({ "sites": page["sites"], "tabs": page["tabs"], "shown": page["shown"], "favorites": favorites }))
}

pub fn explore_open_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "site": { "type": "string", "description": "A site of explore_state's sites, by name." },
            "favorite": { "type": "string", "description": "A favorite, by its id or title." },
            "url": { "type": "string", "description": "A web address the user gave." },
        },
    })
}

/// Shows a site, a favorite or an address in Explore (one of them).
pub fn explore_open(args: &Value) -> Result<Value> {
    let url = match args["favorite"].as_str() {
        Some(f) => Some(
            crate::fav_list().into_iter().find(|x| x.id == f || x.title == f).map(|x| x.url).ok_or_else(|| anyhow!("no favorite “{f}”"))?,
        ),
        None => args["url"].as_str().map(String::from),
    };
    ui_call("explore_open", json!({ "site": args["site"], "url": url }))
}

pub fn ask_fav_add(_: &Value) -> Result<String> {
    Ok(crate::t!("snappy.ask.fav_add"))
}

/// The page Explore shows, as its star does.
pub fn fav_add(_: &Value) -> Result<Value> {
    ui_call("explore_fav_add", json!({}))
}

pub fn fav_params() -> Value {
    json!({ "type": "object", "properties": { "favorite": { "type": "string", "description": "Its id or title." } }, "required": ["favorite"] })
}

fn favorite(args: &Value) -> Result<crate::favorites::Favorite> {
    let f = str_arg(args, "favorite")?;
    crate::fav_list().into_iter().find(|x| x.id == f || x.title == f).ok_or_else(|| anyhow!("no favorite “{f}”"))
}

pub fn ask_fav_remove(args: &Value) -> Result<String> {
    Ok(crate::t!("snappy.ask.fav_remove", title = favorite(args)?.title))
}

pub fn fav_remove(args: &Value) -> Result<Value> {
    let f = favorite(args)?;
    crate::fav_remove(f.id).map_err(|e| anyhow!(e))?;
    Ok(json!({ "removed": f.title }))
}

// ------------------------------------------------------------ the page's own

/// A tool the page answers and words: `<name>_check` gives the card's
/// text (and checks the arguments), `<name>` does it.
fn page_ask(method: &str, args: &Value) -> Result<String> {
    let v = ui_call(&format!("{method}_check"), args.clone())?;
    v["card"].as_str().map(String::from).ok_or_else(|| anyhow!("Snap Studio did not word this action"))
}

fn page_run(method: &str, args: &Value) -> Result<Value> {
    ui_call_within(method, args.clone(), SHEET_TIMEOUT)
}

pub fn plate_objects(_: &Value) -> Result<Value> {
    ui_call("plate_objects", json!({}))
}

pub fn plate_edit_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["arrange", "orient", "duplicate", "remove", "center", "reset_rotation", "split", "put_on_bed", "move", "rotate", "scale", "set_head", "colours_by", "tower"],
            },
            "by": { "type": "string", "enum": ["object", "colour"], "description": "colours_by: heads chosen per object, or once per colour for the whole plate." },
            "on": { "type": "boolean", "description": "tower: the prime tower on or off." },
            "objects": { "type": "array", "items": { "type": "integer" }, "description": "Ids from plate_objects; omitted: every object (arrange, orient, remove: the whole plate)." },
            "dx": { "type": "number", "description": "move: mm along X." },
            "dy": { "type": "number", "description": "move: mm along Y." },
            "rotation": { "type": "array", "items": { "type": "number" }, "description": "rotate: [x, y, z] in degrees." },
            "scale": { "type": "number", "description": "scale: percent, 100 = as is." },
            "color": { "type": "integer", "description": "set_head: the object's color, from 0, as plate_objects lists them." },
            "head": { "type": "integer", "description": "set_head: the head, from 0." },
        },
        "required": ["action"],
    })
}

pub fn ask_plate_edit(args: &Value) -> Result<String> {
    page_ask("plate_edit", args)
}

pub fn plate_edit(args: &Value) -> Result<Value> {
    page_run("plate_edit", args)
}

pub fn plate_add_params() -> Value {
    json!({ "type": "object", "properties": { "file": { "type": "string", "description": "Its name, as local_files lists it." } }, "required": ["file"] })
}

pub fn ask_plate_add(args: &Value) -> Result<String> {
    page_ask("plate_add", args)
}

pub fn plate_add(args: &Value) -> Result<Value> {
    page_run("plate_add", args)
}

/// The Files view's folders, by name (the sidebar's).
pub fn files_folders(_: &Value) -> Result<Value> {
    ui_call("files_folders", json!({}))
}

pub fn folder_params() -> Value {
    json!({ "type": "object", "properties": { "folder": { "type": "string", "description": "Its name, from files_folders." } }, "required": ["folder"] })
}

pub fn files_open_folder(args: &Value) -> Result<Value> {
    page_run("files_open_folder", args)
}

pub fn settings_list(_: &Value) -> Result<Value> {
    ui_call("settings_list", json!({}))
}

pub fn settings_set_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "setting": { "type": "string", "description": "Its key, from settings_list." },
            "value": { "description": "A choice's value, a number, text, or true/false." },
        },
        "required": ["setting", "value"],
    })
}

pub fn ask_settings_set(args: &Value) -> Result<String> {
    page_ask("settings_set", args)
}

pub fn settings_set(args: &Value) -> Result<Value> {
    page_run("settings_set", args)
}

// ------------------------------------------------------------ more of the page's own

/// Tools the page answers whole: `<name>_check` words the card of those that
/// change something, `<name>` does it.
macro_rules! page_tool {
    ($run:ident, $ask:ident, $method:literal) => {
        pub fn $ask(args: &Value) -> Result<String> {
            page_ask($method, args)
        }
        pub fn $run(args: &Value) -> Result<Value> {
            page_run($method, args)
        }
    };
    ($run:ident, $method:literal) => {
        pub fn $run(args: &Value) -> Result<Value> {
            page_run($method, args)
        }
    };
}

page_tool!(app_action, ask_app_action, "app_action");
page_tool!(printer_manage, ask_printer_manage, "printer_manage");
page_tool!(slice_save_profile, ask_slice_save_profile, "slice_save_profile");
page_tool!(preview_action, ask_preview_action, "preview_action");
page_tool!(local_file_ai, ask_local_file_ai, "local_file_ai");
page_tool!(explore_site, ask_explore_site, "explore_site");
page_tool!(printers_discover, "printers_discover");
page_tool!(printer_open, "printer_open");
page_tool!(local_file_open, "local_file_open");
page_tool!(files_view, "files_view");
page_tool!(explore_tab, "explore_tab");

pub fn app_action_params() -> Value {
    json!({
        "type": "object",
        "properties": { "action": { "type": "string", "enum": ["check_update", "install_update", "welcome", "recheck_ai", "clear_cache", "reset_display", "engine_install", "engine_remove"] } },
        "required": ["action"],
    })
}

pub fn printer_manage_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["add", "rename", "model", "remove"] },
            "found": { "type": "string", "description": "add: a printer's name from printers_discover." },
            "printer": { "type": "string", "description": "rename, model, remove: a saved printer's display name." },
            "name": { "type": "string", "description": "add (optional), rename: the display name." },
            "model": { "type": "string", "description": "model: the printer's model, as printers_discover or printers name them." },
        },
        "required": ["action"],
    })
}

pub fn printer_open_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string" },
            "tab": { "type": "string", "enum": ["status", "control", "files", "bed_mesh", "maintenance"], "description": "Which of its pages (status by default)." },
            "camera": { "type": "string", "enum": ["on", "off", "pin"], "description": "Its camera, optional." },
        },
        "required": ["printer"],
    })
}

pub fn name_params() -> Value {
    json!({ "type": "object", "properties": { "name": { "type": "string", "description": "The new profile's name." } }, "required": ["name"] })
}

pub fn preview_params() -> Value {
    json!({ "type": "object", "properties": { "action": { "type": "string", "enum": ["save", "edit", "close"] } }, "required": ["action"] })
}

pub fn local_file_open_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "file": { "type": "string", "description": "Its name, as local_files lists it." },
            "action": { "type": "string", "enum": ["reveal", "open", "analyze"], "description": "Show it in the system's file manager, open it with its app, or read its size and triangles." },
        },
        "required": ["file", "action"],
    })
}

pub fn local_file_ai_params() -> Value {
    json!({
        "type": "object",
        "properties": { "file": { "type": "string", "description": "A 3MF or STL, as local_files lists it." }, "prompt": { "type": "string", "description": "What to change, in the user's words." } },
        "required": ["file", "prompt"],
    })
}

pub fn files_view_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sort": { "type": "string", "enum": ["name", "date", "size", "time", "weight", "folder"] },
            "descending": { "type": "boolean" },
            "search": { "type": "string", "description": "Text the names must hold; empty clears it." },
        },
    })
}

pub fn explore_tab_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["back", "forward", "reload", "close", "browser"], "description": "browser: open the page in the system's browser." },
            "tab": { "type": "string", "description": "Its title, from explore_state; the one shown by default." },
        },
        "required": ["action"],
    })
}

pub fn explore_site_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["logout", "pin", "unpin"], "description": "logout: sign out of the site (its cookies only); pin: keep it in the sidebar." },
            "site": { "type": "string", "description": "A site's name, from explore_state." },
        },
        "required": ["action", "site"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every action Snappy may take is one of Control's, worded for its
    /// card; the emergency stop and the firmware restart stay the user's.
    #[test]
    fn control_actions_are_worded_and_bounded() {
        let samples = [
            json!({ "kind": "home", "axes": "xyz" }),
            json!({ "kind": "jog", "axis": "x", "dist": 10.0 }),
            json!({ "kind": "tool", "n": 1 }),
            json!({ "kind": "nozzle_temp", "n": 0, "temp": 210.0 }),
            json!({ "kind": "bed_temp", "temp": 60.0 }),
            json!({ "kind": "heaters_off" }),
            json!({ "kind": "load", "n": 0 }),
            json!({ "kind": "unload", "n": 0 }),
            json!({ "kind": "extrude", "n": 0 }),
            json!({ "kind": "retract", "n": 0 }),
            json!({ "kind": "clean" }),
            json!({ "kind": "purge_position" }),
            json!({ "kind": "part_fan", "pct": 50.0 }),
            json!({ "kind": "chamber_fan", "pct": 50.0 }),
            json!({ "kind": "purifier", "on": true }),
            json!({ "kind": "light", "on": false }),
            json!({ "kind": "motors_off" }),
            json!({ "kind": "filament", "n": 2, "vendor": "Generic", "material": "PLA", "sub_type": "", "color": "#ff0000" }),
        ];
        assert_eq!(samples.len(), CONTROL_KINDS.len());
        for s in samples {
            assert!(CONTROL_KINDS.contains(&s["kind"].as_str().unwrap()));
            let a: crate::control::Action = serde_json::from_value(s.clone()).unwrap();
            assert!(!control_words(&a).is_empty(), "{s}");
        }
        for kind in ["emergency_stop", "firmware_restart"] {
            assert!(!CONTROL_KINDS.contains(&kind));
        }
        assert!(control_words(&crate::control::Action::NozzleTemp { n: 1, temp: 215.0 }).contains("T1"));
    }

    #[test]
    fn days_are_worded() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_762_387_200), "2025-11-06");
        assert_eq!(ymd(951_782_400), "2000-02-29");
    }
}
