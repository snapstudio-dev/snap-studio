//! Simulated Snapmaker U1 printers, without the app: for tests, the CI, or
//! another client (Fluidd, curl). Development builds only:
//!
//!     cargo run --features sim --bin u1-sim -- farm --speed 60
//!     cargo run --features sim --bin u1-sim -- fault 51234 runout head=1
//!
//! See docs/DEVELOPMENT.md, "Simulated printers".

use snap_studio_lib::sim::{clock, faults::Fault, scenario, server::Farm};
use std::sync::Arc;

const USAGE: &str = "\
usage:
  u1-sim [SCENARIO] [--speed 1|10|60|600]   run a scenario (solo, farm, trouble, or a scenario file)
  u1-sim list                               the built-in scenarios
  u1-sim status PORT                        a running printer's state and faults
  u1-sim fault PORT FAULT [key=value...]    inject a fault (`clear` removes them)
  u1-sim spool PORT HEAD TYPE COLOR         load a spool (`u1-sim spool 51234 1 PLA #ff0000`)

faults: ";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
    let code = match args.first().map(String::as_str) {
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}{}", snap_studio_lib::sim::faults::NAMES.join(", "));
            0
        }
        Some("list") => {
            for n in scenario::names() {
                let s = scenario::load(n).expect("built-in scenario");
                println!("{n:8} {} printer(s): {}", s.printers.len(), s.description);
            }
            0
        }
        Some("status") => rt.block_on(control(args.get(1), "status", None)),
        Some("fault") => {
            let Some(name) = args.get(2) else { fail("fault: which one?") };
            if name == "clear" {
                rt.block_on(control(args.get(1), "clear", Some(serde_json::json!({}))))
            } else {
                match Fault::parse(name, &args[3..]) {
                    Ok(f) => rt.block_on(control(args.get(1), "fault", Some(serde_json::to_value(f).expect("fault")))),
                    Err(e) => fail(&e),
                }
            }
        }
        Some("spool") => {
            let (Some(head), Some(kind), Some(color)) = (args.get(2), args.get(3), args.get(4)) else { fail("spool PORT HEAD TYPE COLOR") };
            let body = serde_json::json!({ "head": head.parse::<u8>().unwrap_or(0), "spool": { "type": kind, "color": color } });
            rt.block_on(control(args.get(1), "spool", Some(body)))
        }
        _ => rt.block_on(run(&args)),
    };
    std::process::exit(code);
}

fn fail(msg: &str) -> ! {
    eprintln!("u1-sim: {msg}\n\n{USAGE}{}", snap_studio_lib::sim::faults::NAMES.join(", "));
    std::process::exit(2);
}

/// Runs a scenario until stopped (Ctrl-C).
async fn run(args: &[String]) -> i32 {
    let mut name = "solo".to_string();
    let mut speed = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--speed" => speed = it.next().and_then(|v| v.trim_start_matches(['x', 'X']).parse::<f64>().ok()),
            s if s.starts_with("--") => fail(&format!("unknown option {s}")),
            s => name = s.to_string(),
        }
    }
    let s = match scenario::load(&name) {
        Ok(s) => s,
        Err(e) => fail(&format!("{e:#}")),
    };
    let factor = clock::factor(speed.or(s.speed).unwrap_or(1.0));
    let dir = std::env::temp_dir().join(format!("u1-sim-{}", std::process::id()));
    let farm = match Farm::start(&s, factor, &dir, Arc::new(clock::Clock::real())).await {
        Ok(f) => f,
        Err(e) => {
            eprintln!("u1-sim: {e:#}");
            return 1;
        }
    };
    println!("scenario {} at x{factor}, files in {}", s.name, dir.display());
    for p in &farm.printers {
        println!("{:24} http://127.0.0.1:{}  (id {})", p.name, p.port, p.id);
    }
    println!("Ctrl-C to stop.");
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}

/// A request to a running printer's `/sim/` path.
async fn control(port: Option<&String>, what: &str, body: Option<serde_json::Value>) -> i32 {
    let Some(port) = port.and_then(|p| p.trim_start_matches("127.0.0.1:").parse::<u16>().ok()) else { fail("which port?") };
    let url = format!("http://127.0.0.1:{port}/sim/{what}");
    let client = reqwest::Client::new();
    let r = match body {
        Some(b) => client.post(&url).json(&b).send().await,
        None => client.get(&url).send().await,
    };
    match r {
        Ok(r) => {
            let ok = r.status().is_success();
            let v: serde_json::Value = r.json().await.unwrap_or_default();
            println!("{}", serde_json::to_string_pretty(v.get("result").or(v.get("error")).unwrap_or(&v)).unwrap_or_default());
            if ok {
                0
            } else {
                1
            }
        }
        Err(e) => {
            eprintln!("u1-sim: {url}: {e}");
            1
        }
    }
}
