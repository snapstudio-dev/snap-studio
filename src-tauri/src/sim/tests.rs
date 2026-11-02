//! End-to-end tests: the app's own printer code (`printers`, `watch`,
//! `printer_files`, `control`, `bedmesh`, `maintenance`) against simulated
//! printers, over the wire, on a virtual clock the tests move by hand.

use super::clock::Clock;
use super::faults::Fault;
use super::fixtures::sample_gcode;
use super::scenario::{default_spools, load, SampleFile, Spool};
use super::server::{Farm, SimPrinter};
use crate::printers::{self, Printer, StartOptions, StartRoute, Status};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// The data folder the tests' app code writes to (never the user's).
pub static DATA: OnceLock<PathBuf> = OnceLock::new();

/// The tests' data folder, made on first use.
pub(crate) fn data_dir() -> &'static PathBuf {
    DATA.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("snapstudio-sim-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("tests' data folder");
        d
    })
}

/// A scenario running on a manual clock.
pub(crate) struct Sim {
    pub farm: Farm,
    pub rt: tokio::runtime::Runtime,
    pub dir: PathBuf,
}

static RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn start(scenario: &str) -> Sim {
    start_with(load(scenario).unwrap(), 1.0)
}

pub(crate) fn start_with(s: super::scenario::Scenario, factor: f64) -> Sim {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
    let n = RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("snapstudio-sim-e2e-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let farm = rt.block_on(Farm::start(&s, factor, &dir, Arc::new(Clock::manual()))).unwrap();
    Sim { farm, rt, dir }
}

impl Drop for Sim {
    fn drop(&mut self) {
        self.farm.stop();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Sim {
    pub fn p(&self, i: usize) -> &Arc<SimPrinter> {
        &self.farm.printers[i]
    }

    pub fn port(&self, i: usize) -> u16 {
        self.p(i).port
    }

    pub fn printer(&self, i: usize) -> Printer {
        Printer {
            id: self.p(i).id.clone(),
            name: self.p(i).name.clone(),
            host: "127.0.0.1".into(),
            port: self.port(i),
            model: "Snapmaker U1".into(),
            note: String::new(),
        }
    }

    pub fn run<F: Future>(&self, f: F) -> F::Output {
        self.rt.block_on(f)
    }

    /// Runs `f` while the clock moves `step` seconds at a time (an
    /// operation that waits on the printer).
    pub fn drive<F>(&self, f: F, step: f64) -> F::Output
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let h = self.rt.spawn(f);
        for _ in 0..5000 {
            if h.is_finished() {
                break;
            }
            self.farm.advance(step);
            std::thread::sleep(Duration::from_millis(15));
        }
        self.rt.block_on(h).expect("task")
    }

    pub fn advance(&self, secs: f64) {
        self.farm.advance(secs);
    }

    pub fn status(&self, i: usize) -> Status {
        self.run(printers::status("127.0.0.1", self.port(i)))
    }

    /// A sample G-code on disk, to send.
    pub fn gcode(&self, name: &str, tools: Vec<u8>, minutes: u32, layers: u32) -> PathBuf {
        let f = SampleFile { name: name.into(), tools, minutes, layers, materials: vec![], colors: vec![] };
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.dir.join(name);
        std::fs::write(&path, sample_gcode(&f, &default_spools())).unwrap();
        path
    }

    /// Uploads and starts a file as the app does (`lib.rs` `launch`).
    pub fn send(&self, i: usize, path: &std::path::Path, opts: StartOptions, tools: &[u8]) -> anyhow::Result<StartRoute> {
        let port = self.port(i);
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let path = path.to_path_buf();
        let tools = tools.to_vec();
        self.drive(
            async move {
                printers::gcode_script_checked("127.0.0.1", port, &printers::map_script(&tools, &[])).await?;
                printers::upload("127.0.0.1", port, &path, &name, false, |_, _| {}).await?;
                printers::start_print("127.0.0.1", port, &name, &opts, &tools, &[]).await
            },
            0.5,
        )
    }
}

#[test]
fn probe_and_status() {
    let s = start("solo");
    let probe = s.run(printers::probe("127.0.0.1", s.port(0)));
    assert!(probe.ok, "{}", probe.detail);
    assert_eq!((probe.hostname.as_deref(), probe.api.as_deref(), probe.port), (Some("sim-alpha"), Some("moonraker"), s.port(0)));
    let st = s.status(0);
    assert!(st.online && !st.partial);
    assert_eq!(st.state, "standby");
    assert_eq!(st.hostname.as_deref(), Some("sim-alpha"));
    assert_eq!(st.klipper.as_deref(), Some("ready"));
    assert_eq!((st.nozzles.len(), st.filaments.len()), (4, 4));
    assert_eq!(st.filaments[3].color.as_deref(), Some("#2f6fd6"));
    assert!(st.bed.is_some());
    // Not an OctoPrint: a 404 there.
    let r = s.run(printers::get_json(&format!("http://127.0.0.1:{}/api/version", s.port(0))));
    assert!(r.is_err());
}

#[test]
fn a_farm_at_launch() {
    let s = start("farm");
    let states: Vec<String> = (0..4).map(|i| s.status(i).state).collect();
    assert_eq!(states, ["standby", "printing", "paused", "standby"]);
    let bravo = s.status(1);
    assert!((bravo.progress.unwrap() - 0.4).abs() < 0.01, "{:?}", bravo.progress);
    assert_eq!(bravo.job.as_deref(), Some("Planter_Two_Tone.gcode"));
    assert!(bravo.layer.is_some_and(|(c, t)| t == 240 && (90..=100).contains(&c)), "{:?}", bravo.layer);
    let charlie = s.status(2);
    assert!(charlie.message.as_deref().is_some_and(|m| m.contains("runout")), "{:?}", charlie.message);
    assert!(!charlie.filaments[1].present);
    // Delta: an empty head.
    assert!(!s.status(3).filaments[2].present);
}

#[test]
fn live_feed_and_reconnect() {
    let s = start("solo");
    let p = s.printer(0);
    let seen: Arc<Mutex<Vec<(bool, Status)>>> = Arc::default();
    let session = s.rt.spawn(printers_session(p.clone(), seen.clone()));
    // The first snapshot, then a pushed change.
    wait_until(&s, || seen.lock().unwrap().iter().any(|(_, st)| st.nozzles.len() == 4));
    s.p(0).lock().bed.target = 60.0;
    s.advance(5.0);
    wait_until(&s, || seen.lock().unwrap().iter().any(|(_, st)| st.bed.as_ref().is_some_and(|b| b.target == 60.0 && b.current > 25.0)));
    let last = seen.lock().unwrap().last().unwrap().1.clone();
    assert_eq!(last.hostname.as_deref(), Some("sim-alpha"));
    assert_eq!(last.filaments.len(), 4, "a partial update keeps the rest");
    // Dropped: the session ends, a new one is refused meanwhile…
    s.p(0).inject(Fault::Disconnect { secs: 30.0 });
    let r = s.rt.block_on(async { tokio::time::timeout(Duration::from_secs(5), session).await });
    assert!(r.is_ok(), "the session ended");
    let refused = s.run(crate::watch::session_with(&p, &|_, _| {}));
    assert!(refused.is_err());
    assert!(!s.status(0).online);
    // …and accepted again once it is over.
    s.advance(31.0);
    let seen2: Arc<Mutex<Vec<(bool, Status)>>> = Arc::default();
    let again = s.rt.spawn(printers_session(p, seen2.clone()));
    wait_until(&s, || seen2.lock().unwrap().iter().any(|(live, st)| *live && st.nozzles.len() == 4));
    again.abort();
}

async fn printers_session(p: Printer, sink: Arc<Mutex<Vec<(bool, Status)>>>) -> anyhow::Result<()> {
    crate::watch::session_with(&p, &move |live, st| sink.lock().unwrap().push((live, st))).await
}

fn wait_until(s: &Sim, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        s.advance(1.0);
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("never happened");
}

#[test]
fn send_and_print_with_start_local_print() {
    let s = start("solo");
    let file = s.gcode("Cube-1a2b3c.gcode", vec![0, 2], 30, 12);
    let opts = StartOptions { bed_leveling: true, flow_calibration: false, timelapse: true };
    assert_eq!(s.send(0, &file, opts, &[0, 2]).unwrap(), StartRoute::Orca);
    // The options as the printer applied them.
    let cfg = s.run(printers::task_config("127.0.0.1", s.port(0))).unwrap();
    assert!(printers::unapplied_options(&cfg, &opts).is_empty(), "{cfg}");
    assert_eq!(cfg["extruders_used"], serde_json::json!([0, 2]));
    let st = s.status(0);
    assert_eq!((st.state.as_str(), st.job.as_deref()), ("printing", Some("Cube-1a2b3c.gcode")));
    // Busy: a second print is refused, without another way.
    let again = s.send(0, &file, StartOptions::default(), &[0]);
    assert!(again.is_err_and(|e| e.to_string().contains("busy")));
    // Pause, resume.
    s.run(printers::print_action("127.0.0.1", s.port(0), "pause")).unwrap();
    assert_eq!(s.status(0).state, "paused");
    s.run(printers::print_action("127.0.0.1", s.port(0), "resume")).unwrap();
    // Halfway (preamble: 60 s of heating, 180 s of leveling).
    s.advance(240.0 + 900.0);
    let st = s.status(0);
    assert!((st.progress.unwrap() - 0.5).abs() < 0.02, "{:?}", st.progress);
    assert!(st.layer.is_some_and(|(c, t)| t == 12 && (6..=7).contains(&c)), "{:?}", st.layer);
    assert!(st.nozzles.iter().any(|n| n.active && (n.index == 0 || n.index == 2)));
    assert!(st.filament_mm.unwrap() > 0.0);
    // To the end: complete, in the history, with its timelapse.
    s.advance(1000.0);
    let st = s.status(0);
    assert_eq!((st.state.as_str(), st.progress), ("complete", Some(1.0)));
    let o = s.run(crate::printer_files::overview("127.0.0.1", s.port(0), None)).unwrap();
    let f = o.files.iter().find(|f| f.path == "Cube-1a2b3c.gcode").unwrap();
    assert_eq!(f.last.as_ref().map(|l| l.status.as_str()), Some("completed"));
    assert_eq!(f.meta.as_ref().unwrap().tools, vec![0, 2]);
    assert!(o.videos.len() >= 3, "the new timelapse with the old ones: {}", o.videos.len());
    // The tool changes counted.
    let u = s.run(crate::maintenance::usage("127.0.0.1", s.port(0))).unwrap();
    assert!(u.heads[0].switch_count > 412 && u.heads[2].switch_count > 251, "{:?}", u.heads);
}

#[test]
fn the_legacy_route_and_refusals() {
    let s = start("solo");
    let file = s.gcode("Part.gcode", vec![1], 10, 5);
    // A firmware without start_local_print: SET_PRINT_PREFERENCES then print/start.
    s.p(0).inject(Fault::NoStartLocalPrint);
    let opts = StartOptions { bed_leveling: false, flow_calibration: true, timelapse: false };
    assert_eq!(s.send(0, &file, opts, &[1]).unwrap(), StartRoute::Legacy);
    let cfg = s.run(printers::task_config("127.0.0.1", s.port(0))).unwrap();
    assert!(printers::unapplied_options(&cfg, &opts).is_empty());
    s.run(printers::print_action("127.0.0.1", s.port(0), "cancel")).unwrap();
    assert_eq!(s.status(0).state, "cancelled");
    s.p(0).clear_faults();
    // A refusal is final.
    s.p(0).inject(Fault::StartRefused { message: Some("Nozzle mismatch".into()) });
    let e = s.send(0, &file, opts, &[1]).unwrap_err();
    assert!(e.to_string().contains("Nozzle mismatch"), "{e}");
    assert_eq!(s.status(0).state, "cancelled", "not started another way");
    s.p(0).clear_faults();
    // An upload cut halfway, a full disk.
    s.p(0).inject(Fault::UploadFail { at: 50.0 });
    assert!(s.send(0, &file, opts, &[1]).is_err());
    s.p(0).clear_faults();
    s.p(0).inject(Fault::DiskFull);
    let e = s.send(0, &file, opts, &[1]).unwrap_err();
    assert!(e.to_string().contains("507"), "{e}");
    let o = s.run(crate::printer_files::overview("127.0.0.1", s.port(0), None)).unwrap();
    assert!(o.disk.unwrap().free <= 1_000_000);
    // An empty head is refused.
    s.p(0).clear_faults();
    s.p(0).set_spool(1, Spool::empty());
    let e = s.send(0, &file, opts, &[1]).unwrap_err();
    assert!(e.to_string().contains("extruder1"), "{e}");
}

#[test]
fn printer_files() {
    let s = start("solo");
    let port = s.port(0);
    let o = s.run(crate::printer_files::overview("127.0.0.1", port, None)).unwrap();
    assert_eq!(o.files.len(), 3);
    let coaster = o.files.iter().find(|f| f.path == "Four_Color_Coaster.gcode").unwrap();
    let m = coaster.meta.as_ref().unwrap();
    assert_eq!((m.tools.clone(), m.layer_count, m.estimated_time), (vec![0, 1, 2, 3], Some(16), Some(95.0 * 60.0)));
    assert_eq!(m.thumb.as_deref(), Some(".thumbs/Four_Color_Coaster-300x300.png"));
    assert_eq!(o.video_roots.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["camera"]);
    assert_eq!(o.videos.len(), 2, "the two completed prints of the history");
    assert!(o.videos.iter().all(|v| !v.writable && v.thumb.is_some()));
    assert_eq!(s.run(crate::printer_files::count("127.0.0.1", port)).unwrap(), 3);
    assert_eq!(s.run(crate::printer_files::tools("127.0.0.1", port, "Cable_Clip.gcode", 1.0)).unwrap(), vec![1]);
    // A thumbnail through the proxy, a video by pieces, its duration.
    let t = s.run(crate::printer_files::proxy("127.0.0.1", port, "gcodes", m.thumb.as_deref().unwrap(), None)).unwrap();
    assert!(t.body.starts_with(b"\x89PNG"));
    let v = o.videos[0].clone();
    let r = s.run(crate::printer_files::proxy("127.0.0.1", port, "camera", &v.path, Some("bytes=0-1"))).unwrap();
    assert_eq!((r.status, r.body.len()), (206, 2));
    let d = s.run(crate::printer_files::video_duration("127.0.0.1", port, "camera", &v.path, v.modified)).unwrap();
    assert!(d.is_some_and(|d| d > 0.0));
    // Rename, download, delete.
    let new = s.run(crate::printer_files::rename("127.0.0.1", port, "Cable_Clip.gcode", "Clip")).unwrap();
    assert_eq!(new, "Clip.gcode");
    let got = s.run(crate::printer_files::download("127.0.0.1", port, "gcodes", "Clip.gcode", &s.dir)).unwrap();
    assert!(std::fs::read_to_string(got).unwrap().contains("; total layer number: 30"));
    s.run(crate::printer_files::delete_retrying("127.0.0.1", port, "gcodes", "Clip.gcode")).unwrap();
    // A timelapse: Moonraker refuses (read-only camera), the camera service deletes.
    s.run(crate::printer_files::delete_video("127.0.0.1", port, "camera", &v.path)).unwrap();
    let o = s.run(crate::printer_files::overview("127.0.0.1", port, None)).unwrap();
    assert_eq!((o.files.len(), o.videos.len()), (2, 1));
}

#[test]
fn control() {
    use crate::control::{read, run, Action};
    let s = start("solo");
    let port = s.port(0);
    let (st, cfg) = s.run(read("127.0.0.1", port, true)).unwrap();
    let cfg = cfg.unwrap();
    assert!(cfg.u1 && cfg.materials.iter().any(|m| m.kind == "PETG"));
    assert_eq!((st.homed.as_str(), st.main_state.as_str()), ("", "IDLE"));
    // Refused before homing; then accepted.
    assert!(s.run(run("127.0.0.1", port, &Action::Jog { axis: "x".into(), dist: 10.0 })).is_err());
    s.drive(async move { run("127.0.0.1", port, &Action::Home { axes: "xyz".into() }).await }, 1.0).unwrap();
    s.drive(async move { run("127.0.0.1", port, &Action::Jog { axis: "x".into(), dist: 10.0 }).await }, 1.0).unwrap();
    s.drive(async move { run("127.0.0.1", port, &Action::Tool { n: 3 }).await }, 1.0).unwrap();
    s.run(run("127.0.0.1", port, &Action::NozzleTemp { n: 3, temp: 210.0 })).unwrap();
    s.run(run("127.0.0.1", port, &Action::Light { on: false })).unwrap();
    let (st, _) = s.run(read("127.0.0.1", port, false)).unwrap();
    assert_eq!((st.position[0], st.active, st.heads[3].target, st.light), (145.0, Some(3), 210.0, Some(false)));
    // A material declared, as the screen does.
    let f = Action::Filament { n: 1, vendor: "Generic".into(), material: "PETG".into(), sub_type: "HF".into(), color: "#00aa55".into() };
    s.run(run("127.0.0.1", port, &f)).unwrap();
    assert_eq!(s.status(0).filaments[1].kind, "PETG");
    // An unknown command is a failure, not a silent success.
    let e = s.run(printers::gcode_script_checked("127.0.0.1", port, "NOT_A_U1_MACRO")).unwrap_err();
    assert!(e.to_string().contains("NOT_A_U1_MACRO"), "{e}");
    // The emergency stop, then the restart.
    s.run(run("127.0.0.1", port, &Action::EmergencyStop)).unwrap();
    assert_eq!(s.status(0).klipper.as_deref(), Some("shutdown"));
    s.run(run("127.0.0.1", port, &Action::FirmwareRestart)).unwrap();
    assert_eq!(s.status(0).klipper.as_deref(), Some("ready"));
}

#[test]
fn bed_mesh_measure_and_abort() {
    let s = start("solo");
    let port = s.port(0);
    let before = s.run(crate::bedmesh::read("127.0.0.1", port, false)).unwrap();
    assert!(before.supported && before.mesh.is_some());
    assert_eq!(before.last_job.as_ref().map(|j| j.filename.as_str()), Some("Calibration_Cube.gcode"));
    s.drive(async move { crate::bedmesh::measure("127.0.0.1", port, 60.0).await }, 2.0).unwrap();
    let after = s.run(crate::bedmesh::read("127.0.0.1", port, true)).unwrap();
    assert_ne!(after.mesh.unwrap().points, before.mesh.unwrap().points);
    assert_eq!(after.progress.unwrap().state, "completed");
    assert_eq!(after.bed.unwrap().target, 0.0, "the bed turned off");
    // Aborted while probing.
    let m = s.rt.spawn(async move { crate::bedmesh::measure("127.0.0.1", port, 55.0).await });
    wait_until(&s, || s.p(0).lock().probe.state == "probing");
    s.run(crate::bedmesh::abort("127.0.0.1", port)).unwrap();
    s.advance(5.0);
    assert!(s.run(m).unwrap().is_err());
    assert_eq!(s.run(crate::bedmesh::read("127.0.0.1", port, true)).unwrap().progress.unwrap().state, "aborted");
}

#[test]
fn maintenance_counters() {
    let s = start("solo");
    let u = s.run(crate::maintenance::usage("127.0.0.1", s.port(0))).unwrap();
    assert_eq!(u.heads.iter().map(|h| h.switch_count).collect::<Vec<_>>(), [412, 388, 251, 240]);
    assert_eq!(u.jobs, 3);
    assert!(u.print_hours > 0.0 && u.purifier_hours.is_some());
}

#[test]
fn faults() {
    let s = start("solo");
    let port = s.port(0);
    // Klipper shut down, then restarted. Idle, `print_stats` stays
    // `standby` as on Klipper: the state is Klipper's.
    let live: Arc<Mutex<Vec<(bool, Status)>>> = Arc::default();
    let feed = s.rt.spawn(printers_session(s.printer(0), live.clone()));
    wait_until(&s, || live.lock().unwrap().iter().any(|(_, st)| st.nozzles.len() == 4));
    s.p(0).inject(Fault::KlippyShutdown { message: None });
    assert_eq!(s.status(0).klipper.as_deref(), Some("shutdown"));
    let info = s.run(printers::get_json(&format!("http://127.0.0.1:{port}/printer/info"))).unwrap();
    assert!(info["result"]["state_message"].as_str().is_some_and(|m| m.contains("shutdown")), "{info}");
    wait_until(&s, || live.lock().unwrap().last().is_some_and(|(_, st)| st.state == "error"));
    s.run(printers::post_path("127.0.0.1", port, "/printer/firmware_restart")).unwrap();
    wait_until(&s, || live.lock().unwrap().last().is_some_and(|(_, st)| st.state == "standby"));
    feed.abort();
    assert_eq!(s.status(0).klipper.as_deref(), Some("ready"));
    // Klipper disconnected.
    s.p(0).inject(Fault::KlippyError { message: None });
    let st = s.status(0);
    assert!(st.online && st.state == "error");
    s.run(printers::post_path("127.0.0.1", port, "/printer/firmware_restart")).unwrap();
    // The camera.
    s.run(printers::camera_start("127.0.0.1", port)).unwrap();
    let jpg = s.run(printers::camera_frame("127.0.0.1", port)).unwrap();
    assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
    s.advance(11.0);
    assert!(s.run(printers::camera_frame("127.0.0.1", port)).is_err(), "off after 10 s without a restart");
    s.p(0).inject(Fault::CameraOff);
    assert!(s.run(printers::camera_start("127.0.0.1", port)).is_err());
    s.p(0).clear_faults();
    // A head that fails to pick: Control's error, the counters.
    s.p(0).inject(Fault::HeadPickFail);
    let e = s.drive(async move { crate::control::run("127.0.0.1", port, &crate::control::Action::Tool { n: 1 }).await }, 1.0);
    assert!(e.is_err());
    let u = s.run(crate::maintenance::usage("127.0.0.1", port)).unwrap();
    assert_eq!((u.heads[1].error_count, u.heads[1].retry_count), (1, 1));
    // Slow: past the app's 4 s, the status says offline.
    s.p(0).inject(Fault::Slow { ms: 4500 });
    assert!(!s.status(0).online);
    s.p(0).clear_faults();
    // Unreachable: the port closed, then open again.
    s.p(0).inject(Fault::Unreachable { secs: 20.0 });
    std::thread::sleep(Duration::from_millis(100));
    let p = s.run(printers::probe("127.0.0.1", port));
    assert!(!p.ok);
    s.advance(21.0);
    std::thread::sleep(Duration::from_millis(300));
    assert!(s.status(0).online);
}

#[test]
fn runout_and_print_error() {
    let s = start("solo");
    let file = s.gcode("Two.gcode", vec![0, 1], 20, 10);
    s.send(0, &file, StartOptions::default(), &[0, 1]).unwrap();
    s.advance(200.0);
    s.p(0).inject(Fault::Runout { head: 1 });
    let st = s.status(0);
    assert_eq!(st.state, "paused");
    assert!(st.message.as_deref().is_some_and(|m| m.contains("extruder1")));
    // No resume before the filament is back.
    assert!(s.run(printers::print_action("127.0.0.1", s.port(0), "resume")).is_err());
    s.p(0).set_spool(1, default_spools()[1].clone());
    s.run(printers::print_action("127.0.0.1", s.port(0), "resume")).unwrap();
    assert_eq!(s.status(0).state, "printing");
    s.p(0).inject(Fault::PrintError { message: None });
    let st = s.status(0);
    assert_eq!(st.state, "error");
    let h = s.run(printers::get_json(&format!("http://127.0.0.1:{}/server/history/list?limit=1", s.port(0)))).unwrap();
    assert_eq!(h["result"]["jobs"][0]["status"], "error");
}

/// A long print at ×600 still lasts the 2 min floor.
#[test]
fn time_factor_and_floor() {
    let s = start_with(load("solo").unwrap(), 600.0);
    let file = s.gcode("Long.gcode", vec![0], 120, 20);
    s.send(0, &file, StartOptions::default(), &[0]).unwrap();
    s.advance(60.0);
    let st = s.status(0);
    assert_eq!(st.state, "printing");
    assert!(st.progress.unwrap() > 0.4 && st.progress.unwrap() < 0.6, "{:?}", st.progress);
    s.advance(61.0);
    assert_eq!(s.status(0).state, "complete");
}

/// The control path and a scenario's scheduled fault.
#[test]
fn control_path() {
    let s = start("trouble");
    assert_eq!(s.status(2).klipper.as_deref(), Some("shutdown"));
    let v = s.run(printers::get_json(&format!("http://127.0.0.1:{}/sim/status", s.port(2)))).unwrap();
    assert_eq!(v["result"]["klippy"], "shutdown");
    // A fault through the control path, as `u1-sim fault` sends it.
    let r = s.run(async {
        printers::client()
            .post(format!("http://127.0.0.1:{}/sim/fault", s.port(0)))
            .json(&serde_json::json!({ "fault": "slow", "ms": 100 }))
            .send()
            .await
    });
    assert!(r.unwrap().status().is_success());
    assert!(s.p(0).lock().fault_names().contains(&"slow"));
    // Echo's scheduled disconnection.
    s.advance(91.0);
    assert!(!s.status(0).online);
    s.advance(21.0);
    assert!(s.status(0).online);
}
