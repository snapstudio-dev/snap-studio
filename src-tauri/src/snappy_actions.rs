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

pub fn file_params() -> Value {
    json!({
        "type": "object",
        "properties": { "printer": { "type": "string" }, "file": { "type": "string", "description": "Its name, from printer_files." } },
        "required": ["printer", "file"],
    })
}

pub fn ask_download(args: &Value) -> Result<String> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let file = str_arg(args, "file")?;
    printer_file(&p, file)?;
    Ok(crate::t!("snappy.ask.download_file", file = file, printer = p.name))
}

/// To the user's Downloads folder, as Printer files' Download does.
pub fn download(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let f = printer_file(&p, str_arg(args, "file")?)?;
    let saved = block_on(crate::pf_download(p.id, "gcodes".into(), vec![f.path], None)).map_err(|e| anyhow!(e))?;
    Ok(json!({ "downloaded": saved.len() }))
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
                "enum": ["arrange", "orient", "duplicate", "remove", "center", "reset_rotation", "split", "put_on_bed", "move", "rotate", "scale", "set_head"],
            },
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
}
