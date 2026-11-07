//! Snappy's own tools (memory, tasks, questions, views) and the app's
//! settings and actions.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
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
        name: "settings_list",
        description: "Snap Studio's settings as Settings shows them: each one's key, label, section, current value and choices.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: settings_list,
    },
    Tool {
        name: "settings_set",
        description: "Changes one of Snap Studio's settings, as by hand in Settings. The user confirms it.",
        params: settings_set_params,
        access: Access::Write,
        ask: Some(ask_settings_set),
        run: settings_set,
    },
    Tool {
        name: "app_action",
        description: "One of Snap Studio's own actions: check for an update, install the one found, open the welcome assistant again, check again what the AI needs, clear the thumbnail cache, reset the display settings, install or remove the slicing engine. The user confirms it.",
        params: app_action_params,
        access: Access::Write,
        ask: Some(ask_app_action),
        run: app_action,
    },
    Tool {
        name: "attachment_view",
        description: "An image the user attached to a message, by the name the message gives: look at it before answering about it.",
        params: crate::snappy_eyes::attachment_params,
        access: Access::Read,
        ask: None,
        run: crate::snappy_eyes::attachment_view,
    },
];

pub(crate) fn memory_params() -> Value {
    json!({ "type": "object", "properties": { "content": { "type": "string", "description": "The whole new MEMORY.md." } }, "required": ["content"] })
}

pub(crate) fn memory_read(_: &Value) -> Result<Value> {
    Ok(json!({ "memory": crate::snappy::memory() }))
}

pub(crate) fn memory_write(args: &Value) -> Result<Value> {
    let content = args["content"].as_str().ok_or_else(|| anyhow!("missing `content`"))?;
    crate::snappy::set_memory(content)?;
    Ok(json!({ "saved": true }))
}

pub(crate) fn view_params() -> Value {
    json!({
        "type": "object",
        "properties": { "view": { "type": "string", "enum": ["library", "ia", "files", "prepare", "prints", "settings"] } },
        "required": ["view"],
    })
}

pub(crate) fn open_view(args: &Value) -> Result<Value> {
    ui_call("open_view", json!({ "view": str_arg(args, "view")? }))
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

page_tool!(app_action, ask_app_action, "app_action");

pub fn app_action_params() -> Value {
    json!({
        "type": "object",
        "properties": { "action": { "type": "string", "enum": ["check_update", "install_update", "welcome", "recheck_ai", "clear_cache", "reset_display", "engine_install", "engine_remove"] } },
        "required": ["action"],
    })
}
