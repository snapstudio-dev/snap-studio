//! Tools over Create's conversations.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
    Tool {
        name: "create_list",
        description: "Create's conversations (an object made or changed with the AI): id, title, object, last change, mode.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: create_list,
    },
    Tool {
        name: "create_open",
        description: "Shows one of Create's conversations.",
        params: create_open_params,
        access: Access::Harmless,
        ask: None,
        run: create_open,
    },
    Tool {
        name: "create_send",
        description: "Sends a message to one of Create's conversations, as typed in it: that object's AI works on it. The user confirms it.",
        params: create_send_params,
        access: Access::Write,
        ask: Some(ask_create_send),
        run: create_send,
    },
    Tool {
        name: "create_new",
        description: "Starts a new Create conversation that models an object from a description, with the New object sheet's defaults. The user confirms it.",
        params: create_new_params,
        access: Access::Write,
        ask: Some(ask_create_new),
        run: create_new,
    },
    Tool {
        name: "create_versions",
        description: "The saved versions of one of Create's objects: number, when, size.",
        params: create_open_params,
        access: Access::Read,
        ask: None,
        run: create_versions,
    },
    Tool {
        name: "create_manage",
        description: "On one of Create's conversations: rename, duplicate, delete, go back to a version, stop its answer, or choose its model. The user confirms it.",
        params: create_manage_params,
        access: Access::Write,
        ask: Some(ask_create_manage),
        run: create_manage,
    },
];

/// Create's conversations: title, object, when, mode. The id names one.
pub fn create_list(_: &Value) -> Result<Value> {
    let list: Vec<Value> = crate::ia_list()
        .into_iter()
        .map(|c| json!({ "id": c.id, "title": c.title, "object": c.source_name, "updated_at": c.updated_at, "mode": c.engine }))
        .collect();
    Ok(json!({ "conversations": list }))
}

pub(crate) fn conversation(args: &Value) -> Result<crate::ia::Conversation> {
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
