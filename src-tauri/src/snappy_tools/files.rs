//! Tools over the Files view: the folders, the files by name, moving one to
//! the Trash, opening and analysing.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
    Tool {
        name: "local_files",
        description: "Files shown in Snap Studio's Files view (the folder the user browses), by name.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: local_files,
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
        name: "files_folders",
        description: "The folders of the Files view, by name: the one shown and the recent ones.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: files_folders,
    },
    Tool {
        name: "files_open_folder",
        description: "Shows one of the Files view's folders, by name.",
        params: folder_params,
        access: Access::Harmless,
        ask: None,
        run: files_open_folder,
    },
    Tool {
        name: "local_file_open",
        description: "Shows a file of the Files view in the system's file manager, opens it with its app, or reads its size and triangle count.",
        params: local_file_open_params,
        access: Access::Harmless,
        ask: None,
        run: local_file_open,
    },
    Tool {
        name: "local_file_ai",
        description: "Starts a Create conversation that changes a model of the Files view, as its Edit with AI does. The user confirms it.",
        params: local_file_ai_params,
        access: Access::Write,
        ask: Some(ask_local_file_ai),
        run: local_file_ai,
    },
    Tool {
        name: "files_view",
        description: "Sorts the Files view, or filters it by a text in the names.",
        params: files_view_params,
        access: Access::Harmless,
        ask: None,
        run: files_view,
    },
];

pub(crate) fn local_files(_: &Value) -> Result<Value> {
    ui_call("local_files", json!({}))
}

pub(crate) fn local_file_param() -> Value {
    json!({ "type": "object", "properties": { "file": { "type": "string", "description": "The file's name, as local_files lists it." } }, "required": ["file"] })
}

/// A file of the Files view, by its name: its path stays on this side.
pub(crate) fn local_file(args: &Value) -> Result<(String, std::path::PathBuf)> {
    let name = str_arg(args, "file")?;
    let v = ui_call("local_file", json!({ "name": name }))?;
    let path = v["path"].as_str().filter(|p| !p.is_empty()).ok_or_else(|| anyhow!("no file named “{name}” in the Files view"))?;
    Ok((name.to_string(), std::path::PathBuf::from(path)))
}

pub(crate) fn ask_delete_local(args: &Value) -> Result<String> {
    let (name, path) = local_file(args)?;
    // The file named on the card is the one trashed, whatever the Files
    // view shows by the time the user answers.
    keep_resolved(json!({ "name": name, "path": path }));
    Ok(crate::t!("snappy.ask.delete_local_file", file = name))
}

pub(crate) fn delete_local(args: &Value) -> Result<Value> {
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

page_tool!(local_file_ai, ask_local_file_ai, "local_file_ai");

page_tool!(local_file_open, "local_file_open");

page_tool!(files_view, "files_view");

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
