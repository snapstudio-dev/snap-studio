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
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

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

mod app;
mod approval;
mod bridge;
mod common;
mod create;
mod explore;
mod files;
mod prepare;
mod printers;
mod queue;
#[cfg(test)]
mod real_tests;
mod tasks;
#[cfg(test)]
mod tests;

pub(crate) use approval::*;
pub(crate) use bridge::*;
pub(crate) use common::*;
pub(crate) use tasks::*;

/// How long an approval waits for the user.
pub(crate) const APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How long the UI has to answer a question about what it shows.
pub(crate) const UI_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the slice sheet may take to open or to apply changes (a new
/// nozzle profile reloads its lists).
pub(crate) const SHEET_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a slice may take.
pub(crate) const SLICE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy)]
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

pub(crate) fn no_params() -> Value {
    json!({ "type": "object", "properties": {} })
}

pub fn find(name: &str) -> Option<&'static Tool> {
    tools().iter().find(|t| t.name == name)
}

/// The tools as MCP lists them.
pub fn list() -> Vec<Value> {
    tools()
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

pub(crate) fn keep_resolved(v: Value) {
    RESOLVED.with(|r| *r.borrow_mut() = Some(v));
}

pub(crate) fn take_resolved() -> Option<Value> {
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
    let mut out = (tool.run)(args)?;
    // An image is not text: it keeps out of the text filter.
    let image = crate::snappy_eyes::take_image(&mut out);
    let mut out = privacy::json(&out, &privacy::known());
    if let Some(i) = image {
        out["_image"] = i;
    }
    Ok(out)
}

/// The whole table, domain by domain.
pub fn tools() -> &'static [Tool] {
    static ALL: OnceLock<Vec<Tool>> = OnceLock::new();
    ALL.get_or_init(|| [printers::TOOLS, queue::TOOLS, prepare::TOOLS, files::TOOLS, create::TOOLS, explore::TOOLS, app::TOOLS].concat())
}
