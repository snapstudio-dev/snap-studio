//! Tools over Prepare and slicing: the plate, the slice sheet and its
//! settings, slicing, sending a slice.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
    Tool {
        name: "slice_summary",
        description: "What Prepare holds now: the printer and presets chosen, the quick settings (layer height, infill, walls, supports, brim), and the last slice's estimates when there is one.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: slice_summary,
    },
    Tool {
        name: "open_slice_sheet",
        description: "Opens the slice sheet for what Prepare's plate holds (it goes to Prepare first). slice_options and slice_set work on the open sheet.",
        params: no_params,
        access: Access::Harmless,
        ask: None,
        run: open_slice_sheet,
    },
    Tool {
        name: "slice_options",
        description: "Every setting of the open slice sheet, as the user sees it: the printer; the nozzle profile (machine), quality profile (process: layer height and style) and plate (bed), each with its choices; the quick settings (infill, walls, speed, supports, brim) with their bounds; and each advanced setting that applies now, with its label, panel, level (basic or advanced), type, current value, the profile's value, its choices or unit.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: slice_options,
    },
    Tool {
        name: "slice_set",
        description: "Changes settings of the open slice sheet at once: `changes` maps keys of slice_options (machine, process, bed, infill, walls, speed, supports, brim, or an advanced setting's key) to their new value (a choice's value, a number, true or false). The user confirms the list of changes; the sheet then shows them, with an undo.",
        params: slice_set_params,
        access: Access::Write,
        ask: Some(ask_slice_set),
        run: slice_set,
    },
    Tool {
        name: "slice_run",
        description: "Slices the plate with the open sheet's settings, as its Slice button does; the preview opens when it is done. Only when the user asked to slice. The user confirms it. Answers with a task id; its result gives the estimates.",
        params: no_params,
        access: Access::Write,
        ask: Some(ask_slice_run),
        run: slice_run,
    },
    Tool {
        name: "send_slice",
        description: "Sends the slice just made in Prepare to a printer, to start now or to add to its queue. Before calling it, ask the user for each choice — the printer, start now or queue, bed leveling, flow calibration, timelapse — and never pick them yourself. The app's send sheet then shows the progress and checks the loaded spools. The user confirms it.",
        params: send_params,
        access: Access::Write,
        ask: Some(ask_send),
        run: send_slice,
    },
    Tool {
        name: "plate_objects",
        description: "Prepare's plate: each object's id, name, position and size in mm, rotation, scale, whether it is on the plate, and its colors with their heads.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: plate_objects,
    },
    Tool {
        name: "plate_edit",
        description: "Changes Prepare's plate as its tools do: arrange, orient, duplicate, remove, center, reset rotation, split, put back on the plate, move, rotate, scale, or set a color's head; on the objects given, or all. Prepare's undo takes it back. The user confirms it.",
        params: plate_edit_params,
        access: Access::Write,
        ask: Some(ask_plate_edit),
        run: plate_edit,
    },
    Tool {
        name: "plate_add",
        description: "Adds a file of the Files view to Prepare's plate. The user confirms it.",
        params: plate_add_params,
        access: Access::Write,
        ask: Some(ask_plate_add),
        run: plate_add,
    },
    Tool {
        name: "slice_save_profile",
        description: "Saves the open slice sheet's settings as a new quality profile, under the name given. The user confirms it.",
        params: name_params,
        access: Access::Write,
        ask: Some(ask_slice_save_profile),
        run: slice_save_profile,
    },
    Tool {
        name: "preview_action",
        description: "On the slice's preview: save the G-code next to the models, go back to Prepare to edit the plate, or close it. The user confirms it.",
        params: preview_params,
        access: Access::Write,
        ask: Some(ask_preview_action),
        run: preview_action,
    },
    Tool {
        name: "plate_view",
        description: "A picture of Prepare's plate as its 3D view shows it, with the objects' names: to judge an arrangement or an orientation.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: crate::snappy_eyes::plate_view,
    },
];

pub(crate) fn slice_summary(_: &Value) -> Result<Value> {
    ui_call("slice_summary", json!({}))
}

pub(crate) fn open_slice_sheet(_: &Value) -> Result<Value> {
    ui_call_within("open_slice_sheet", json!({}), SHEET_TIMEOUT)
}

pub(crate) fn slice_options(_: &Value) -> Result<Value> {
    ui_call("slice_options", json!({}))
}

pub(crate) fn slice_set_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "changes": {
                "type": "object",
                "description": "Setting key → new value, keys and choices as slice_options gives them.",
                "additionalProperties": true,
            },
        },
        "required": ["changes"],
    })
}

/// The changes checked by the sheet, one line each ("label: before → after").
pub(crate) fn ask_slice_set(args: &Value) -> Result<String> {
    let v = ui_call("slice_check", json!({ "changes": args["changes"] }))?;
    let lines: Vec<&str> = v["lines"].as_array().into_iter().flatten().filter_map(|l| l.as_str()).collect();
    if lines.is_empty() {
        return Err(anyhow!("no change to make"));
    }
    Ok(format!("{}\n{}", crate::t!("snappy.ask.slice_set"), lines.join("\n")))
}

pub(crate) fn slice_set(args: &Value) -> Result<Value> {
    ui_call_within("slice_set", json!({ "changes": args["changes"] }), SHEET_TIMEOUT)
}

pub(crate) fn ask_slice_run(_: &Value) -> Result<String> {
    Ok(crate::t!("snappy.ask.slice_run"))
}

pub(crate) fn slice_run(_: &Value) -> Result<Value> {
    Ok(spawn_task(crate::t!("snappy.task.slice"), Cancel::Call(stop_slice), async {
        tauri::async_runtime::spawn_blocking(|| ui_call_within("slice_run", json!({}), SLICE_TIMEOUT))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }))
}

/// Stops the slice running, as the sheet's Stop does.
fn stop_slice() -> Result<()> {
    ui_call("slice_stop", json!({})).map(|_| ())
}

pub(crate) fn send_params() -> Value {
    let flag = |d: &str| json!({ "type": "boolean", "description": d });
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string", "description": "The printer's display name, as the user chose it." },
            "queue": flag("true: add to the printer's queue; false: start now (the bed must be clear)."),
            "bed_leveling": flag("Automatic bed leveling before the print, as the user chose."),
            "flow_calibration": flag("Extrusion flow calibration before the print, as the user chose."),
            "timelapse": flag("Timelapse camera, as the user chose."),
        },
        "required": ["printer", "queue", "bed_leveling", "flow_calibration", "timelapse"],
    })
}

/// The choices of a send, all required: Snappy asks the user, never guesses.
pub(crate) fn send_choices(args: &Value) -> Result<(crate::printers::Printer, bool, crate::printers::StartOptions)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let flag = |k: &str| args[k].as_bool().ok_or_else(|| anyhow!("missing `{k}`: ask the user"));
    let options = crate::printers::StartOptions {
        bed_leveling: flag("bed_leveling")?,
        flow_calibration: flag("flow_calibration")?,
        timelapse: flag("timelapse")?,
    };
    Ok((p, flag("queue")?, options))
}

pub(crate) fn ask_send(args: &Value) -> Result<String> {
    let (p, queue, o) = send_choices(args)?;
    let yn = |b: bool| crate::t!(if b { "snappy.ask.on" } else { "snappy.ask.off" });
    Ok(crate::t!(
        if queue { "snappy.ask.send_queue" } else { "snappy.ask.send_now" },
        printer = p.name,
        level = yn(o.bed_leveling),
        flow = yn(o.flow_calibration),
        timelapse = yn(o.timelapse)
    ))
}

pub(crate) fn send_slice(args: &Value) -> Result<Value> {
    let (p, queue, o) = send_choices(args)?;
    // The send sheet does it, as by hand: printer check, spool check, upload.
    ui_call_within("send_slice", json!({ "printer": p.id, "queue": queue, "options": serde_json::to_value(o)? }), APPROVAL_TIMEOUT)
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

page_tool!(slice_save_profile, ask_slice_save_profile, "slice_save_profile");

page_tool!(preview_action, ask_preview_action, "preview_action");

pub fn name_params() -> Value {
    json!({ "type": "object", "properties": { "name": { "type": "string", "description": "The new profile's name." } }, "required": ["name"] })
}

pub fn preview_params() -> Value {
    json!({ "type": "object", "properties": { "action": { "type": "string", "enum": ["save", "edit", "close"] } }, "required": ["action"] })
}
