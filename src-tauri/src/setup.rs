//! What the AI needs on this machine, mode by mode.
//!
//! Three ways to run Claude: in Claude Code's own sandbox (Seatbelt on
//! macOS, bubblewrap and socat on Linux, plus Python and the modeling
//! modules), in a container (yolobox and a container engine), or directly
//! on this Mac (Python and the modules, which Claude runs itself). All need
//! Claude Code, recent enough for the chat view's protocol, and a signed-in
//! account. The checks are quick and bounded — no model call, no image
//! build — and run side by side.
//!
//! Nothing here installs anything: the UI says how to.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Oldest Claude Code tested with the chat view (stream-json control
/// protocol, `auth status --json`).
pub const MIN_CLAUDE: (u32, u32, u32) = (2, 1, 286);

/// The modules Claude's tools import (see `ia_tools/`).
pub const MODULES: [&str; 3] = ["trimesh", "manifold3d", "numpy"];

/// Container engines yolobox can drive, in order of preference.
const RUNTIMES: [&str; 3] = ["docker", "podman", "container"];

/// A check's outcome.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Ok,
    /// Not installed.
    Missing,
    /// Installed, but older than needed.
    TooOld,
    /// Installed, but not running (a container engine).
    Stopped,
    /// Claude is not signed in.
    SignedOut,
    /// Could not be checked because something it needs is missing.
    Skipped,
    /// Not available on this system.
    Unsupported,
    /// Nothing to check, something to know.
    Info,
}

#[derive(Serialize, Clone, Debug)]
pub struct Item {
    /// "claude", "account", "sandbox_account", "yolobox", "runtime", "image",
    /// "seatbelt", "bwrap", "socat", "builtin" (unsupported), "python" or a
    /// module name.
    pub key: String,
    pub state: State,
    /// The modes it serves: "sandbox", "container", "local".
    pub modes: Vec<&'static str>,
    /// Version found, engine name… whatever helps the UI say it.
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Ready {
    /// Claude Code's built-in sandbox.
    pub sandbox: bool,
    /// yolobox.
    pub container: bool,
    pub local: bool,
}

/// What to check: yolobox and the container engines only when they matter
/// (yolobox chosen, a container conversation, its option shown), so that a
/// built-in sandbox does not wait on `docker info`.
#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(default)]
pub struct CheckScope {
    pub yolobox: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Report {
    pub items: Vec<Item>,
    pub ready: Ready,
    /// The running container engine yolobox is told to use.
    pub runtime: Option<String>,
    /// "macos", "windows" or "linux": install instructions differ.
    pub os: &'static str,
    pub min_claude: String,
    /// The Python found refuses `pip install` outside a virtual environment
    /// (PEP 668: Homebrew's, Debian's…): the install command needs
    /// `--break-system-packages`.
    pub python_managed: bool,
    /// yolobox and the engines were checked (`CheckScope`).
    pub yolobox_checked: bool,
}

/// What every mode needs (Claude Code, an account).
const ALL: [&str; 3] = ["sandbox", "container", "local"];
/// Python and its modules: Claude runs them itself, confined or not.
const HOST: [&str; 2] = ["local", "sandbox"];

fn item(key: &str, state: State, modes: &[&'static str], detail: Option<String>) -> Item {
    Item { key: key.to_string(), state, modes: modes.to_vec(), detail }
}

// ------------------------------------------------------------ running things

/// Runs a command with a deadline: its success and standard output, or
/// `None` if it could not start or took too long.
fn probe(program: &Path, args: &[&str], deadline: Duration) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(p) = crate::pty::child_path() {
        cmd.env("PATH", p);
    }
    crate::util::no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let end = Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some((status.success(), reader.join().unwrap_or_default())),
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// "2.1.286 (Claude Code)" → (2, 1, 286).
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let word = s.split_whitespace().map(|w| w.trim_start_matches('v')).find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut n = word.split('.').map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u32>().ok());
    Some((n.next()??, n.next().flatten().unwrap_or(0), n.next().flatten().unwrap_or(0)))
}

fn version_str(v: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

// ------------------------------------------------------------ the checks

fn check_claude() -> Item {
    let Some(bin) = crate::util::which("claude") else {
        return item("claude", State::Missing, &ALL, None);
    };
    // A slow machine takes a while to answer `--version` (Node starts up):
    // long enough not to take silence for an unknown version.
    let version = probe(&bin, &["--version"], Duration::from_secs(20)).and_then(|(_, out)| parse_version(&out));
    match version {
        Some(v) if v >= MIN_CLAUDE => item("claude", State::Ok, &ALL, Some(version_str(v))),
        Some(v) => item("claude", State::TooOld, &ALL, Some(version_str(v))),
        // Present but silent: let the account check say more (its own call
        // fails on a Claude too old for the protocol).
        None => item("claude", State::Ok, &ALL, None),
    }
}

/// The Mac's sign-in, and the container's own token: the container is
/// signed in with either; the built-in sandbox uses the Mac's.
fn check_accounts(claude_ok: bool) -> Vec<Item> {
    if !claude_ok {
        return vec![item("account", State::Skipped, &ALL, None)];
    }
    let host = crate::auth::status("local");
    let token = crate::auth::sandbox_token().is_some();
    let who = host.email.clone();
    match (host.logged_in, token) {
        (true, _) => vec![item("account", State::Ok, &ALL, who)],
        (false, true) => vec![item("account", State::SignedOut, &HOST, None), item("sandbox_account", State::Ok, &["container"], None)],
        (false, false) => vec![item("account", State::SignedOut, &ALL, None)],
    }
}

/// A container engine's state: running, installed but stopped, or absent.
fn runtime_state(name: &str) -> State {
    let Some(bin) = crate::util::which(name) else {
        return State::Missing;
    };
    let args: &[&str] = match name {
        "docker" => &["info", "--format", "{{.ServerVersion}}"],
        "podman" => &["info", "--format", "{{.Host.Arch}}"],
        _ => &["system", "status"],
    };
    // A cold Docker Desktop answers `info` in a few seconds: not "stopped".
    match probe(&bin, args, Duration::from_secs(8)) {
        Some((true, _)) => State::Ok,
        _ => State::Stopped,
    }
}

fn check_sandbox() -> (Vec<Item>, Option<String>) {
    if cfg!(windows) {
        return (vec![item("runtime", State::Unsupported, &["container"], None)], None);
    }
    let mut items =
        vec![item("yolobox", if crate::util::which("yolobox").is_some() { State::Ok } else { State::Missing }, &["container"], None)];
    let states: Vec<(String, State)> = std::thread::scope(|s| {
        let handles: Vec<_> = RUNTIMES.iter().map(|r| s.spawn(move || (r.to_string(), runtime_state(r)))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let running = states.iter().find(|(_, st)| *st == State::Ok).map(|(n, _)| n.clone());
    let installed: Vec<String> = states.iter().filter(|(_, st)| *st != State::Missing).map(|(n, _)| n.clone()).collect();
    let runtime = match (&running, installed.is_empty()) {
        (Some(n), _) => item("runtime", State::Ok, &["container"], Some(n.clone())),
        (None, false) => item("runtime", State::Stopped, &["container"], Some(installed.join(", "))),
        (None, true) => item("runtime", State::Missing, &["container"], None),
    };
    items.push(runtime);
    items.push(item("image", State::Info, &["container"], None));
    (items, running)
}

/// Claude Code's built-in sandbox: Seatbelt on macOS (`sandbox-exec`),
/// bubblewrap and socat on Linux — installed, which is all that is checked
/// (AppArmor may still stop bwrap: Claude then refuses to start and says
/// so). None on Windows.
fn check_builtin() -> Vec<Item> {
    let sb = ["sandbox"];
    if cfg!(windows) {
        return vec![item("builtin", State::Unsupported, &sb, None)];
    }
    if cfg!(target_os = "macos") {
        let ok = Path::new("/usr/bin/sandbox-exec").exists();
        return vec![item("seatbelt", if ok { State::Ok } else { State::Missing }, &sb, None)];
    }
    ["bwrap", "socat"]
        .iter()
        .map(|t| item(t, if crate::util::which(t).is_some() { State::Ok } else { State::Missing }, &sb, None))
        .collect()
}

/// On macOS, `/usr/bin/python3` is a stub that offers to install the
/// developer tools when they are missing: it is not run in that case.
fn usable_python() -> Option<PathBuf> {
    let p = crate::util::which("python3")?;
    if cfg!(target_os = "macos") && p == Path::new("/usr/bin/python3") {
        let tools = probe(Path::new("/usr/bin/xcode-select"), &["-p"], Duration::from_secs(3));
        if !matches!(tools, Some((true, _))) {
            return None;
        }
    }
    Some(p)
}

/// Python's version, whether pip is restricted, and which modules import,
/// in one run.
fn check_python() -> (Vec<Item>, bool) {
    let Some(py) = usable_python() else {
        let mut v = vec![item("python", State::Missing, &HOST, None)];
        v.extend(MODULES.iter().map(|m| item(m, State::Skipped, &HOST, None)));
        return (v, false);
    };
    // Its folders too: those under the home are re-opened, read only, to the
    // built-in sandbox, which hides the home (`sandbox_read_paths`).
    let script = format!(
        "import sys, os, site, sysconfig, importlib\nprint('python', sys.version.split()[0])\nprint('managed', os.path.exists(os.path.join(sysconfig.get_paths()['stdlib'], 'EXTERNALLY-MANAGED')))\nfor m in {MODULES:?}:\n    try:\n        importlib.import_module(m)\n        print(m, 'ok')\n    except Exception as e:\n        print(m, 'missing', (type(e).__name__ + ': ' + str(e)).replace(chr(10), ' ')[:300])\nfor p in [sys.prefix, sys.base_prefix, site.getusersitepackages()] + sys.path:\n    if p:\n        print('path', os.path.realpath(p))\n"
    );
    let out = probe(&py, &["-c", &script], Duration::from_secs(30)).map(|(_, o)| o).unwrap_or_default();
    *last_python_paths().lock().unwrap() = Some(python_paths(&out));
    (parse_python(&out), out.lines().any(|l| l.trim() == "managed True"))
}

/// The folders `check_python`'s script printed.
fn python_paths(out: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = out.lines().filter_map(|l| l.strip_prefix("path ")).map(|p| PathBuf::from(p.trim())).collect();
    v.dedup();
    v
}

/// Roots the built-in sandbox hides from commands (with
/// `blockReadsOutsideWorkingDirectories`), the home among them.
const BLOCKED_ROOTS: [&str; 8] = ["/Users", "/home", "/root", "/Volumes", "/mnt", "/media", "/run/media", "/srv"];

/// Of Python's folders, those the sandbox would hide: under the home or a
/// blocked root. Homebrew's and the system's need nothing.
fn blocked_reads(paths: &[PathBuf], home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in paths {
        let hidden = home.is_some_and(|h| p.starts_with(h)) || BLOCKED_ROOTS.iter().any(|r| p.starts_with(r));
        // A folder already re-opened covers what is inside it.
        if hidden && p.is_absolute() && !out.iter().any(|o| p.starts_with(o)) {
            out.retain(|o| !o.starts_with(p));
            out.push(p.clone());
        }
    }
    out
}

fn last_python_paths() -> &'static Mutex<Option<Vec<PathBuf>>> {
    static P: Mutex<Option<Vec<PathBuf>>> = Mutex::new(None);
    &P
}

/// What a built-in sandbox re-opens, read only: Python's folders it would
/// hide. Read at the last check, or now if none ran yet.
pub fn sandbox_read_paths() -> Vec<PathBuf> {
    if last_python_paths().lock().unwrap().is_none() {
        let _ = check_python();
    }
    let paths = last_python_paths().lock().unwrap().clone().unwrap_or_default();
    blocked_reads(&paths, dirs::home_dir().as_deref())
}

/// The output of `check_python`'s script.
fn parse_python(out: &str) -> Vec<Item> {
    let modes = HOST;
    let line = |key: &str| out.lines().find_map(|l| l.strip_prefix(&format!("{key} ")).map(str::trim));
    let mut v = vec![match line("python") {
        Some(ver) => item("python", State::Ok, &modes, Some(ver.to_string())),
        None => item("python", State::Missing, &modes, None),
    }];
    let python_ok = v[0].state == State::Ok;
    for m in MODULES {
        // A module that does not import says why: Python's own error.
        let (st, why) = match line(m) {
            Some("ok") => (State::Ok, None),
            _ if !python_ok => (State::Skipped, None),
            Some(l) => (State::Missing, l.strip_prefix("missing").map(str::trim).filter(|w| !w.is_empty()).map(String::from)),
            None => (State::Missing, None),
        };
        v.push(item(m, st, &modes, why));
    }
    v
}

/// A mode is ready when every check that serves it passes.
fn readiness(items: &[Item]) -> Ready {
    let ready = |mode: &str| items.iter().filter(|i| i.modes.contains(&mode) && i.state != State::Info).all(|i| i.state == State::Ok);
    Ready { sandbox: ready("sandbox"), container: ready("container"), local: ready("local") }
}

/// The running container engine, as last checked.
fn last_runtime() -> &'static Mutex<Option<String>> {
    static R: Mutex<Option<String>> = Mutex::new(None);
    &R
}

/// The engine yolobox should use: the one found running at the last check.
/// `None` lets yolobox pick.
pub fn runtime() -> Option<String> {
    last_runtime().lock().unwrap().clone()
}

/// yolobox's flags for the engine to use, after its subcommand.
pub fn runtime_args() -> Vec<String> {
    runtime().map(|r| vec!["--runtime".to_string(), r]).unwrap_or_default()
}

/// Everything the AI needs, mode by mode; yolobox and its engines only when
/// `scope` asks (otherwise the container mode is not ready, not checked).
pub fn check(scope: CheckScope) -> Report {
    let (claude, sandbox, python, builtin) = std::thread::scope(|s| {
        let c = s.spawn(|| {
            let claude = check_claude();
            let ok = claude.state == State::Ok;
            (claude, check_accounts(ok))
        });
        let b = s.spawn(move || scope.yolobox.then(check_sandbox));
        let p = s.spawn(check_python);
        let i = s.spawn(check_builtin);
        (c.join().unwrap(), b.join().unwrap(), p.join().unwrap(), i.join().unwrap())
    });
    let (claude, accounts) = claude;
    let (python, python_managed) = python;
    let mut items = vec![claude];
    items.extend(accounts);
    items.extend(builtin);
    let running = match sandbox {
        Some((sandbox_items, running)) => {
            items.extend(sandbox_items);
            *last_runtime().lock().unwrap() = running.clone();
            running
        }
        None => runtime(),
    };
    items.extend(python);
    let mut ready = readiness(&items);
    ready.container &= scope.yolobox;
    Report {
        ready,
        yolobox_checked: scope.yolobox,
        items,
        runtime: running,
        os: if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        },
        min_claude: version_str(MIN_CLAUDE),
        python_managed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_and_compared() {
        assert_eq!(parse_version("2.1.286 (Claude Code)"), Some((2, 1, 286)));
        assert_eq!(parse_version("v0.19.7"), Some((0, 19, 7)));
        assert_eq!(parse_version("Python 3.12.4"), Some((3, 12, 4)));
        assert_eq!(parse_version("3.13.0rc1"), Some((3, 13, 0)));
        assert_eq!(parse_version("nothing"), None);
        assert!(parse_version("2.1.290").unwrap() >= MIN_CLAUDE);
        assert!(parse_version("2.0.999").unwrap() < MIN_CLAUDE);
        assert!(parse_version("3.0").unwrap() >= MIN_CLAUDE);
    }

    #[test]
    fn python_output_is_read() {
        let v = parse_python("python 3.12.4\ntrimesh ok\nmanifold3d missing\nnumpy ok\n");
        let st = |k: &str| v.iter().find(|i| i.key == k).unwrap().state;
        assert_eq!(st("python"), State::Ok);
        assert_eq!(st("trimesh"), State::Ok);
        assert_eq!(st("manifold3d"), State::Missing);
        assert_eq!(v[0].detail.as_deref(), Some("3.12.4"));
        // Its error says why, when Python gave one.
        let v = parse_python("python 3.15.0\ntrimesh ok\nmanifold3d missing ImportError: dlopen(manifold3d.so): Library not loaded\nnumpy missing ModuleNotFoundError: No module named 'numpy'\n");
        let why = |k: &str| v.iter().find(|i| i.key == k).unwrap().detail.clone();
        assert_eq!(why("manifold3d").as_deref(), Some("ImportError: dlopen(manifold3d.so): Library not loaded"));
        assert_eq!(why("numpy").as_deref(), Some("ModuleNotFoundError: No module named 'numpy'"));
        assert_eq!(why("trimesh"), None);
        // Python did not run: the modules could not be checked.
        let none = parse_python("");
        assert!(none[1..].iter().all(|i| i.state == State::Skipped));
    }

    #[test]
    fn a_mode_is_ready_only_when_all_its_checks_pass() {
        let items = vec![
            item("claude", State::Ok, &ALL, None),
            item("account", State::Ok, &ALL, None),
            item("yolobox", State::Ok, &["container"], None),
            item("runtime", State::Stopped, &["container"], None),
            item("image", State::Info, &["container"], None),
            item("python", State::Ok, &["local"], None),
            item("trimesh", State::Ok, &["local"], None),
        ];
        let r = readiness(&items);
        assert!(!r.container, "the engine is stopped");
        assert!(r.local, "information lines do not count");

        let mut old = items.clone();
        old[0].state = State::TooOld;
        let r = readiness(&old);
        assert!(!r.container && !r.local, "Claude serves both modes");
    }

    #[test]
    fn the_builtin_sandbox_is_its_own_mode() {
        let items = vec![
            item("claude", State::Ok, &ALL, None),
            item("account", State::Ok, &ALL, None),
            item("bwrap", State::Ok, &["sandbox"], None),
            item("socat", State::Missing, &["sandbox"], None),
            item("python", State::Ok, &HOST, None),
            item("trimesh", State::Ok, &HOST, None),
        ];
        let r = readiness(&items);
        assert!(!r.sandbox, "socat missing");
        assert!(r.local, "this computer does not need it");
        let mut ok = items.clone();
        ok[3].state = State::Ok;
        assert!(readiness(&ok).sandbox);
        let mut win = items.clone();
        win.retain(|i| i.key != "bwrap" && i.key != "socat");
        win.push(item("builtin", State::Unsupported, &["sandbox"], None));
        assert!(!readiness(&win).sandbox, "Windows: no built-in sandbox");
        // The Python modules serve it too.
        let mut no_mod = ok.clone();
        no_mod[5].state = State::Missing;
        assert!(!readiness(&no_mod).sandbox && !readiness(&no_mod).local);
    }

    #[test]
    fn python_paths_under_the_home_are_reopened() {
        let out = "python 3.12.4\npath /opt/homebrew/opt/python@3.12/Frameworks/Python.framework/Versions/3.12\npath /Users/me/Library/Python/3.12/lib/python/site-packages\npath /Users/me/Library/Python/3.12/lib/python/site-packages\npath /Users/me/venvs/ai\npath /Users/me/venvs/ai/lib/python3.12/site-packages\npath /usr/lib/python3.12\npath /Volumes/Ext/py\n";
        let paths = python_paths(out);
        assert_eq!(paths.len(), 6, "deduplicated: {paths:?}");
        let r = blocked_reads(&paths, Some(Path::new("/Users/me")));
        assert_eq!(
            r,
            vec![
                PathBuf::from("/Users/me/Library/Python/3.12/lib/python/site-packages"),
                PathBuf::from("/Users/me/venvs/ai"),
                PathBuf::from("/Volumes/Ext/py"),
            ],
            "Homebrew's and the system's need nothing; a venv covers its site-packages"
        );
        // A home outside the blocked roots (Linux /var/home…) counts too.
        assert_eq!(blocked_reads(&[PathBuf::from("/var/home/me/.local/lib")], Some(Path::new("/var/home/me"))).len(), 1);
        assert!(blocked_reads(&[PathBuf::from("relative/path")], None).is_empty());
    }

    /// On this machine: `cargo test --lib real_ai_check -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_ai_check() {
        let t = Instant::now();
        let r = check(CheckScope { yolobox: true });
        for i in &r.items {
            println!("{:<16} {:?} {:?} {:?}", i.key, i.state, i.modes, i.detail);
        }
        println!("ready {:?}, runtime {:?}, pip managed {}, {} ms", r.ready, r.runtime, r.python_managed, t.elapsed().as_millis());
        if std::env::var("AI_JSON").is_ok() {
            println!("JSON {}", serde_json::to_string(&r).unwrap());
        }
    }
}
