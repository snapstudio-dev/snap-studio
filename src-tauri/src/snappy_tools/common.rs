//! Helpers shared by the tools of several domains: arguments, printers and
//! their files by display name, the page's generic tools.

use super::*;

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

pub(crate) fn printer_param() -> Value {
    json!({ "type": "object", "properties": { "printer": { "type": "string", "description": "The printer's display name." } }, "required": ["printer"] })
}

pub(crate) fn printer_file_params() -> Value {
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
pub(crate) fn base_name(path: &str) -> &str {
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

pub(crate) fn overview(p: &crate::printers::Printer) -> Result<crate::printer_files::Overview> {
    block_on(async {
        let st = crate::printers::status(&p.host, p.port).await;
        if !st.online {
            return Err(anyhow!(crate::t!("err.printer_silent", name = p.name)));
        }
        let printing = crate::printer_files::printing_path(&st.state, st.job.as_deref());
        crate::printer_files::overview(&p.host, p.port, printing).await
    })
}

pub(crate) fn printers(_: &Value) -> Result<Value> {
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

pub(crate) fn printer_files(args: &Value) -> Result<Value> {
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

pub(crate) fn app() -> Result<tauri::AppHandle> {
    crate::snappy::app().cloned().ok_or_else(|| anyhow!("app not ready"))
}

/// A tool the page answers and words: `<name>_check` gives the card's
/// text (and checks the arguments), `<name>` does it.
/// The page words the card and keeps what it named under a token, which the
/// run passes back: the action works on what the user approved.
pub(crate) fn page_ask(method: &str, args: &Value) -> Result<String> {
    let v = ui_call(&format!("{method}_check"), args.clone())?;
    if let Some(t) = v["token"].as_str() {
        keep_resolved(json!({ "page_token": t }));
    }
    v["card"].as_str().map(String::from).ok_or_else(|| anyhow!("Snap Studio did not word this action"))
}

pub(crate) fn page_run(method: &str, args: &Value) -> Result<Value> {
    let mut args = args.clone();
    if let Some(t) = take_resolved().and_then(|v| v["page_token"].as_str().map(String::from)) {
        args["_token"] = json!(t);
    }
    ui_call_within(method, args, SHEET_TIMEOUT)
}
