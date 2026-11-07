//! Tools over the print queue and the print history.

use super::*;

pub(crate) static TOOLS: &[Tool] = &[
    Tool {
        name: "print_queue",
        description: "Known prints: queued, printing and past ones, with their printer, state and estimates. A queued print's id starts it with start_queued_print.",
        params: no_params,
        access: Access::Read,
        ask: None,
        run: print_queue,
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
        name: "queue_move",
        description: "Moves a queued print earlier or later in its printer's queue. The user confirms it.",
        params: queue_move_params,
        access: Access::Write,
        ask: Some(ask_queue_move),
        run: queue_move,
    },
    Tool {
        name: "queue_remove",
        description: "Removes a print from the queue. The user confirms it.",
        params: job_only,
        access: Access::Write,
        ask: Some(ask_queue_remove),
        run: queue_remove,
    },
    Tool {
        name: "queue_edit",
        description: "Changes a queued print's printer or its options (bed leveling, flow calibration, timelapse); what is not given stays. The user confirms it.",
        params: queue_edit_params,
        access: Access::Write,
        ask: Some(ask_queue_edit),
        run: queue_edit,
    },
    Tool {
        name: "print_history",
        description: "Puts a finished print back in the queue, notes how a print came out, or hides a printer's queue reminder. The user confirms it.",
        params: history_params,
        access: Access::Write,
        ask: Some(ask_history),
        run: history,
    },
];

pub(crate) fn print_queue(_: &Value) -> Result<Value> {
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

pub(crate) fn job_param() -> Value {
    json!({ "type": "object", "properties": { "job": { "type": "string", "description": "The print's id, from print_queue." } }, "required": ["job"] })
}

pub(crate) fn queued_job(args: &Value) -> Result<(crate::jobs::Job, String)> {
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

pub(crate) fn ask_start_job(args: &Value) -> Result<String> {
    let (job, printer) = queued_job(args)?;
    Ok(crate::t!("snappy.ask.start_job", name = job.name, printer = printer))
}

pub(crate) fn start_job(args: &Value) -> Result<Value> {
    let (job, printer) = queued_job(args)?;
    let app = crate::snappy::app().ok_or_else(|| anyhow!("app not ready"))?.clone();
    let id = job.id.clone();
    Ok(spawn_task(format!("start “{}” on {printer}", job.name), Cancel::Refuse(PRINT_STARTING), async move {
        crate::job_launch(app, id, None).await.map(|_| json!({ "started": true }))
    }))
}

pub fn history_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["requeue", "result", "dismiss"] },
            "job": { "type": "string", "description": "requeue, result: the print's id, from print_queue." },
            "success": { "type": "boolean", "description": "result: whether it came out well." },
            "note": { "type": "string", "description": "result: a note, optional." },
            "printer": { "type": "string", "description": "dismiss: the printer whose queue reminder to hide." },
        },
        "required": ["action"],
    })
}

pub fn ask_history(args: &Value) -> Result<String> {
    match str_arg(args, "action")? {
        "requeue" => Ok(crate::t!("snappy.ask.hist_requeue", name = job_of(args)?.0.name)),
        "result" => {
            let ok = args["success"].as_bool().ok_or_else(|| anyhow!("result needs `success`"))?;
            Ok(crate::t!(if ok { "snappy.ask.hist_ok" } else { "snappy.ask.hist_failed" }, name = job_of(args)?.0.name))
        }
        "dismiss" => Ok(crate::t!("snappy.ask.hist_dismiss", printer = printer_named(str_arg(args, "printer")?)?.name)),
        a => Err(anyhow!("invalid action: {a}")),
    }
}

pub fn history(args: &Value) -> Result<Value> {
    let e = |e: String| anyhow!(e);
    match str_arg(args, "action")? {
        "requeue" => {
            let (job, _) = job_of(args)?;
            block_on(crate::job_requeue(app()?, job.id)).map(|j| json!({ "queued": j.name })).map_err(e)
        }
        "result" => {
            let (job, _) = job_of(args)?;
            let result = crate::jobs::PrintResult {
                success: args["success"].as_bool(),
                reason: None,
                note: args["note"].as_str().unwrap_or_default().to_string(),
                at: 0,
            };
            crate::job_set_result(job.id, Some(result)).map(|_| json!({ "noted": job.name })).map_err(e)
        }
        "dismiss" => {
            crate::queue_dismiss(printer_named(str_arg(args, "printer")?)?.id);
            Ok(json!({ "dismissed": true }))
        }
        a => Err(anyhow!("invalid action: {a}")),
    }
}

pub(crate) fn job_of(args: &Value) -> Result<(crate::jobs::Job, String)> {
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
pub(crate) fn queue_edit_of(args: &Value) -> Result<(crate::jobs::Job, crate::printers::Printer, crate::printers::StartOptions)> {
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
