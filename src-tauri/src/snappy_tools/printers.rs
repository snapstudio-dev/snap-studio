//! Tools over the printers: their state and controls, their files and
//! timelapses, bed mesh and maintenance, the camera.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
    Tool {
        name: "printers",
        description: "The user's printers by display name: model, whether online, state (standby, printing, paused…), the current print's progress and time left, temperatures, loaded filaments.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: printers,
    },
    Tool {
        name: "printer_files",
        description: "Print files stored on one printer, newest first: name, size, date, estimated time, filament.",
        params: printer_param,
        access: Access::Read,
        ask: None,
        run: printer_files,
    },
    Tool {
        name: "print_printer_file",
        description: "Starts printing a file already stored on a printer (names from printer_files). The user confirms it. Answers with a task id.",
        params: printer_file_params,
        access: Access::Write,
        ask: Some(ask_print_file),
        run: print_file,
    },
    Tool {
        name: "delete_printer_file",
        description: "Deletes a print file stored on a printer (names from printer_files). For a file on this computer, use delete_local_file. The user confirms it.",
        params: printer_file_params,
        access: Access::Write,
        ask: Some(ask_delete_file),
        run: delete_file,
    },
    Tool {
        name: "printer_details",
        description: "Control's view of one printer: temperatures and targets, positions, fans, the heads and their filaments, the light; and its maintenance log.",
        params: printer_details_params,
        access: Access::Read,
        ask: None,
        run: printer_details,
    },
    Tool {
        name: "printer_control",
        description: "One of Control's actions on a printer: home, move an axis, pick a head, set a nozzle or bed temperature, heaters off, load or unload or extrude or retract filament, clean the nozzle, purge position, fans, purifier, light, motors off, or declare a head's filament. Never during a print unless the user asks. The user confirms it.",
        params: printer_control_params,
        access: Access::Write,
        ask: Some(ask_printer_control),
        run: printer_control,
    },
    Tool {
        name: "print_control",
        description: "Pauses, resumes or cancels the print running on a printer. The user confirms it.",
        params: print_control_params,
        access: Access::Write,
        ask: Some(ask_print_control),
        run: print_control,
    },
    Tool {
        name: "rename_printer_file",
        description: "Renames a print file stored on a printer (names from printer_files). The user confirms it.",
        params: rename_params,
        access: Access::Write,
        ask: Some(ask_rename),
        run: rename,
    },
    Tool {
        name: "download_printer_file",
        description: "Downloads a print file, or a timelapse video (`timelapse`), from a printer to the user's Downloads folder. The user confirms it.",
        params: download_params,
        access: Access::Write,
        ask: Some(ask_download),
        run: download,
    },
    Tool {
        name: "printers_discover",
        description: "Searches the network for printers for a few seconds: their names and models, those not added yet. Never their addresses.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: printers_discover,
    },
    Tool {
        name: "printer_manage",
        description: "Adds a printer found by printers_discover, renames a printer, changes its model, or removes it from Snap Studio. The user confirms it.",
        params: printer_manage_params,
        access: Access::Write,
        ask: Some(ask_printer_manage),
        run: printer_manage,
    },
    Tool {
        name: "printer_open",
        description: "Shows one of a printer's pages (status, control, files, bed mesh, maintenance), and turns its camera on, off, or pins it over the app.",
        params: printer_open_params,
        access: Access::Harmless,
        ask: None,
        run: printer_open,
    },
    Tool {
        name: "bed_mesh",
        description: "A printer's bed meshes kept, newest first: when, profile, how flat (spread in mm).",
        params: printer_details_params,
        access: Access::Read,
        ask: None,
        run: bed_mesh,
    },
    Tool {
        name: "bed_mesh_action",
        description: "Measures a printer's bed (a task id answers; it heats the bed first), stops or aborts a measure, keeps only the newest meshes, or removes one. The user confirms it.",
        params: bed_mesh_action_params,
        access: Access::Write,
        ask: Some(ask_bed_mesh_action),
        run: bed_mesh_action,
    },
    Tool {
        name: "maintenance",
        description: "Logs a maintenance task as done now on a printer (with its counters), or removes a log entry made by mistake. The user confirms it.",
        params: maintenance_params,
        access: Access::Write,
        ask: Some(ask_maintenance),
        run: maintenance,
    },
    Tool {
        name: "timelapses",
        description: "A printer's timelapse videos, newest first: name, size, date. download_printer_file downloads one.",
        params: printer_details_params,
        access: Access::Read,
        ask: None,
        run: timelapses,
    },
    Tool {
        name: "camera_snapshot",
        description: "A picture of a printer's camera, now: to look at a print in progress, a failure, the bed. The user confirms it (it shows their workshop).",
        params: printer_param,
        access: Access::Write,
        ask: Some(crate::snappy_eyes::ask_camera),
        run: crate::snappy_eyes::camera,
    },
];

/// The printer and the file's path a card named: resolved once, at the
/// card, and kept for the run.
pub(crate) fn printer_and_file(args: &Value) -> Result<(crate::printers::Printer, String)> {
    if let Some(v) = take_resolved() {
        let p = crate::printers::load().into_iter().find(|p| p.id == v["printer"].as_str().unwrap_or_default());
        if let (Some(p), Some(path)) = (p, v["path"].as_str()) {
            return Ok((p, path.to_string()));
        }
    }
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    Ok((p, f.path))
}

pub(crate) fn ask_printer_file(args: &Value, key: &str) -> Result<String> {
    let (p, path) = printer_and_file(args)?;
    keep_resolved(json!({ "printer": p.id, "path": path }));
    Ok(crate::t!(key, file = base_name(&path), printer = p.name))
}

pub(crate) fn ask_print_file(args: &Value) -> Result<String> {
    ask_printer_file(args, "snappy.ask.print_file")
}

pub(crate) fn print_file(args: &Value) -> Result<Value> {
    let (p, path) = printer_and_file(args)?;
    let app = crate::snappy::app().ok_or_else(|| anyhow!("app not ready"))?.clone();
    let name = base_name(&path).to_string();
    let request = crate::PfPrintRequest {
        source_id: p.id.clone(),
        path,
        printer_id: p.id.clone(),
        options: crate::printers::StartOptions::default(),
        tools: Vec::new(),
        map: Vec::new(),
        queue: false,
    };
    Ok(spawn_task(format!("print “{name}” on {}", p.name), Cancel::Refuse(PRINT_STARTING), async move {
        crate::pf_print(app, request).await.map(|_| json!({ "started": true }))
    }))
}

pub(crate) fn ask_delete_file(args: &Value) -> Result<String> {
    ask_printer_file(args, "snappy.ask.delete_file")
}

pub(crate) fn delete_file(args: &Value) -> Result<Value> {
    let (p, path) = printer_and_file(args)?;
    let errors = block_on(crate::pf_delete(p.id.clone(), "gcodes".into(), vec![path.clone()])).map_err(|e| anyhow!(e))?;
    match errors.into_iter().next().flatten() {
        Some(e) => Err(anyhow!(e)),
        None => Ok(json!({ "deleted": base_name(&path), "printer": p.name })),
    }
}

pub fn printer_details_params() -> Value {
    printer_param()
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
pub(crate) const CONTROL_KINDS: [&str; 18] = [
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

pub(crate) fn control_action(args: &Value) -> Result<(crate::printers::Printer, crate::control::Action)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let kind = args["action"]["kind"].as_str().unwrap_or_default();
    if !CONTROL_KINDS.contains(&kind) {
        return Err(anyhow!("invalid action kind: {kind}"));
    }
    let action = serde_json::from_value(args["action"].clone()).map_err(|e| anyhow!("invalid action: {e}"))?;
    Ok((p, action))
}

/// The action in the user's words.
pub(crate) fn control_words(a: &crate::control::Action) -> String {
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

pub(crate) fn print_control_of(args: &Value) -> Result<(crate::printers::Printer, &str)> {
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

pub fn rename_params() -> Value {
    json!({
        "type": "object",
        "properties": { "printer": { "type": "string" }, "file": { "type": "string", "description": "Its name, from printer_files." }, "name": { "type": "string", "description": "The new name." } },
        "required": ["printer", "file", "name"],
    })
}

pub fn ask_rename(args: &Value) -> Result<String> {
    let (p, path) = printer_and_file(args)?;
    // The file the card names is the one renamed.
    keep_resolved(json!({ "printer": p.id, "path": path }));
    Ok(crate::t!("snappy.ask.rename_file", file = str_arg(args, "file")?, printer = p.name, name = str_arg(args, "name")?))
}

pub fn rename(args: &Value) -> Result<Value> {
    let (p, path) = printer_and_file(args)?;
    let new_path = block_on(crate::pf_rename(p.id, path, str_arg(args, "name")?.to_string())).map_err(|e| anyhow!(e))?;
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
pub(crate) fn download_file(args: &Value) -> Result<(crate::printers::Printer, crate::printer_files::RemoteFile)> {
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
    let (p, f) = download_file(args)?;
    // The file the card names is the one downloaded.
    keep_resolved(json!({ "printer": p.id, "root": f.root, "path": f.path }));
    Ok(crate::t!("snappy.ask.download_file", file = str_arg(args, "file")?, printer = p.name))
}

/// To the user's Downloads folder, as Printer files' Download does.
pub fn download(args: &Value) -> Result<Value> {
    let resolved = take_resolved().and_then(|v| {
        let p = crate::printers::load().into_iter().find(|p| p.id == v["printer"].as_str().unwrap_or_default())?;
        Some((p, v["root"].as_str()?.to_string(), v["path"].as_str()?.to_string()))
    });
    let (p, root, path) = match resolved {
        Some(r) => r,
        None => {
            let (p, f) = download_file(args)?;
            (p, f.root, f.path)
        }
    };
    let saved = block_on(crate::pf_download(p.id, root, vec![path], None)).map_err(|e| anyhow!(e))?;
    Ok(json!({ "downloaded": saved.len() }))
}

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
pub(crate) fn ymd(at: u64) -> String {
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
            Ok(crate::snappy_tools::spawn_task(format!("bed mesh on {name}"), Cancel::Refuse(BED_MESH_STOP), async move {
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
pub(crate) const MAINT_TASKS: [&str; 6] = ["contacts", "docking", "rails", "zscrews", "nozzles", "plate"];

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

pub(crate) fn maint_of(args: &Value) -> Result<(crate::printers::Printer, &str, &str)> {
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

page_tool!(printer_manage, ask_printer_manage, "printer_manage");

page_tool!(printers_discover, "printers_discover");

page_tool!(printer_open, "printer_open");

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

/// A measure stops through the printer, not by forgetting the task.
pub(crate) const BED_MESH_STOP: &str = "A bed mesh measure is stopped on the printer: use bed_mesh_action with stop or abort.";
