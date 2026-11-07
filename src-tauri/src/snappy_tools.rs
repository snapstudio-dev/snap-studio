//! Snappy's tools: a static table, each with its declaration (name,
//! description, parameters), what its confirmation card says, and its
//! handler in Rust. Served by `snappy_mcp.rs`.
//!
//! Reads, and Snappy's own notes, run at once. Every call that changes the
//! workshop waits for the user's confirmation. It is a barrier on this
//! side, not Claude's permission prompt: the call is held, a card shows at
//! the bottom of Snappy's drawer, and anything that is not an explicit yes
//! is a no: refused, the drawer closed (or not open), or no answer within
//! 15 minutes.
//!
//! Every result goes through the privacy filter. Long operations (starting
//! a print, which uploads it first) answer at once with a task id, which
//! Snappy follows or cancels.

use crate::privacy;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

/// How long an approval waits for the user.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long the UI has to answer a question about what it shows.
const UI_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the slice sheet may take to open or to apply changes (a new
/// nozzle profile reloads its lists).
pub(crate) const SHEET_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a slice may take.
const SLICE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    /// The parameters' JSON schema (`inputSchema`).
    pub params: fn() -> Value,
    pub access: Access,
    /// For a write: what the confirmation card says, the names resolved;
    /// also where the arguments are checked, before anyone is asked.
    pub ask: Option<fn(&Value) -> Result<String>>,
    pub run: fn(&Value) -> Result<Value>,
}

/// What a tool may do, which says whether the user confirms it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    /// Only reads: runs at once.
    Read,
    /// Changes only Snappy's own memory, what the screen shows, or asks
    /// the user: nothing of the workshop. Runs at once.
    Harmless,
    /// Changes the workshop: the user confirms it on a card.
    Write,
}

fn no_params() -> Value {
    json!({ "type": "object", "properties": {} })
}

pub static TOOLS: &[Tool] = &[
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
        name: "local_files",
        description: "Files shown in Snap Studio's Files view (the folder the user browses), by name.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: local_files,
    },
    Tool {
        name: "slice_summary",
        description: "What Prepare holds now: the printer and presets chosen, the quick settings (layer height, infill, walls, supports, brim), and the last slice's estimates when there is one.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: slice_summary,
    },
    Tool {
        name: "print_queue",
        description: "Known prints: queued, printing and past ones, with their printer, state and estimates. A queued print's id starts it with start_queued_print.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: print_queue,
    },
    Tool {
        name: "memory_read",
        description: "Your memory (MEMORY.md), as saved.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: memory_read,
    },
    Tool {
        name: "memory_write",
        description: "Replaces your memory (MEMORY.md) with `content`, Markdown, at most about 200 lines / 24 KB. Never serial numbers, addresses, hostnames or file paths.",
        params: memory_params,
        access: Access::Harmless,
        ask: None,
        run: memory_write,
    },
    Tool {
        name: "task_status",
        description: "State of a long operation started by another tool: running, done (with its result), failed (with why) or cancelled.",
        params: task_param,
        access: Access::Read,
        ask: None,
        run: task_status,
    },
    Tool {
        name: "task_cancel",
        description: "Cancels a long operation that is still running.",
        params: task_param,
        access: Access::Write,
        ask: Some(ask_task_cancel),
        run: task_cancel,
    },
    Tool {
        name: "ask_user",
        description: "Asks the user a question in the conversation and waits for the answer: up to 6 short options shown as buttons (the user may also type another answer). Use it for a choice the request leaves open, rather than guessing.",
        params: ask_user_params,
        access: Access::Harmless,
        ask: None,
        run: ask_user,
    },
    Tool {
        name: "open_view",
        description: "Shows one of Snap Studio's views: library (Explore), ia (Create), files, prepare, prints, settings.",
        params: view_params,
        access: Access::Harmless,
        ask: None,
        run: open_view,
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
        name: "start_queued_print",
        description: "Starts a queued print (by its id from print_queue) on its printer; the bed must be clear. The user confirms it. Answers with a task id.",
        params: job_param,
        access: Access::Write,
        ask: Some(ask_start_job),
        run: start_job,
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
        name: "send_slice",
        description: "Sends the slice just made in Prepare to a printer, to start now or to add to its queue. Before calling it, ask the user for each choice — the printer, start now or queue, bed leveling, flow calibration, timelapse — and never pick them yourself. The app's send sheet then shows the progress and checks the loaded spools. The user confirms it.",
        params: send_params,
        access: Access::Write,
        ask: Some(ask_send),
        run: send_slice,
    },
    Tool {
        name: "delete_local_file",
        description: "Moves a file of this computer to the Trash, by its name as local_files lists it (the Files view). For a file stored on a printer, use delete_printer_file. The user confirms it.",
        params: local_file_param,
        access: Access::Write,
        ask: Some(ask_delete_local),
        run: delete_local,
    },
    Tool {
        name: "printer_details",
        description: "Control's view of one printer: temperatures and targets, positions, fans, the heads and their filaments, the light; and its maintenance log.",
        params: crate::snappy_actions::printer_details_params,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::printer_details,
    },
    Tool {
        name: "printer_control",
        description: "One of Control's actions on a printer: home, move an axis, pick a head, set a nozzle or bed temperature, heaters off, load or unload or extrude or retract filament, clean the nozzle, purge position, fans, purifier, light, motors off, or declare a head's filament. Never during a print unless the user asks. The user confirms it.",
        params: crate::snappy_actions::printer_control_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_printer_control),
        run: crate::snappy_actions::printer_control,
    },
    Tool {
        name: "print_control",
        description: "Pauses, resumes or cancels the print running on a printer. The user confirms it.",
        params: crate::snappy_actions::print_control_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_print_control),
        run: crate::snappy_actions::print_control,
    },
    Tool {
        name: "rename_printer_file",
        description: "Renames a print file stored on a printer (names from printer_files). The user confirms it.",
        params: crate::snappy_actions::rename_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_rename),
        run: crate::snappy_actions::rename,
    },
    Tool {
        name: "download_printer_file",
        description: "Downloads a print file, or a timelapse video (`timelapse`), from a printer to the user's Downloads folder. The user confirms it.",
        params: crate::snappy_actions::download_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_download),
        run: crate::snappy_actions::download,
    },
    Tool {
        name: "queue_move",
        description: "Moves a queued print earlier or later in its printer's queue. The user confirms it.",
        params: crate::snappy_actions::queue_move_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_queue_move),
        run: crate::snappy_actions::queue_move,
    },
    Tool {
        name: "queue_remove",
        description: "Removes a print from the queue. The user confirms it.",
        params: crate::snappy_actions::job_only,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_queue_remove),
        run: crate::snappy_actions::queue_remove,
    },
    Tool {
        name: "queue_edit",
        description: "Changes a queued print's printer or its options (bed leveling, flow calibration, timelapse); what is not given stays. The user confirms it.",
        params: crate::snappy_actions::queue_edit_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_queue_edit),
        run: crate::snappy_actions::queue_edit,
    },
    Tool {
        name: "create_list",
        description: "Create's conversations (an object made or changed with the AI): id, title, object, last change, mode.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::create_list,
    },
    Tool {
        name: "create_open",
        description: "Shows one of Create's conversations.",
        params: crate::snappy_actions::create_open_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::create_open,
    },
    Tool {
        name: "create_send",
        description: "Sends a message to one of Create's conversations, as typed in it: that object's AI works on it. The user confirms it.",
        params: crate::snappy_actions::create_send_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_create_send),
        run: crate::snappy_actions::create_send,
    },
    Tool {
        name: "create_new",
        description: "Starts a new Create conversation that models an object from a description, with the New object sheet's defaults. The user confirms it.",
        params: crate::snappy_actions::create_new_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_create_new),
        run: crate::snappy_actions::create_new,
    },
    Tool {
        name: "explore_state",
        description: "Explore: the sites it offers, the open tabs (titles), the one shown, and the favorites.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::explore_state,
    },
    Tool {
        name: "explore_open",
        description: "Shows a site, a favorite or a web address in Explore.",
        params: crate::snappy_actions::explore_open_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::explore_open,
    },
    Tool {
        name: "favorite_add",
        description: "Adds the page Explore shows to the favorites. The user confirms it.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_fav_add),
        run: crate::snappy_actions::fav_add,
    },
    Tool {
        name: "favorite_remove",
        description: "Removes a favorite of Explore. The user confirms it.",
        params: crate::snappy_actions::fav_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_fav_remove),
        run: crate::snappy_actions::fav_remove,
    },
    Tool {
        name: "plate_objects",
        description: "Prepare's plate: each object's id, name, position and size in mm, rotation, scale, whether it is on the plate, and its colors with their heads.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::plate_objects,
    },
    Tool {
        name: "plate_edit",
        description: "Changes Prepare's plate as its tools do: arrange, orient, duplicate, remove, center, reset rotation, split, put back on the plate, move, rotate, scale, or set a color's head; on the objects given, or all. Prepare's undo takes it back. The user confirms it.",
        params: crate::snappy_actions::plate_edit_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_plate_edit),
        run: crate::snappy_actions::plate_edit,
    },
    Tool {
        name: "plate_add",
        description: "Adds a file of the Files view to Prepare's plate. The user confirms it.",
        params: crate::snappy_actions::plate_add_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_plate_add),
        run: crate::snappy_actions::plate_add,
    },
    Tool {
        name: "files_folders",
        description: "The folders of the Files view, by name: the one shown and the recent ones.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::files_folders,
    },
    Tool {
        name: "files_open_folder",
        description: "Shows one of the Files view's folders, by name.",
        params: crate::snappy_actions::folder_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::files_open_folder,
    },
    Tool {
        name: "settings_list",
        description: "Snap Studio's settings as Settings shows them: each one's key, label, section, current value and choices.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::settings_list,
    },
    Tool {
        name: "settings_set",
        description: "Changes one of Snap Studio's settings, as by hand in Settings. The user confirms it.",
        params: crate::snappy_actions::settings_set_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_settings_set),
        run: crate::snappy_actions::settings_set,
    },
    Tool {
        name: "app_action",
        description: "One of Snap Studio's own actions: check for an update, install the one found, open the welcome assistant again, check again what the AI needs, clear the thumbnail cache, reset the display settings, install or remove the slicing engine. The user confirms it.",
        params: crate::snappy_actions::app_action_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_app_action),
        run: crate::snappy_actions::app_action,
    },
    Tool {
        name: "printers_discover",
        description: "Searches the network for printers for a few seconds: their names and models, those not added yet. Never their addresses.",
        params: crate::snappy_actions::no_params_value,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::printers_discover,
    },
    Tool {
        name: "printer_manage",
        description: "Adds a printer found by printers_discover, renames a printer, changes its model, or removes it from Snap Studio. The user confirms it.",
        params: crate::snappy_actions::printer_manage_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_printer_manage),
        run: crate::snappy_actions::printer_manage,
    },
    Tool {
        name: "printer_open",
        description: "Shows one of a printer's pages (status, control, files, bed mesh, maintenance), and turns its camera on, off, or pins it over the app.",
        params: crate::snappy_actions::printer_open_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::printer_open,
    },
    Tool {
        name: "bed_mesh",
        description: "A printer's bed meshes kept, newest first: when, profile, how flat (spread in mm).",
        params: crate::snappy_actions::printer_details_params,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::bed_mesh,
    },
    Tool {
        name: "bed_mesh_action",
        description: "Measures a printer's bed (a task id answers; it heats the bed first), stops or aborts a measure, keeps only the newest meshes, or removes one. The user confirms it.",
        params: crate::snappy_actions::bed_mesh_action_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_bed_mesh_action),
        run: crate::snappy_actions::bed_mesh_action,
    },
    Tool {
        name: "maintenance",
        description: "Logs a maintenance task as done now on a printer (with its counters), or removes a log entry made by mistake. The user confirms it.",
        params: crate::snappy_actions::maintenance_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_maintenance),
        run: crate::snappy_actions::maintenance,
    },
    Tool {
        name: "print_history",
        description: "Puts a finished print back in the queue, notes how a print came out, or hides a printer's queue reminder. The user confirms it.",
        params: crate::snappy_actions::history_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_history),
        run: crate::snappy_actions::history,
    },
    Tool {
        name: "timelapses",
        description: "A printer's timelapse videos, newest first: name, size, date. download_printer_file downloads one.",
        params: crate::snappy_actions::printer_details_params,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::timelapses,
    },
    Tool {
        name: "slice_save_profile",
        description: "Saves the open slice sheet's settings as a new quality profile, under the name given. The user confirms it.",
        params: crate::snappy_actions::name_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_slice_save_profile),
        run: crate::snappy_actions::slice_save_profile,
    },
    Tool {
        name: "preview_action",
        description: "On the slice's preview: save the G-code next to the models, go back to Prepare to edit the plate, or close it. The user confirms it.",
        params: crate::snappy_actions::preview_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_preview_action),
        run: crate::snappy_actions::preview_action,
    },
    Tool {
        name: "local_file_open",
        description: "Shows a file of the Files view in the system's file manager, opens it with its app, or reads its size and triangle count.",
        params: crate::snappy_actions::local_file_open_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::local_file_open,
    },
    Tool {
        name: "local_file_ai",
        description: "Starts a Create conversation that changes a model of the Files view, as its Edit with AI does. The user confirms it.",
        params: crate::snappy_actions::local_file_ai_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_local_file_ai),
        run: crate::snappy_actions::local_file_ai,
    },
    Tool {
        name: "files_view",
        description: "Sorts the Files view, or filters it by a text in the names.",
        params: crate::snappy_actions::files_view_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::files_view,
    },
    Tool {
        name: "create_versions",
        description: "The saved versions of one of Create's objects: number, when, size.",
        params: crate::snappy_actions::create_open_params,
        access: Access::Read,
        ask: None,
        run: crate::snappy_actions::create_versions,
    },
    Tool {
        name: "create_manage",
        description: "On one of Create's conversations: rename, duplicate, delete, go back to a version, stop its answer, or choose its model. The user confirms it.",
        params: crate::snappy_actions::create_manage_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_create_manage),
        run: crate::snappy_actions::create_manage,
    },
    Tool {
        name: "explore_tab",
        description: "On a tab of Explore: back, forward, reload, close, or open its page in the system's browser.",
        params: crate::snappy_actions::explore_tab_params,
        access: Access::Harmless,
        ask: None,
        run: crate::snappy_actions::explore_tab,
    },
    Tool {
        name: "explore_site",
        description: "Signs out of a site of Explore (its cookies only), or pins it in the sidebar, or unpins it. The user confirms it.",
        params: crate::snappy_actions::explore_site_params,
        access: Access::Write,
        ask: Some(crate::snappy_actions::ask_explore_site),
        run: crate::snappy_actions::explore_site,
    },
];

pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

/// The tools as MCP lists them.
pub fn list() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": (t.params)(),
                "annotations": { "readOnlyHint": t.access == Access::Read, "destructiveHint": t.access == Access::Write },
            })
        })
        .collect()
}

thread_local! {
    /// What a card named, resolved when it was drawn (a printer's file, a
    /// local file's path): what the user approved is what runs, without
    /// asking the printer or the Files view again. The card and the run
    /// happen on the same thread, in `call`.
    static RESOLVED: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
}

fn keep_resolved(v: Value) {
    RESOLVED.with(|r| *r.borrow_mut() = Some(v));
}

fn take_resolved() -> Option<Value> {
    RESOLVED.with(|r| r.borrow_mut().take())
}

/// Runs a tool: checked, approved when it writes, its result filtered.
pub fn call(name: &str, args: &Value) -> Result<Value> {
    let tool = find(name).ok_or_else(|| anyhow!("unknown tool: {name}"))?;
    take_resolved();
    if let Some(ask) = tool.ask {
        let card = ask(args)?;
        if !approve(tool.name, &card) {
            return Err(anyhow!("The user did not approve this action ({card}). Nothing was done."));
        }
    }
    let out = (tool.run)(args)?;
    Ok(privacy::json(&out, &privacy::known()))
}

// ------------------------------------------------------------ approval

static DRAWER_OPEN: AtomicBool = AtomicBool::new(false);

fn approvals() -> &'static Mutex<HashMap<String, Sender<bool>>> {
    static A: OnceLock<Mutex<HashMap<String, Sender<bool>>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit(event: &str, payload: Value) {
    if let Some(app) = crate::snappy::app() {
        let _ = app.emit(event, payload);
    }
}

/// The drawer opened or closed: closing it refuses what was waiting.
pub fn set_drawer(open: bool) {
    DRAWER_OPEN.store(open, Ordering::SeqCst);
    if !open {
        refuse_all();
    }
}

/// Holds a call until the user answers its card. Only an explicit yes
/// passes.
fn approve(tool: &str, card: &str) -> bool {
    if !DRAWER_OPEN.load(Ordering::SeqCst) {
        return false;
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    approvals().lock().unwrap().insert(id.clone(), tx);
    emit("snappy-approval", json!({ "id": id, "tool": tool, "text": card }));
    let yes = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or(false);
    approvals().lock().unwrap().remove(&id);
    emit("snappy-approval-done", json!({ "id": id, "approved": yes }));
    yes
}

/// The cards waiting for an answer.
#[cfg(test)]
pub(crate) fn waiting() -> Vec<String> {
    approvals().lock().unwrap().keys().cloned().collect()
}

/// The user's answer to a card.
pub fn answer(id: &str, yes: bool) {
    if let Some(tx) = approvals().lock().unwrap().remove(id) {
        let _ = tx.send(yes);
    }
}

/// Refuses every call still waiting (drawer closed, Stop, Snappy ended),
/// and leaves every question unanswered.
pub fn refuse_all() {
    let waiting: Vec<Sender<bool>> = approvals().lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in waiting {
        let _ = tx.send(false);
    }
    let asked: Vec<Sender<Option<String>>> = questions().lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in asked {
        let _ = tx.send(None);
    }
}

// ------------------------------------------------------------ questions

fn questions() -> &'static Mutex<HashMap<String, Sender<Option<String>>>> {
    static Q: OnceLock<Mutex<HashMap<String, Sender<Option<String>>>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ask_user_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "question": { "type": "string" },
            "options": { "type": "array", "items": { "type": "string" }, "maxItems": 6, "description": "Short answers to pick from; may be empty for a free answer." },
        },
        "required": ["question"],
    })
}

/// The question as a card of the conversation, until the user answers,
/// skips it, closes the conversation, or 15 minutes pass.
fn ask_user(args: &Value) -> Result<Value> {
    let question = str_arg(args, "question")?;
    let options: Vec<&str> = args["options"].as_array().into_iter().flatten().filter_map(|o| o.as_str()).take(6).collect();
    if !DRAWER_OPEN.load(Ordering::SeqCst) {
        return Err(anyhow!("The conversation is closed: the user cannot answer now."));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    questions().lock().unwrap().insert(id.clone(), tx);
    emit("snappy-question", json!({ "id": id, "question": question, "options": options }));
    let answer = rx.recv_timeout(APPROVAL_TIMEOUT).ok().flatten();
    questions().lock().unwrap().remove(&id);
    emit("snappy-question-done", json!({ "id": id, "answer": answer }));
    Ok(match answer {
        Some(a) => json!({ "answer": a }),
        None => json!({ "answer": null, "note": "The user did not answer." }),
    })
}

/// The user's answer to a question (None: skipped).
pub fn reply(id: &str, answer: Option<String>) {
    if let Some(tx) = questions().lock().unwrap().remove(id) {
        let _ = tx.send(answer);
    }
}

// ------------------------------------------------------------ the UI's side

fn ui_calls() -> &'static Mutex<HashMap<String, Sender<Value>>> {
    static C: OnceLock<Mutex<HashMap<String, Sender<Value>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Asks the UI about what only it holds (Prepare's state, the Files view).
pub(crate) fn ui_call(method: &str, args: Value) -> Result<Value> {
    ui_call_within(method, args, UI_TIMEOUT)
}

pub(crate) fn ui_call_within(method: &str, args: Value, timeout: Duration) -> Result<Value> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    ui_calls().lock().unwrap().insert(id.clone(), tx);
    emit("snappy-ui", json!({ "id": id, "method": method, "args": args }));
    let got = rx.recv_timeout(timeout);
    ui_calls().lock().unwrap().remove(&id);
    let v = got.map_err(|_| anyhow!("Snap Studio did not answer"))?;
    match v.get("error").and_then(|e| e.as_str()) {
        Some(e) => Err(anyhow!(e.to_string())),
        None => Ok(v),
    }
}

/// The UI's answer to [`ui_call`].
pub fn ui_reply(id: &str, result: Value) {
    if let Some(tx) = ui_calls().lock().unwrap().remove(id) {
        let _ = tx.send(result);
    }
}

// ------------------------------------------------------------ tasks

struct Task {
    label: String,
    state: &'static str,
    result: Value,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

fn tasks() -> &'static Mutex<HashMap<String, Task>> {
    static T: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs a long operation in the background; its id answers at once.
pub(crate) fn spawn_task(label: String, work: impl std::future::Future<Output = Result<Value, String>> + Send + 'static) -> Value {
    let id = format!("task-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    tasks().lock().unwrap().insert(id.clone(), Task { label: label.clone(), state: "running", result: Value::Null, handle: None });
    let tid = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let r = work.await;
        if let Some(t) = tasks().lock().unwrap().get_mut(&tid) {
            if t.state == "running" {
                (t.state, t.result) = match r {
                    Ok(v) => ("done", v),
                    Err(e) => ("failed", json!(e)),
                };
            }
            t.handle = None;
        }
    });
    if let Some(t) = tasks().lock().unwrap().get_mut(&id) {
        if t.state == "running" {
            t.handle = Some(handle);
        }
    }
    json!({ "task": id, "state": "running", "what": label })
}

fn task_param() -> Value {
    json!({ "type": "object", "properties": { "task": { "type": "string", "description": "The task id." } }, "required": ["task"] })
}

fn task_status(args: &Value) -> Result<Value> {
    let id = str_arg(args, "task")?;
    let t = tasks().lock().unwrap();
    let t = t.get(id).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    Ok(json!({ "task": id, "what": t.label, "state": t.state, "result": t.result }))
}

fn task_cancel(args: &Value) -> Result<Value> {
    let id = str_arg(args, "task")?;
    let mut all = tasks().lock().unwrap();
    let t = all.get_mut(id).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    if t.state != "running" {
        return Ok(json!({ "task": id, "state": t.state }));
    }
    if let Some(h) = t.handle.take() {
        h.abort();
    }
    t.state = "cancelled";
    Ok(json!({ "task": id, "state": "cancelled" }))
}

// ------------------------------------------------------------ helpers

pub(crate) fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("missing `{key}`"))
}

pub(crate) fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(f)
}

/// A printer by its display name (case and spaces aside).
pub(crate) fn printer_named(name: &str) -> Result<crate::printers::Printer> {
    let list = crate::printers::load();
    let norm = |s: &str| s.trim().to_lowercase();
    list.iter().find(|p| norm(&p.name) == norm(name)).cloned().ok_or_else(|| {
        let names: Vec<&str> = list.iter().map(|p| p.name.as_str()).collect();
        anyhow!("no printer named “{name}”; the printers are: {}", names.join(", "))
    })
}

fn printer_param() -> Value {
    json!({ "type": "object", "properties": { "printer": { "type": "string", "description": "The printer's display name." } }, "required": ["printer"] })
}

fn printer_file_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "printer": { "type": "string", "description": "The printer's display name." },
            "file": { "type": "string", "description": "The file's name, as printer_files lists it." },
        },
        "required": ["printer", "file"],
    })
}

/// The last part of a path on a printer: what the user sees.
fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A print file on a printer, by the name `printer_files` gives.
pub(crate) fn printer_file(p: &crate::printers::Printer, name: &str) -> Result<crate::printer_files::RemoteFile> {
    let o = overview(p)?;
    let found: Vec<_> = o.files.into_iter().filter(|f| base_name(&f.path) == name || f.path == name).collect();
    match found.len() {
        0 => Err(anyhow!("no file named “{name}” on {}", p.name)),
        1 => Ok(found.into_iter().next().unwrap()),
        _ => Err(anyhow!("several files are named “{name}” on {}", p.name)),
    }
}

fn overview(p: &crate::printers::Printer) -> Result<crate::printer_files::Overview> {
    block_on(async {
        let st = crate::printers::status(&p.host, p.port).await;
        if !st.online {
            return Err(anyhow!(crate::t!("err.printer_silent", name = p.name)));
        }
        let printing = crate::printer_files::printing_path(&st.state, st.job.as_deref());
        crate::printer_files::overview(&p.host, p.port, printing).await
    })
}

// ------------------------------------------------------------ reads

fn printers(_: &Value) -> Result<Value> {
    let list = crate::printers::load();
    let out: Vec<Value> = block_on(async {
        // All at once: printers switched off cost one timeout, not one each.
        let asked: Vec<_> = list
            .iter()
            .map(|p| {
                let (host, port) = (p.host.clone(), p.port);
                tauri::async_runtime::spawn(async move { crate::printers::status(&host, port).await })
            })
            .collect();
        let mut out = Vec::new();
        for (p, h) in list.iter().zip(asked) {
            let st = h.await.unwrap_or_default();
            let s = serde_json::to_value(&st).unwrap_or_default();
            out.push(json!({
                "name": p.name,
                "model": p.model,
                "online": st.online,
                "state": st.state,
                "message": st.message,
                "error": st.error,
                "current_print": st.job.as_deref().map(base_name),
                "progress_percent": st.progress.map(|x| (x * 100.0).round()),
                "elapsed_min": st.elapsed_s.map(|x| (x / 60.0).round()),
                "remaining_min": st.remaining_s.map(|x| (x / 60.0).round()),
                "layer": st.layer,
                "nozzles": s["nozzles"],
                "bed": s["bed"],
                "chamber": s["chamber"],
                "filaments": s["filaments"],
            }));
        }
        out
    });
    Ok(json!({ "printers": out }))
}

fn printer_files(args: &Value) -> Result<Value> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let mut files = overview(&p)?.files;
    files.sort_by(|a, b| b.modified.total_cmp(&a.modified));
    let total = files.len();
    let out: Vec<Value> = files
        .iter()
        .take(100)
        .map(|f| {
            let m = f.meta.as_ref();
            json!({
                "name": base_name(&f.path),
                "size_kb": f.size / 1024,
                "modified": f.modified as u64,
                "estimated_min": m.and_then(|m| m.estimated_time).map(|t| (t / 60.0).round()),
                "filaments": m.map(|m| m.filament_types.clone()),
                "layer_height": m.and_then(|m| m.layer_height),
            })
        })
        .collect();
    Ok(json!({ "printer": p.name, "files": out, "total": total }))
}

fn local_files(_: &Value) -> Result<Value> {
    ui_call("local_files", json!({}))
}

fn slice_summary(_: &Value) -> Result<Value> {
    ui_call("slice_summary", json!({}))
}

fn print_queue(_: &Value) -> Result<Value> {
    let printers = crate::printers::load();
    let name_of = |id: &str| printers.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_default();
    let jobs: Vec<Value> = crate::jobs::views()
        .into_iter()
        .map(|v| {
            let j = v.job;
            json!({
                "id": j.id,
                "name": j.name,
                "printer": name_of(&j.printer_id),
                "state": j.state,
                "created": j.created,
                "started": j.started,
                "finished": j.finished,
                "estimated_min": j.stats.as_ref().and_then(|s| s.print_time_s).map(|t| (t as f32 / 60.0).round()),
                "filament_g": j.stats.as_ref().and_then(|s| s.filament_g),
                "file_kept": v.gcode,
            })
        })
        .collect();
    Ok(json!({ "prints": jobs }))
}

fn memory_params() -> Value {
    json!({ "type": "object", "properties": { "content": { "type": "string", "description": "The whole new MEMORY.md." } }, "required": ["content"] })
}

fn memory_read(_: &Value) -> Result<Value> {
    Ok(json!({ "memory": crate::snappy::memory() }))
}

fn memory_write(args: &Value) -> Result<Value> {
    let content = args["content"].as_str().ok_or_else(|| anyhow!("missing `content`"))?;
    crate::snappy::set_memory(content)?;
    Ok(json!({ "saved": true }))
}

// ------------------------------------------------------------ actions

fn view_params() -> Value {
    json!({
        "type": "object",
        "properties": { "view": { "type": "string", "enum": ["library", "ia", "files", "prepare", "prints", "settings"] } },
        "required": ["view"],
    })
}

fn open_view(args: &Value) -> Result<Value> {
    ui_call("open_view", json!({ "view": str_arg(args, "view")? }))
}

fn open_slice_sheet(_: &Value) -> Result<Value> {
    ui_call_within("open_slice_sheet", json!({}), SHEET_TIMEOUT)
}

fn slice_options(_: &Value) -> Result<Value> {
    ui_call("slice_options", json!({}))
}

fn slice_set_params() -> Value {
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
fn ask_slice_set(args: &Value) -> Result<String> {
    let v = ui_call("slice_check", json!({ "changes": args["changes"] }))?;
    let lines: Vec<&str> = v["lines"].as_array().into_iter().flatten().filter_map(|l| l.as_str()).collect();
    if lines.is_empty() {
        return Err(anyhow!("no change to make"));
    }
    Ok(format!("{}\n{}", crate::t!("snappy.ask.slice_set"), lines.join("\n")))
}

fn slice_set(args: &Value) -> Result<Value> {
    ui_call_within("slice_set", json!({ "changes": args["changes"] }), SHEET_TIMEOUT)
}

fn ask_slice_run(_: &Value) -> Result<String> {
    Ok(crate::t!("snappy.ask.slice_run"))
}

fn slice_run(_: &Value) -> Result<Value> {
    Ok(spawn_task(crate::t!("snappy.task.slice"), async {
        tauri::async_runtime::spawn_blocking(|| ui_call_within("slice_run", json!({}), SLICE_TIMEOUT))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }))
}

fn job_param() -> Value {
    json!({ "type": "object", "properties": { "job": { "type": "string", "description": "The print's id, from print_queue." } }, "required": ["job"] })
}

fn queued_job(args: &Value) -> Result<(crate::jobs::Job, String)> {
    let id = str_arg(args, "job")?;
    let job = crate::jobs::get(id).ok_or_else(|| anyhow!(crate::t!("err.job_unknown")))?;
    if job.state != "queued" {
        return Err(anyhow!(crate::t!("err.not_queued")));
    }
    let printer = crate::printers::load()
        .into_iter()
        .find(|p| p.id == job.printer_id)
        .map(|p| p.name)
        .ok_or_else(|| anyhow!(crate::t!("err.unknown_printer")))?;
    Ok((job, printer))
}

fn ask_start_job(args: &Value) -> Result<String> {
    let (job, printer) = queued_job(args)?;
    Ok(crate::t!("snappy.ask.start_job", name = job.name, printer = printer))
}

fn start_job(args: &Value) -> Result<Value> {
    let (job, printer) = queued_job(args)?;
    let app = crate::snappy::app().ok_or_else(|| anyhow!("app not ready"))?.clone();
    let id = job.id.clone();
    Ok(spawn_task(format!("start “{}” on {printer}", job.name), async move {
        crate::job_launch(app, id, None).await.map(|_| json!({ "started": true }))
    }))
}

/// The printer and the file's path a card named: resolved once, at the
/// card, and kept for the run.
fn printer_and_file(args: &Value) -> Result<(crate::printers::Printer, String)> {
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

fn ask_printer_file(args: &Value, key: &str) -> Result<String> {
    let (p, path) = printer_and_file(args)?;
    keep_resolved(json!({ "printer": p.id, "path": path }));
    Ok(crate::t!(key, file = base_name(&path), printer = p.name))
}

fn ask_print_file(args: &Value) -> Result<String> {
    ask_printer_file(args, "snappy.ask.print_file")
}

fn print_file(args: &Value) -> Result<Value> {
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
    Ok(spawn_task(format!("print “{name}” on {}", p.name), async move {
        crate::pf_print(app, request).await.map(|_| json!({ "started": true }))
    }))
}

fn ask_delete_file(args: &Value) -> Result<String> {
    ask_printer_file(args, "snappy.ask.delete_file")
}

fn delete_file(args: &Value) -> Result<Value> {
    let (p, path) = printer_and_file(args)?;
    let errors = block_on(crate::pf_delete(p.id.clone(), "gcodes".into(), vec![path.clone()])).map_err(|e| anyhow!(e))?;
    match errors.into_iter().next().flatten() {
        Some(e) => Err(anyhow!(e)),
        None => Ok(json!({ "deleted": base_name(&path), "printer": p.name })),
    }
}

// ------------------------------------------------------------ cancelling a task

fn ask_task_cancel(args: &Value) -> Result<String> {
    let id = str_arg(args, "task")?;
    let what = tasks().lock().unwrap().get(id).map(|t| t.label.clone()).ok_or_else(|| anyhow!("unknown task: {id}"))?;
    Ok(crate::t!("snappy.ask.task_cancel", what = what))
}

// ------------------------------------------------------------ sending a slice

fn send_params() -> Value {
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
fn send_choices(args: &Value) -> Result<(crate::printers::Printer, bool, crate::printers::StartOptions)> {
    let p = printer_named(str_arg(args, "printer")?)?;
    let flag = |k: &str| args[k].as_bool().ok_or_else(|| anyhow!("missing `{k}`: ask the user"));
    let options = crate::printers::StartOptions {
        bed_leveling: flag("bed_leveling")?,
        flow_calibration: flag("flow_calibration")?,
        timelapse: flag("timelapse")?,
    };
    Ok((p, flag("queue")?, options))
}

fn ask_send(args: &Value) -> Result<String> {
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

fn send_slice(args: &Value) -> Result<Value> {
    let (p, queue, o) = send_choices(args)?;
    // The send sheet does it, as by hand: printer check, spool check, upload.
    ui_call_within("send_slice", json!({ "printer": p.id, "queue": queue, "options": serde_json::to_value(o)? }), APPROVAL_TIMEOUT)
}

// ------------------------------------------------------------ local files

fn local_file_param() -> Value {
    json!({ "type": "object", "properties": { "file": { "type": "string", "description": "The file's name, as local_files lists it." } }, "required": ["file"] })
}

/// A file of the Files view, by its name: its path stays on this side.
fn local_file(args: &Value) -> Result<(String, std::path::PathBuf)> {
    let name = str_arg(args, "file")?;
    let v = ui_call("local_file", json!({ "name": name }))?;
    let path = v["path"].as_str().filter(|p| !p.is_empty()).ok_or_else(|| anyhow!("no file named “{name}” in the Files view"))?;
    Ok((name.to_string(), std::path::PathBuf::from(path)))
}

fn ask_delete_local(args: &Value) -> Result<String> {
    let (name, path) = local_file(args)?;
    // The file named on the card is the one trashed, whatever the Files
    // view shows by the time the user answers.
    keep_resolved(json!({ "name": name, "path": path }));
    Ok(crate::t!("snappy.ask.delete_local_file", file = name))
}

fn delete_local(args: &Value) -> Result<Value> {
    let (name, path) = match take_resolved() {
        Some(v) if v["path"].is_string() => {
            (v["name"].as_str().unwrap_or_default().to_string(), std::path::PathBuf::from(v["path"].as_str().unwrap_or_default()))
        }
        _ => local_file(args)?,
    };
    if !path.is_file() {
        return Err(anyhow!("“{name}” is no longer there"));
    }
    trash::delete(&path)?;
    Ok(json!({ "trashed": name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The drawer's state is the app's: tests that set it take turns.
    static DRAWER: Mutex<()> = Mutex::new(());

    #[test]
    fn every_tool_is_declared_once() {
        let mut names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), TOOLS.len());
        for t in TOOLS {
            let p = (t.params)();
            assert_eq!(p["type"], "object", "{}", t.name);
            for r in p["required"].as_array().into_iter().flatten() {
                assert!(p["properties"].get(r.as_str().unwrap()).is_some(), "{}: {r}", t.name);
            }
        }
    }

    #[test]
    fn only_writes_are_confirmed() {
        let writes: Vec<&str> = TOOLS.iter().filter(|t| t.access == Access::Write).map(|t| t.name).collect();
        assert_eq!(
            writes,
            [
                "task_cancel",
                "slice_set",
                "slice_run",
                "start_queued_print",
                "print_printer_file",
                "delete_printer_file",
                "send_slice",
                "delete_local_file",
                "printer_control",
                "print_control",
                "rename_printer_file",
                "download_printer_file",
                "queue_move",
                "queue_remove",
                "queue_edit",
                "create_send",
                "create_new",
                "favorite_add",
                "favorite_remove",
                "plate_edit",
                "plate_add",
                "settings_set",
                "app_action",
                "printer_manage",
                "bed_mesh_action",
                "maintenance",
                "print_history",
                "slice_save_profile",
                "preview_action",
                "local_file_ai",
                "create_manage",
                "explore_site",
            ]
        );
        for t in TOOLS {
            assert_eq!(t.ask.is_some(), t.access == Access::Write, "{}: a card for writes only", t.name);
        }
    }

    /// Reads and Snappy's notes run without a card, even with the drawer
    /// closed; a write does not.
    #[test]
    fn reads_run_without_asking() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        for (name, args) in [("print_queue", json!({})), ("memory_read", json!({}))] {
            if let Err(e) = call(name, &args) {
                assert!(!e.to_string().contains("did not approve"), "{name}: {e}");
            }
        }
    }

    /// Anything that is not an explicit yes is a no: the drawer closed, a
    /// refusal, everything refused at once.
    #[test]
    fn approval_is_denied_by_default() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        assert!(!approve("delete_printer_file", "x"), "the drawer is closed: no");
        set_drawer(true);
        let waiting = |n: usize| {
            let end = std::time::Instant::now() + Duration::from_secs(5);
            while approvals().lock().unwrap().len() < n && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let refused = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        let id = approvals().lock().unwrap().keys().next().cloned().unwrap();
        answer(&id, false);
        assert!(!refused.join().unwrap());
        let yes = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        let id = approvals().lock().unwrap().keys().next().cloned().unwrap();
        answer(&id, true);
        assert!(yes.join().unwrap(), "only an explicit yes passes");
        let closed = std::thread::spawn(|| approve("delete_printer_file", "x"));
        waiting(1);
        set_drawer(false);
        assert!(!closed.join().unwrap(), "closing the drawer refuses");
        assert!(approvals().lock().unwrap().is_empty());
    }

    /// A write waits for a yes: with the drawer closed it is refused, and
    /// nothing runs; bad arguments are refused before anyone is asked.
    #[test]
    fn a_refused_action_runs_nothing() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        let t = spawn_task("wait".into(), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(json!({}))
        });
        let id = t["task"].as_str().unwrap().to_string();
        let e = call("task_cancel", &json!({ "task": id })).unwrap_err();
        assert!(e.to_string().contains("did not approve"), "{e}");
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "running");
        assert!(call("task_cancel", &json!({ "task": "task-nope" })).unwrap_err().to_string().contains("unknown task"));
        task_cancel(&json!({ "task": id })).unwrap();
    }

    /// A question needs the conversation open; closing it leaves the
    /// question unanswered.
    #[test]
    fn questions_wait_for_the_user() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        assert!(call("ask_user", &json!({ "question": "PLA or PETG?" })).is_err());
        set_drawer(true);
        let asked = std::thread::spawn(|| call("ask_user", &json!({ "question": "PLA or PETG?", "options": ["PLA", "PETG"] })).unwrap());
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while questions().lock().unwrap().is_empty() && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        let id = questions().lock().unwrap().keys().next().cloned().unwrap();
        reply(&id, Some("PETG".into()));
        assert_eq!(asked.join().unwrap()["answer"], "PETG");
        let skipped = std::thread::spawn(|| call("ask_user", &json!({ "question": "Brim?" })).unwrap());
        while questions().lock().unwrap().is_empty() && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        set_drawer(false);
        assert!(skipped.join().unwrap()["answer"].is_null(), "closing leaves it unanswered");
    }

    #[test]
    fn a_send_needs_every_choice() {
        let _turn = DRAWER.lock().unwrap_or_else(|e| e.into_inner());
        set_drawer(false);
        // No printer of that name here: refused before anyone is asked.
        let e = call(
            "send_slice",
            &json!({ "printer": "Nope", "queue": false, "bed_leveling": true, "flow_calibration": false, "timelapse": false }),
        )
        .unwrap_err();
        assert!(e.to_string().contains("no printer named"), "{e}");
        let schema = send_params();
        assert_eq!(schema["required"].as_array().unwrap().len(), 5, "every option is asked");
    }

    /// What the card named runs, even if the source changed meanwhile.
    #[test]
    fn the_approved_file_is_the_one_used() {
        keep_resolved(json!({ "name": "benchy.stl", "path": "/folder-a/benchy.stl" }));
        let v = take_resolved().unwrap();
        assert_eq!(v["path"], "/folder-a/benchy.stl");
        assert!(take_resolved().is_none(), "used once");
    }

    #[test]
    fn tasks_are_followed_and_cancelled() {
        let t = spawn_task("wait".into(), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(json!({}))
        });
        let id = t["task"].as_str().unwrap().to_string();
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "running");
        assert_eq!(task_cancel(&json!({ "task": id })).unwrap()["state"], "cancelled");
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["state"], "cancelled");
        let done = spawn_task("quick".into(), async { Ok(json!({ "n": 1 })) });
        let id = done["task"].as_str().unwrap().to_string();
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while task_status(&json!({ "task": id })).unwrap()["state"] == "running" && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(task_status(&json!({ "task": id })).unwrap()["result"]["n"], 1);
        assert!(task_status(&json!({ "task": "task-nope" })).is_err());
    }
}
