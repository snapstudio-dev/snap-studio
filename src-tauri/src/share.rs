//! Sharing a printer's file (a print file or a timelapse).
//!
//! The file is fetched once into a local cache (same printer, same file,
//! same version), then:
//! - handed to the system's share menu — AirDrop, Messages, Mail… (macOS);
//! - copied to the clipboard as a file, to paste in the Finder, a chat or a
//!   mail;
//! - served to a phone on the local network, behind a QR code: one file,
//!   read only, at an address no one can guess, on the interface that
//!   reaches the printer, for a quarter of an hour at most;
//! - saved where the user says.
//!
//! The actions only take files of the cache: nothing else of the computer
//! can be shared from here.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a file stays served to the phone.
pub const QR_LIFETIME: Duration = Duration::from_secs(15 * 60);
/// Connections served at once; the rest are dropped at accept.
const MAX_CONNECTIONS: usize = 8;

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("snapstudio-share")
}

/// Removes the local copies (app quitting).
pub fn cleanup() {
    qr_stop();
    let _ = std::fs::remove_dir_all(cache_dir());
}

/// The local copy of a printer file, fetched once per version.
pub async fn fetch(host: &str, port: u16, root: &str, path: &str, modified: f64) -> Result<PathBuf> {
    let key = format!(
        "{:x}",
        crate::util::fnv1a(&[host.as_bytes(), &port.to_le_bytes(), root.as_bytes(), path.as_bytes(), &modified.to_bits().to_le_bytes()])
    );
    let dir = cache_dir().join(key);
    let name = path.rsplit('/').next().unwrap_or(path);
    let ready = dir.join(name);
    if ready.is_file() {
        return Ok(ready);
    }
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    crate::printer_files::download(host, port, root, path, &dir).await
}

/// A file of the cache, or an error: the actions share nothing else.
pub fn cached(path: &str) -> Result<PathBuf> {
    let p = Path::new(path).canonicalize()?;
    let base = cache_dir().canonicalize()?;
    if p.starts_with(&base) && p.is_file() {
        Ok(p)
    } else {
        Err(anyhow!("not a shared file"))
    }
}

/// What this system can do.
#[derive(Serialize)]
pub struct Caps {
    /// The system's share menu.
    pub native: bool,
    /// A file on the clipboard.
    pub copy: bool,
}

pub fn caps() -> Caps {
    Caps { native: cfg!(target_os = "macos"), copy: can_copy() }
}

/// Saves a copy where the user chose.
pub fn save(src: &Path, dest: &Path) -> Result<()> {
    std::fs::copy(src, dest).with_context(|| format!("copying {} to {}", src.display(), dest.display()))?;
    Ok(())
}

// ------------------------------------------------------------ clipboard

#[cfg(target_os = "macos")]
fn can_copy() -> bool {
    true
}

#[cfg(target_os = "windows")]
fn can_copy() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn can_copy() -> bool {
    linux_clip().is_some()
}

/// The file itself on the clipboard, as the file manager copies it.
#[cfg(target_os = "macos")]
pub fn copy(path: &Path) -> Result<()> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let item: Retained<ProtocolObject<dyn NSPasteboardWriting>> = ProtocolObject::from_retained(url);
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    if pb.writeObjects(&NSArray::from_retained_slice(&[item])) {
        Ok(())
    } else {
        Err(anyhow!("the clipboard refused the file"))
    }
}

/// Windows: PowerShell's Set-Clipboard puts the file (CF_HDROP) as Explorer does.
#[cfg(target_os = "windows")]
pub fn copy(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    let quoted = path.to_string_lossy().replace('\'', "''");
    let ok = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Set-Clipboard -LiteralPath '{quoted}'")])
        .creation_flags(NO_WINDOW)
        .status()?
        .success();
    if ok {
        Ok(())
    } else {
        Err(anyhow!("the clipboard refused the file"))
    }
}

/// Linux: a file URI list, through wl-copy (Wayland) or xclip (X11).
#[cfg(target_os = "linux")]
fn linux_clip() -> Option<Vec<&'static str>> {
    let found = |b: &str| std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(b).is_file()));
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && found("wl-copy") {
        Some(vec!["wl-copy", "-t", "text/uri-list"])
    } else if found("xclip") {
        Some(vec!["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-i"])
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
pub fn copy(path: &Path) -> Result<()> {
    let argv = linux_clip().ok_or_else(|| anyhow!("wl-copy or xclip is needed"))?;
    let uri = url::Url::from_file_path(path).map_err(|_| anyhow!("bad path"))?;
    let mut child = std::process::Command::new(argv[0]).args(&argv[1..]).stdin(std::process::Stdio::piped()).spawn()?;
    child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?.write_all(format!("{uri}\r\n").as_bytes())?;
    // xclip stays to serve the selection: not waited for here, but reaped
    // when it ends, or it would stay a zombie until the app quits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// ------------------------------------------------------------ share menu

/// Shows the system's share menu for the file, at (`x`, `y`) of the window
/// (its top-left corner, in points). Main thread only.
#[cfg(target_os = "macos")]
pub fn native(ns_window: usize, path: &Path, x: f64, y: f64) -> Result<()> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSSharingServicePicker, NSWindow};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};

    thread_local! {
        // The picker lives while its menu shows.
        static PICKER: std::cell::RefCell<Option<Retained<NSSharingServicePicker>>> = const { std::cell::RefCell::new(None) };
    }
    MainThreadMarker::new().ok_or_else(|| anyhow!("not on the main thread"))?;
    // SAFETY: Tauri's own NSWindow, used on the main thread.
    let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
    let view = window.contentView().ok_or_else(|| anyhow!("no view"))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let items: Retained<NSArray<AnyObject>> = NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(url))]);
    // SAFETY: an NSURL conforms to NSPasteboardWriting, as the picker wants.
    let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };
    let b = view.bounds();
    let y = if view.isFlipped() { y } else { b.size.height - y };
    picker.showRelativeToRect_ofView_preferredEdge(NSRect::new(NSPoint::new(x, y), NSSize::new(1.0, 1.0)), &view, NSRectEdge::MinY);
    PICKER.with(|p| *p.borrow_mut() = Some(picker));
    Ok(())
}

// ------------------------------------------------------------ QR code

/// A file served to the phone.
#[derive(Serialize, Clone)]
pub struct QrShare {
    pub url: String,
    /// The QR code of `url`, as an SVG image.
    pub svg: String,
    /// Seconds before it stops.
    pub seconds: u64,
}

struct Serving {
    stop: Arc<AtomicBool>,
}

fn serving() -> &'static Mutex<Option<Serving>> {
    static S: OnceLock<Mutex<Option<Serving>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Stops serving (sheet closed, or another file shared).
pub fn qr_stop() {
    if let Some(s) = serving().lock().unwrap().take() {
        s.stop.store(true, Ordering::Relaxed);
    }
}

/// The computer's address on the network that reaches `toward` (the
/// printer: the phone is on that same network).
fn local_ip(toward: &str) -> Result<IpAddr> {
    #[cfg(feature = "sim")]
    let toward = crate::sim::route_toward(toward);
    let s = UdpSocket::bind("0.0.0.0:0")?;
    s.connect((toward, 80))?;
    let ip = s.local_addr()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return Err(anyhow!("no local network"));
    }
    Ok(ip)
}

/// Serves `path` to the local network and returns its address and QR code.
pub fn qr_start(path: PathBuf, toward: &str) -> Result<QrShare> {
    qr_stop();
    let ip = local_ip(toward)?;
    let listener = TcpListener::bind((ip, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let host = match ip {
        IpAddr::V6(v6) => format!("[{v6}]"),
        IpAddr::V4(v4) => v4.to_string(),
    };
    let url = format!("http://{host}:{port}/{token}/{}", urlencoding::encode(&name));
    let svg = qrcode::QrCode::new(url.as_bytes())?.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).build();

    let stop = Arc::new(AtomicBool::new(false));
    *serving().lock().unwrap() = Some(Serving { stop: stop.clone() });
    let until = Instant::now() + QR_LIFETIME;
    let prefix = format!("/{token}/");
    // One phone is expected; a handful of connections covers its browser's
    // parallel range requests. Beyond that, the port is being hammered.
    let slots = Slots::new(MAX_CONNECTIONS);
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) && Instant::now() < until {
            match listener.accept() {
                Ok((conn, _)) => {
                    let Some(slot) = slots.take() else {
                        drop(conn);
                        continue;
                    };
                    let (path, prefix, stop) = (path.clone(), prefix.clone(), stop.clone());
                    std::thread::spawn(move || {
                        let _slot = slot;
                        let _ = serve(conn, &path, &prefix, &stop);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
                Err(_) => std::thread::sleep(Duration::from_millis(500)),
            }
        }
        stop.store(true, Ordering::Relaxed);
    });
    Ok(QrShare { url, svg, seconds: QR_LIFETIME.as_secs() })
}

/// Connections served at once, at most `max`: each holds a `Slot` until it
/// ends (dropped, even on a panic, it frees its place).
struct Slots {
    live: Arc<AtomicUsize>,
    max: usize,
}

struct Slot(Arc<AtomicUsize>);

impl Slots {
    fn new(max: usize) -> Self {
        Slots { live: Arc::default(), max }
    }

    /// A place for one more connection, or None when all are taken.
    fn take(&self) -> Option<Slot> {
        if self.live.fetch_add(1, Ordering::AcqRel) >= self.max {
            self.live.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Slot(self.live.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// What the phone asked: method, target, byte range.
#[derive(Debug, PartialEq)]
pub struct Asked {
    pub method: String,
    pub target: String,
    pub range: Option<String>,
}

/// Longest request or header line read; past it the request is dropped.
/// Anyone on the network can reach the port: a line that never ends must
/// not grow in memory until the read timeout.
const LINE_MAX: usize = 8 * 1024;

/// One line, `LINE_MAX` bytes at most: None past that, or on a read error.
fn line_within(r: &mut impl BufRead, max: usize) -> Option<String> {
    let mut s = String::new();
    r.take(max as u64).read_line(&mut s).ok()?;
    (s.ends_with('\n') || s.len() < max).then_some(s)
}

pub fn read_request(r: &mut impl BufRead) -> Option<Asked> {
    let line = line_within(r, LINE_MAX)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut range = None;
    for _ in 0..64 {
        let h = line_within(r, LINE_MAX)?;
        if h.is_empty() || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    Some(Asked { method, target, range })
}

/// The bytes asked of a file of `len` bytes: (first, last). None: all.
pub fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let spec = header?.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.trim().is_empty() {
        let n: u64 = b.trim().parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.trim().parse().ok()?;
        let end = if b.trim().is_empty() { len - 1 } else { b.trim().parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

fn mime(path: &Path) -> (&'static str, bool) {
    // (type, shown in the browser rather than downloaded)
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp4") => ("video/mp4", true),
        Some("jpg" | "jpeg") => ("image/jpeg", true),
        Some("png") => ("image/png", true),
        _ => ("application/octet-stream", false),
    }
}

fn serve(conn: TcpStream, path: &Path, prefix: &str, stop: &AtomicBool) -> Result<()> {
    conn.set_nonblocking(false)?;
    conn.set_read_timeout(Some(Duration::from_secs(20)))?;
    conn.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut rd = BufReader::new(conn.try_clone()?);
    let mut out = conn;
    let Some(ask) = read_request(&mut rd) else { return Ok(()) };
    let reply = |out: &mut TcpStream, code: &str| {
        out.write_all(format!("HTTP/1.1 {code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
    };
    if !ask.target.starts_with(prefix) || stop.load(Ordering::Relaxed) {
        reply(&mut out, "404 Not Found")?;
        return Ok(());
    }
    if ask.method != "GET" && ask.method != "HEAD" {
        reply(&mut out, "405 Method Not Allowed")?;
        return Ok(());
    }
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let (ty, inline) = mime(path);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let disp = format!("{}; filename*=UTF-8''{}", if inline { "inline" } else { "attachment" }, urlencoding::encode(&name));
    let (code, start, end) = match byte_range(ask.range.as_deref(), len) {
        Some((a, b)) => ("206 Partial Content", a, b),
        None if ask.range.is_some() && len > 0 => {
            out.write_all(
                format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )?;
            return Ok(());
        }
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut head = format!(
        "HTTP/1.1 {code}\r\nContent-Type: {ty}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nContent-Disposition: {disp}\r\nCache-Control: no-store\r\nConnection: close\r\n"
    );
    if code.starts_with("206") {
        head += &format!("Content-Range: bytes {start}-{end}/{len}\r\n");
    }
    out.write_all(head.as_bytes())?;
    out.write_all(b"\r\n")?;
    if ask.method == "HEAD" || count == 0 {
        return Ok(());
    }
    f.seek(SeekFrom::Start(start))?;
    let mut left = count;
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 && !stop.load(Ordering::Relaxed) {
        let want = left.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        left -= n as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(byte_range(None, 100), None);
        assert_eq!(byte_range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(byte_range(Some("bytes=90-500"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=100-"), 100), None, "past the end");
        assert_eq!(byte_range(Some("items=0-1"), 100), None);
    }

    #[test]
    fn requests() {
        let raw = b"GET /abc/v.mp4 HTTP/1.1\r\nHost: x\r\nRange: bytes=0-1\r\n\r\n";
        let a = read_request(&mut &raw[..]).unwrap();
        assert_eq!(a, Asked { method: "GET".into(), target: "/abc/v.mp4".into(), range: Some("bytes=0-1".into()) });
    }

    #[test]
    fn only_cached_files_are_shared() {
        assert!(cached("/etc/hosts").is_err());
        let d = cache_dir().join("test-only");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a.gcode");
        std::fs::write(&f, "G1").unwrap();
        assert!(cached(&f.to_string_lossy()).is_ok());
        assert!(cached(&d.join("../test-only/../../etc").to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A phone fetching the file: the whole file, a range, a wrong address,
    /// and nothing more once stopped.
    #[test]
    fn a_phone_gets_the_file_and_only_it() {
        let d = cache_dir().join("test-serve");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("clip.mp4");
        std::fs::write(&f, b"0123456789").unwrap();
        let share = qr_start(f.clone(), "127.0.0.1").or_else(|_| qr_start(f.clone(), "192.168.1.1"));
        let Ok(share) = share else { return }; // no network here
        assert!(share.svg.starts_with("<?xml") || share.svg.contains("<svg"));
        let u = url::Url::parse(&share.url).unwrap();
        let addr = format!("{}:{}", u.host_str().unwrap().trim_matches(['[', ']']), u.port().unwrap());
        let get = |target: &str, range: Option<&str>| {
            let mut c = TcpStream::connect(&addr).unwrap();
            let r = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
            write!(c, "GET {target} HTTP/1.1\r\nHost: x\r\n{r}\r\n").unwrap();
            let mut s = Vec::new();
            c.read_to_end(&mut s).unwrap();
            String::from_utf8_lossy(&s).into_owned()
        };
        let whole = get(u.path(), None);
        assert!(whole.starts_with("HTTP/1.1 200") && whole.ends_with("0123456789") && whole.contains("video/mp4"), "{whole}");
        let part = get(u.path(), Some("bytes=2-4"));
        assert!(part.starts_with("HTTP/1.1 206") && part.ends_with("234") && part.contains("bytes 2-4/10"), "{part}");
        assert!(get("/other/clip.mp4", None).starts_with("HTTP/1.1 404"));
        qr_stop();
        std::thread::sleep(Duration::from_millis(400));
        assert!(TcpStream::connect(&addr)
            .map(|mut c| {
                let _ = write!(c, "GET {} HTTP/1.1\r\n\r\n", u.path());
                let mut s = String::new();
                let _ = c.read_to_string(&mut s);
                s.is_empty() || s.starts_with("HTTP/1.1 404")
            })
            .unwrap_or(true));
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// The share server's bounds: request and header lines, and connections.
#[cfg(test)]
mod bounded_tests {
    use super::*;

    #[test]
    fn an_overlong_request_line_is_dropped() {
        let raw = format!("GET /{} HTTP/1.1\r\nHost: x\r\n\r\n", "a".repeat(LINE_MAX));
        assert_eq!(read_request(&mut raw.as_bytes()), None);
    }

    #[test]
    fn an_overlong_header_line_is_dropped() {
        let raw = format!("GET /abc/v.mp4 HTTP/1.1\r\nX-Long: {}\r\n\r\n", "b".repeat(LINE_MAX));
        assert_eq!(read_request(&mut raw.as_bytes()), None);
    }

    /// A line that never ends is cut at `LINE_MAX`, not read until memory
    /// runs out.
    #[test]
    fn an_endless_line_stops_at_the_cap() {
        let mut endless = BufReader::new(std::io::repeat(b'a'));
        assert_eq!(read_request(&mut endless), None);
        let mut endless = BufReader::new(std::io::repeat(b'a'));
        assert_eq!(line_within(&mut endless, LINE_MAX), None);
    }

    #[test]
    fn lines_up_to_the_cap_still_parse() {
        // A request line of exactly LINE_MAX bytes, newline included.
        let head = "GET /abc/";
        let tail = " HTTP/1.1\r\n";
        let target = "v".repeat(LINE_MAX - head.len() - tail.len());
        let raw = format!("{head}{target}{tail}Range: bytes=0-1\r\n\r\n");
        let a = read_request(&mut raw.as_bytes()).unwrap();
        assert_eq!(a.target.len(), "/abc/".len() + target.len());
        assert_eq!(a.range.as_deref(), Some("bytes=0-1"));
        // A last line without a newline, short of the cap, is kept.
        assert_eq!(line_within(&mut &b"GET / HTTP/1.1"[..], LINE_MAX).as_deref(), Some("GET / HTTP/1.1"));
        // End of input: an empty line, which ends the headers.
        assert_eq!(read_request(&mut &b"GET /abc/v.mp4 HTTP/1.1\r\n"[..]).unwrap().range, None);
    }

    #[test]
    fn at_most_max_connections_at_once() {
        let slots = Slots::new(MAX_CONNECTIONS);
        let mut held: Vec<Slot> = (0..MAX_CONNECTIONS).map(|_| slots.take().expect("a free slot")).collect();
        assert!(slots.take().is_none(), "one past the limit");
        held.pop();
        let again = slots.take();
        assert!(again.is_some(), "a closed connection frees its place");
        assert!(slots.take().is_none());
        drop(held);
        drop(again);
        assert_eq!(slots.live.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_panicking_connection_frees_its_place() {
        let slots = Slots::new(1);
        let slot = slots.take().unwrap();
        let _ = std::thread::spawn(move || {
            let _slot = slot;
            panic!("serve failed");
        })
        .join();
        assert!(slots.take().is_some());
    }
}
