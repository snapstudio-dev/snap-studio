//! Tools over Explore: its sites and tabs, and the favorites.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
    Tool {
        name: "explore_state",
        description: "Explore: the sites it offers, the open tabs (titles), the one shown, and the favorites.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: explore_state,
    },
    Tool {
        name: "explore_open",
        description: "Shows one of Explore's sites or one of its favorites.",
        params: explore_open_params,
        access: Access::Harmless,
        ask: None,
        run: explore_open,
    },
    Tool {
        name: "explore_open_url",
        description:
            "Opens a web address in Explore: only one the user gave, http or https. The user confirms it, the address shown whole.",
        params: explore_url_params,
        access: Access::Write,
        ask: Some(ask_explore_url),
        run: explore_open_url,
    },
    Tool {
        name: "favorite_add",
        description: "Adds the page Explore shows to the favorites. The user confirms it.",
        params: no_params,
        access: Access::Write,
        ask: Some(ask_fav_add),
        run: fav_add,
    },
    Tool {
        name: "favorite_remove",
        description: "Removes a favorite of Explore. The user confirms it.",
        params: fav_params,
        access: Access::Write,
        ask: Some(ask_fav_remove),
        run: fav_remove,
    },
    Tool {
        name: "explore_tab",
        description: "On a tab of Explore: back, forward, reload, close, or open its page in the system's browser.",
        params: explore_tab_params,
        access: Access::Harmless,
        ask: None,
        run: explore_tab,
    },
    Tool {
        name: "explore_site",
        description: "Signs out of a site of Explore (its cookies only), or pins it in the sidebar, or unpins it. The user confirms it.",
        params: explore_site_params,
        access: Access::Write,
        ask: Some(ask_explore_site),
        run: explore_site,
    },
];

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
        },
    })
}

/// Shows a site or a favorite in Explore (one of them): only what Explore
/// already knows, so no card. An address goes through explore_open_url.
pub fn explore_open(args: &Value) -> Result<Value> {
    let url = match args["favorite"].as_str() {
        Some(f) => Some(web_url(
            &crate::fav_list()
                .into_iter()
                .find(|x| x.id == f || x.title == f)
                .map(|x| x.url)
                .ok_or_else(|| anyhow!("no favorite “{f}”"))?,
        )?),
        None => None,
    };
    if url.is_none() && args["site"].as_str().is_none() {
        return Err(anyhow!("give a site or a favorite; a web address goes through explore_open_url"));
    }
    ui_call("explore_open", json!({ "site": args["site"], "url": url }))
}

pub fn explore_url_params() -> Value {
    json!({
        "type": "object",
        "properties": { "url": { "type": "string", "description": "The web address the user gave, http or https." } },
        "required": ["url"],
    })
}

/// A web page's address, checked: http or https with a host, nothing else
/// (no file:, no custom scheme), so a text Snappy read cannot send Explore
/// elsewhere.
pub(crate) fn web_url(raw: &str) -> Result<String> {
    let u = url::Url::parse(raw.trim()).map_err(|_| anyhow!("not a web address: {raw}"))?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none_or(str::is_empty) {
        return Err(anyhow!("only http and https addresses open in Explore"));
    }
    Ok(u.to_string())
}

pub fn ask_explore_url(args: &Value) -> Result<String> {
    let url = web_url(str_arg(args, "url")?)?;
    Ok(crate::t!("snappy.ask.explore_url", url = url))
}

/// Opens an address the user confirmed.
pub fn explore_open_url(args: &Value) -> Result<Value> {
    let url = web_url(str_arg(args, "url")?)?;
    ui_call("explore_open", json!({ "url": url }))
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

pub(crate) fn favorite(args: &Value) -> Result<crate::favorites::Favorite> {
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

page_tool!(explore_site, ask_explore_site, "explore_site");

page_tool!(explore_tab, "explore_tab");

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
