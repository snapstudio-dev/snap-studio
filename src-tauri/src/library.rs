//! Library: browsing model sites.
//!
//! Each tab is a **native web view** added to our window. These views draw on
//! top of the HTML interface: the interface dictates their rectangle, and must
//! hide them as soon as a dialog or the 3D viewer comes in front.
//!
//! Cookies are those of the shared, persistent store: one logs in to
//! MakerWorld or Printables once, and the session survives a restart.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Current browser identity: some sites serve a degraded page to an unknown
/// agent.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                  (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Serialize, Clone)]
pub struct Site {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// Which sidebar entry lists it: the Library (model sites) or the
    /// Snapmaker hub (the maker's own spaces). Same views, same tabs.
    pub hub: &'static str,
}

pub const SITES: &[Site] = &[
    Site { id: "makerworld", name: "MakerWorld", url: "https://makerworld.com/", hub: "library" },
    Site { id: "printables", name: "Printables", url: "https://www.printables.com/", hub: "library" },
    Site { id: "thingiverse", name: "Thingiverse", url: "https://www.thingiverse.com/", hub: "library" },
    Site { id: "cults3d", name: "Cults3D", url: "https://cults3d.com/fr", hub: "library" },
    Site { id: "myminifactory", name: "MyMiniFactory", url: "https://www.myminifactory.com/", hub: "library" },
    Site { id: "thangs", name: "Thangs", url: "https://thangs.com/", hub: "library" },
    Site { id: "yeggi", name: "Yeggi", url: "https://www.yeggi.com/", hub: "library" },
    Site { id: "grabcad", name: "GrabCAD", url: "https://grabcad.com/library", hub: "library" },
    Site { id: "space", name: "Space", url: "https://space.snapmaker.com/", hub: "snapmaker" },
    Site { id: "store", name: "Store", url: "https://shop.snapmaker.com/", hub: "snapmaker" },
    Site { id: "wiki", name: "Wiki", url: "https://wiki.snapmaker.com/", hub: "snapmaker" },
    Site { id: "forum", name: "Forum", url: "https://forum.snapmaker.com/", hub: "snapmaker" },
    Site { id: "account", name: "Account", url: "https://account.snapmaker.com/", hub: "snapmaker" },
];

pub fn sites() -> Vec<Site> {
    SITES.to_vec()
}

fn label(id: &str) -> String {
    format!("lib-{id}")
}

/// The floating navigation (`overlay.html`): a small transparent view of
/// ours laid over the site's, at its top-left, with Back, Forward and
/// Reload. Views cannot be reordered once added, so a fresh one (a new
/// label) is made after each site's view, which puts it on top; the older
/// one is closed. Shown with a site, hidden with it.
const NAV_SIZE: (f64, f64) = (112.0, 40.0);

fn nav_rect(r: Rect) -> Rect {
    // Linux: the view is the pill itself, at the same place (overlay.html
    // `.solid`): see `nav_setup`.
    if cfg!(target_os = "linux") {
        return Rect { x: r.x + 14.0, y: r.y + 14.0, w: 88.0, h: 32.0 };
    }
    Rect { x: r.x + 10.0, y: r.y + 10.0, w: NAV_SIZE.0, h: NAV_SIZE.1 }
}

fn nav_label() -> &'static Mutex<String> {
    static L: OnceLock<Mutex<String>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(String::new()))
}

/// The tab shown, for the floating navigation's buttons.
fn visible_tab() -> &'static Mutex<Option<String>> {
    static V: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    V.get_or_init(Default::default)
}

/// The pill's tooltips, in the interface's language.
fn nav_labels() -> serde_json::Value {
    serde_json::json!({
        "lang": crate::i18n::lang(),
        "back": crate::t!("common.back"),
        "forward": crate::t!("library.forward"),
        "reload": crate::t!("library.reload"),
    })
}

/// What the pill's page starts with (`window.__NAV__`): its tooltips, the
/// site's tone and the color under the pill.
///
/// Linux: the pill's view is opaque, the pill's size, its corners in the
/// color under it (`solid`). A transparent view laid over the site shows
/// the desktop through its transparent pixels each time it repaints on its
/// own (hovering a button, a tooltip, a change of tone): WebKitGTK replaces
/// what is under it rather than drawing over it, and the window is
/// see-through (rounded corners). That was the pill's flicker on Linux.
fn nav_setup() -> String {
    let mut v = nav_labels();
    let (tone, under) = nav_tone().lock().unwrap().clone().map_or((None, None), |(t, u)| (Some(t), u));
    v["tone"] = serde_json::json!(tone);
    v["under"] = serde_json::json!(under);
    v["solid"] = serde_json::json!(cfg!(target_os = "linux"));
    v.to_string()
}

/// The interface's language changed: the pill shown takes it at once (the
/// next ones start with it).
pub fn nav_relabel(app: &AppHandle) {
    let lbl = nav_label().lock().unwrap().clone();
    if let Some(wv) = app.get_webview(&lbl) {
        let _ = wv.eval(format!("typeof setLabels === 'function' && setLabels({});", nav_labels()));
    }
}

fn ensure_nav(app: &AppHandle) -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    let old = nav_label().lock().unwrap().clone();
    let lbl = format!("lib-nav-{}", N.fetch_add(1, Ordering::Relaxed));
    let window = app.get_window("main").ok_or_else(|| anyhow!("main window not found"))?;
    // A new pill starts with the tone known: not dark for a moment on a
    // dark site.
    let tone = nav_tone().lock().unwrap().clone();
    let builder = tauri::WebviewBuilder::new(&lbl, WebviewUrl::App("overlay.html".into()))
        .initialization_script(&format!("window.__NAV__ = {};", nav_setup()))
        .transparent(true);
    let r = nav_rect(*last_rect().lock().unwrap());
    let dy = title_offset(&window);
    let _view = window.add_child(builder, LogicalPosition::new(r.x, r.y + dy), LogicalSize::new(r.w, r.h))?;
    #[cfg(target_os = "linux")]
    gtk_layer::adopt(app, &_view);
    *nav_told().lock().unwrap() = (lbl.clone(), tone);
    *nav_label().lock().unwrap() = lbl;
    if let Some(wv) = app.get_webview(&old) {
        let _ = wv.close();
    }
    Ok(())
}

/// The tone of the site under the floating navigation, measured in the
/// site's own view by `nav-tone.js` (injected, main frame, read-only):
/// "light" or "dark", none until one is read. Rust reads it with
/// `eval_with_callback`, so the sites never get our bridge; the pill, our
/// own page, is told when it changes.
const TONE_JS: &str = include_str!("../../ui/nav-tone.js");

/// The expression read in the tab shown: what the script keeps, if it is
/// a string, or "".
const TONE_READ: &str = "(function () { try { var t = window[Symbol.for('snapstudio.navTone')]; \
                         return typeof t === 'string' ? t.slice(0, 32) : ''; } catch (e) { return ''; } })()";

/// The site's tone, and the color under the pill ("#rrggbb").
type Tone = (&'static str, Option<String>);

fn nav_tone() -> &'static Mutex<Option<Tone>> {
    static T: OnceLock<Mutex<Option<Tone>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// The pill last told, and what it was told: nothing is sent (or redrawn)
/// again while neither changes.
fn nav_told() -> &'static Mutex<(String, Option<Tone>)> {
    static T: OnceLock<Mutex<(String, Option<Tone>)>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// A view's answer (JSON) to `TONE_READ`: "light" or "dark", and maybe a
/// "#rrggbb" color after it; anything else (nothing measured yet, a page
/// that overwrote it, an error) is none.
fn parse_tone(json: &str) -> Option<Tone> {
    let s = serde_json::from_str::<String>(json).ok()?;
    let mut words = s.split(' ');
    let tone = match words.next()? {
        "light" => "light",
        "dark" => "dark",
        _ => return None,
    };
    let under = match (words.next(), words.next()) {
        (None, _) => None,
        (Some(c), None) if c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(c.to_ascii_lowercase())
        }
        _ => return None,
    };
    Some((tone, under))
}

/// Reads the tone of the tab shown, if any (hidden tabs never are).
fn read_tone(app: &AppHandle) {
    let Some(id) = visible_tab().lock().unwrap().clone() else { return };
    let Some(wv) = app.get_webview(&label(&id)) else { return };
    let app = app.clone();
    let _ = wv.eval_with_callback(TONE_READ, move |json| {
        // Another tab shown meanwhile: its own reading will tell.
        if visible_tab().lock().unwrap().as_deref() != Some(id.as_str()) {
            return;
        }
        if let Some(t) = parse_tone(&json) {
            *nav_tone().lock().unwrap() = Some(t);
        }
        tell_tone(&app);
    });
}

/// Gives the pill the tone, once per pill and change. It answers once its
/// page can take it; until then it is told again at the next reading.
fn tell_tone(app: &AppHandle) {
    let Some(tone) = nav_tone().lock().unwrap().clone() else { return };
    let lbl = nav_label().lock().unwrap().clone();
    if *nav_told().lock().unwrap() == (lbl.clone(), Some(tone.clone())) {
        return;
    }
    let Some(wv) = app.get_webview(&lbl) else { return };
    // Both checked by `parse_tone`: a word and a hexadecimal color.
    let under = tone.1.as_deref().map_or("null".to_string(), |c| format!("'{c}'"));
    let js = format!("typeof setTone === 'function' ? (setTone('{}', {under}), 1) : 0", tone.0);
    let _ = wv.eval_with_callback(js, move |r| {
        if r.trim() == "1" {
            *nav_told().lock().unwrap() = (lbl.clone(), Some(tone.clone()));
        }
    });
}

/// Reads the tab shown about three times a second, from the first tab
/// opened on: the end of a scroll, a page change without loading, Back
/// or Forward show within about half a second (the page measures once a
/// scroll stops, at most every 500 ms). Nothing is read while no site is
/// shown.
fn start_tone_reading(app: &AppHandle) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            read_tone(&app);
        });
    });
}

/// A view of ours floating over a site: the pinned camera
/// (`camview.html`) and Snappy's conversation (`snappy-view.html`). The
/// interface draws them in HTML, so a site's native view covers them;
/// while a site is shown, a small native view of ours takes their place,
/// on top, made again after each site's view, as the navigation. The
/// interface asks for one (where, with what settings) and is told when it
/// shows: the camera stops its own frames meanwhile, Snappy's card stops
/// being the one used.
pub struct Floater {
    /// Its views' labels: `<prefix><n>`.
    prefix: &'static str,
    page: &'static str,
    /// The script run before the page's, from its settings.
    init: fn(&str) -> String,
    /// Told to the interface: `{ "shown": bool }`.
    event: &'static str,
    state: Mutex<FloaterState>,
}

struct FloaterState {
    /// Where, and the page's settings (a JSON object); None: not wanted.
    req: Option<(Rect, String)>,
    label: String,
    n: u64,
}

/// The camera's settings: printer, name, texts.
pub static CAM: Floater = Floater {
    prefix: "lib-cam-",
    page: "camview.html",
    init: |setup| format!("window.__CAM__ = {setup};"),
    event: "cam-view",
    state: Mutex::new(FloaterState { req: None, label: String::new(), n: 0 }),
};

/// Snappy's conversation: its settings are the language and the context
/// its messages carry; the catalogs come with them.
pub static SNAPPY: Floater = Floater {
    prefix: "lib-snappy-",
    page: "snappy-view.html",
    init: |setup| format!("{}window.__SNAPPY__ = {setup};", crate::i18n::init_script()),
    event: "snappy-view",
    state: Mutex::new(FloaterState { req: None, label: String::new(), n: 0 }),
};

const FLOATERS: [&Floater; 2] = [&CAM, &SNAPPY];

/// A camera view's label (the `cam` protocol answers it).
pub fn is_cam_view(label: &str) -> bool {
    label.starts_with(CAM.prefix)
}

impl Floater {
    fn owns(&self, label: &str) -> bool {
        label.starts_with(self.prefix)
    }

    /// Where it goes and with what, or None to remove it.
    pub fn set(&self, app: &AppHandle, rect: Option<Rect>, setup: String) {
        let want = rect.map(|rect| (rect, setup));
        let (changed, label) = {
            let mut st = self.state.lock().unwrap();
            let changed = st.req.as_ref().map(|r| &r.1) != want.as_ref().map(|r| &r.1);
            st.req = want.clone();
            (changed, st.label.clone())
        };
        if want.is_none() {
            let old = std::mem::take(&mut self.state.lock().unwrap().label);
            if let Some(wv) = app.get_webview(&old) {
                let _ = wv.close();
            }
        } else if changed || app.get_webview(&label).is_none() {
            if let Err(e) = self.ensure(app) {
                eprintln!("[lib] {}: {e}", self.page);
            }
        }
        self.sync(app);
    }

    /// Made (again), on top of every view made before it.
    fn ensure(&self, app: &AppHandle) -> Result<()> {
        let (req, old, lbl) = {
            let mut st = self.state.lock().unwrap();
            let Some(req) = st.req.clone() else { return Ok(()) };
            st.n += 1;
            (req, st.label.clone(), format!("{}{}", self.prefix, st.n))
        };
        let window = app.get_window("main").ok_or_else(|| anyhow!("main window not found"))?;
        let builder = tauri::WebviewBuilder::new(&lbl, WebviewUrl::App(self.page.into()))
            .initialization_script((self.init)(&req.1))
            .transparent(true);
        let r = req.0;
        let dy = title_offset(&window);
        let _view = window.add_child(builder, LogicalPosition::new(r.x, r.y + dy), LogicalSize::new(r.w, r.h))?;
        #[cfg(target_os = "linux")]
        gtk_layer::adopt(app, &_view);
        self.state.lock().unwrap().label = lbl;
        if let Some(wv) = app.get_webview(&old) {
            let _ = wv.close();
        }
        Ok(())
    }

    /// Shown while a site is (and it is wanted), at its place; the
    /// interface told whether it shows.
    fn sync(&self, app: &AppHandle) {
        let (req, lbl) = {
            let st = self.state.lock().unwrap();
            (st.req.clone(), st.label.clone())
        };
        let site = visible_tab().lock().unwrap().is_some();
        let shown = match (app.get_webview(&lbl), &req) {
            (Some(wv), Some((rect, _))) if site => {
                place(&wv, *rect);
                let _ = wv.show();
                true
            }
            (Some(wv), _) => {
                let _ = wv.hide();
                false
            }
            _ => false,
        };
        let _ = app.emit(self.event, serde_json::json!({ "shown": shown }));
    }
}

/// Back, forward or reload on the tab shown (the floating navigation).
pub fn nav_command(app: &AppHandle, what: &str) -> Result<()> {
    let id = visible_tab().lock().unwrap().clone().ok_or_else(|| anyhow!("no tab shown"))?;
    command(app, &id, what)
}

/// A site's icon as a data URL, kept on disk: the home's cards show the
/// real thing rather than an initial. The page's `<link rel="icon">`
/// (apple-touch, svg or png first), else `/favicon.ico`; None when
/// nothing answers.
pub async fn favicon(id: &str) -> Option<String> {
    let site = SITES.iter().find(|s| s.id == id)?;
    let dir = dirs::cache_dir()?.join("fr.carlini.snapstudio").join("favicons");
    let file = dir.join(id);
    if let Ok(s) = std::fs::read_to_string(&file) {
        if s.starts_with("data:") {
            return Some(s);
        }
    }
    let client = crate::printers::client();
    let base = url::Url::parse(site.url).ok()?;
    let timeout = std::time::Duration::from_secs(12);
    let html = client.get(site.url).header("User-Agent", UA).timeout(timeout).send().await.ok()?.text().await.ok()?;
    let mut candidates: Vec<String> = icon_links(&html).into_iter().filter_map(|h| base.join(&h).ok()).map(|u| u.to_string()).collect();
    candidates.push(base.join("/favicon.ico").ok()?.to_string());
    for u in candidates {
        let Ok(r) = client.get(&u).header("User-Agent", UA).timeout(timeout).send().await else { continue };
        if !r.status().is_success() {
            continue;
        }
        let header =
            r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_string();
        let Ok(bytes) = r.bytes().await else { continue };
        if bytes.is_empty() || bytes.len() > 512 * 1024 {
            continue;
        }
        let lu = u.to_ascii_lowercase();
        let mime = if header.starts_with("image/") {
            header
        } else if lu.ends_with(".svg") {
            "image/svg+xml".into()
        } else if lu.ends_with(".png") {
            "image/png".into()
        } else {
            "image/x-icon".into()
        };
        let data = format!("data:{mime};base64,{}", crate::util::b64_encode(&bytes));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&file, &data);
        return Some(data);
    }
    None
}

/// `href` of a page's `<link rel="… icon …">` tags, the better-looking
/// first: apple-touch, then svg, then png, then the rest.
pub fn icon_links(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out: Vec<(i32, String)> = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let Some(end) = lower[start..].find('>') else { break };
        let (tag, ltag) = (&html[start..start + end], &lower[start..start + end]);
        from = start + end;
        let attr = |name: &str| -> Option<String> {
            let k = format!("{name}=\"");
            let p = ltag.find(&k)? + k.len();
            let q = tag[p..].find('"')? + p;
            Some(tag[p..q].to_string())
        };
        let Some(rel) = attr("rel") else { continue };
        let rel = rel.to_ascii_lowercase();
        if !rel.split_whitespace().any(|r| r == "icon" || r == "apple-touch-icon") {
            continue;
        }
        let Some(href) = attr("href") else { continue };
        let lh = href.to_ascii_lowercase();
        let score = if rel.contains("apple") {
            3
        } else if lh.ends_with(".svg") {
            2
        } else if lh.ends_with(".png") {
            1
        } else {
            0
        };
        out.push((score, href));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, h)| h).collect()
}

/// Rectangle of the browsing area, in interface points.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Last known rectangle: a view created later goes straight there.
///
/// Never hold it across a window or webview call: off the main thread
/// (`lib_open` is async, for Windows), those calls wait for the main thread,
/// which may itself be waiting for this lock in `lib_rect` — a deadlock that
/// froze the app on macOS. Copy the rectangle out first.
fn last_rect() -> &'static Mutex<Rect> {
    static R: OnceLock<Mutex<Rect>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Rect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 }))
}

/// Opens a tab, or brings it back to the front if it already exists. `id`
/// names the tab, not the site: a site may be open in several tabs.
pub fn open_tab(app: &AppHandle, id: &str, url: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow!("bad tab id: {id}"));
    }
    let lbl = label(id);
    if app.get_webview(&lbl).is_some() {
        show_only(app, Some(id));
        return Ok(());
    }
    let window = app.get_window("main").ok_or_else(|| anyhow!("main window not found"))?;
    let target = url::Url::parse(url)?;

    let handle = app.clone();
    let tab_id = id.to_string();
    let nav_id = tab_id.clone();
    let dl_app = handle.clone();
    let dl_id = tab_id.clone();
    let nw_app = handle.clone();
    let nw_label = lbl.clone();
    let title_app = handle.clone();
    let title_id = tab_id.clone();

    let tone_app = handle.clone();
    let builder = tauri::WebviewBuilder::new(&lbl, WebviewUrl::External(target))
        .user_agent(UA)
        // Light or dark under the floating navigation: read by Rust only.
        .initialization_script(TONE_JS)
        // The address shown is the page's: frames navigate too (ads,
        // `about:blank`…), so it is taken when the main page loads, and
        // when its title changes (sites that change pages without loading).
        .on_page_load(move |webview, _payload| {
            emit_url(&handle, &nav_id, &webview);
            read_tone(&handle);
        })
        .on_download(move |_webview, event| download_hook(&dl_app, &dl_id, event))
        // Sites happily open a side window — third-party login, or starting a
        // download. It is brought back into the current tab rather than letting a
        // bare window pop up.
        .on_new_window(move |url, _features| {
            if let Some(wv) = nw_app.get_webview(&nw_label) {
                let _ = wv.navigate(url);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        // The page title names the tab: several tabs of one site stay apart.
        .on_document_title_changed(move |webview, title| {
            let _ = title_app.emit("lib-title", serde_json::json!({ "id": title_id, "title": title }));
            emit_url(&title_app, &title_id, &webview);
            read_tone(&tone_app);
        });

    let r = *last_rect().lock().unwrap();
    let dy = title_offset(&window);
    let _view = window.add_child(builder, LogicalPosition::new(r.x, r.y + dy), LogicalSize::new(r.w.max(1.0), r.h.max(1.0)))?;
    // Linux: Tauri stacked the view under ours; it goes over the main view.
    #[cfg(target_os = "linux")]
    gtk_layer::adopt(app, &_view);
    // The floating navigation and the views floating over sites, made
    // again so that they sit above this view.
    if let Err(e) = ensure_nav(app) {
        eprintln!("[lib] floating navigation: {e}");
    }
    for f in FLOATERS {
        if f.state.lock().unwrap().req.is_some() {
            if let Err(e) = f.ensure(app) {
                eprintln!("[lib] {}: {e}", f.page);
            }
        }
    }
    start_tone_reading(app);
    show_only(app, Some(id));
    Ok(())
}

/// Tells the UI a tab's address, when it is a web page's.
fn emit_url(app: &AppHandle, id: &str, webview: &tauri::Webview) {
    let Ok(url) = webview.url() else { return };
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.emit("lib-url", serde_json::json!({ "id": id, "url": url.to_string() }));
    }
}

/// The address of a tab's page, when it is a web page's.
pub fn page_url(app: &AppHandle, id: &str) -> Option<String> {
    let url = app.get_webview(&label(id))?.url().ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// Forced download destination and notice to the UI.
fn download_hook(app: &AppHandle, id: &str, event: tauri::webview::DownloadEvent<'_>) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let name = destination.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "modele.3mf".into());
            let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
            *destination = unique_path(&dir, &name);
            let _ = app.emit(
                "lib-download",
                serde_json::json!({
                    "id": id,
                    "phase": "started",
                    "url": url.to_string(),
                    "path": destination.to_string_lossy(),
                }),
            );
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
            let _ = app.emit(
                "lib-download",
                serde_json::json!({
                    "id": id,
                    "phase": if success { "finished" } else { "failed" },
                    "url": url.to_string(),
                    "path": path.map(|p| p.to_string_lossy().to_string()),
                }),
            );
            true
        }
        _ => true,
    }
}

/// Adds a numbered suffix rather than overwriting an existing file.
pub(crate) fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    for i in 2..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    p
}

/// Title bar height, in points.
///
/// wry places a child view relative to the **whole window**, whereas our CSS
/// coordinates start at the top of the page, under the title bar. Without a
/// correction the page moves up and covers our address bar.
///
/// `outer_size` and `inner_size` return the same value here — the window has a
/// full-height content view — so the title bar is deduced from the gap between
/// the height the window declares and our page's, which the UI sends us.
/// Measured, never hard-coded.
fn title_offset(window: &tauri::Window) -> f64 {
    let viewport = *viewport_h().lock().unwrap();
    if viewport <= 0.0 {
        return 0.0;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    match window.inner_size() {
        Ok(s) => (s.to_logical::<f64>(scale).height - viewport).clamp(0.0, 200.0),
        Err(_) => 0.0,
    }
}

/// Page height as the UI measures it.
fn viewport_h() -> &'static Mutex<f64> {
    static V: OnceLock<Mutex<f64>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(0.0))
}

/// Places a view in the requested rectangle.
fn place(wv: &tauri::Webview, rect: Rect) {
    // Linux: placed by GTK over the main view, in its own coordinates — no
    // title bar or menu bar to account for.
    #[cfg(target_os = "linux")]
    gtk_layer::place(wv, rect);
    #[cfg(not(target_os = "linux"))]
    place_in_window(wv, rect);
}

/// Places a view in the window, corrected for the title bar.
#[cfg(not(target_os = "linux"))]
fn place_in_window(wv: &tauri::Webview, rect: Rect) {
    let w = wv.window();
    let dy = title_offset(&w);
    if std::env::var("SNAPSTUDIO_LIBDEBUG").is_ok() {
        let scale = w.scale_factor().unwrap_or(1.0);
        eprintln!(
            "[lib] asked y={:.1} h={:.1} | title offset {:.1} | scale {:.2} | \
             inner {:?} | outer {:?} | view position before {:?}",
            rect.y,
            rect.h,
            dy,
            scale,
            w.inner_size().map(|s| s.to_logical::<f64>(scale).height).ok(),
            w.outer_size().map(|s| s.to_logical::<f64>(scale).height).ok(),
            wv.position().map(|p| p.to_logical::<f64>(scale).y).ok(),
        );
    }
    let _ = wv.set_position(LogicalPosition::new(rect.x, rect.y + dy));
    let _ = wv.set_size(LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0)));
    if std::env::var("SNAPSTUDIO_LIBDEBUG").is_ok() {
        let scale = w.scale_factor().unwrap_or(1.0);
        eprintln!("[lib] view position after {:?}", wv.position().map(|p| p.to_logical::<f64>(scale).y).ok());
    }
}

/// Linux: Tauri packs a child view into the window's vertical box, where GTK
/// ignores positions — the page landed under our interface, out of its frame
/// (tauri-apps/tauri#10420, still open in 2.12). The tabs' views are moved
/// into a `gtk::Overlay` put in the main view's place, as layers over it,
/// positioned by their margins: each takes input only on its own area. GTK
/// work happens on the main thread, through `with_webview`, in the order the
/// calls were made.
#[cfg(target_os = "linux")]
mod gtk_layer {
    use super::Rect;
    use gtk::prelude::*;
    use std::cell::RefCell;
    use tauri::Manager;

    thread_local! {
        /// The overlay now holding the main view (main thread only).
        static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
    }

    /// Puts the main view into an overlay, at its place in the window's box.
    fn overlay_around(main: &webkit2gtk::WebView) -> Option<gtk::Overlay> {
        OVERLAY.with(|o| {
            if let Some(ov) = o.borrow().as_ref() {
                return Some(ov.clone());
            }
            let main_w: &gtk::Widget = main.upcast_ref();
            let vbox = main_w.parent()?.downcast::<gtk::Box>().ok()?;
            // After the menu bar, where the main view was.
            let at = vbox.children().iter().position(|c| c == main_w)? as i32;
            let overlay = gtk::Overlay::new();
            vbox.remove(main_w);
            overlay.add(main_w);
            vbox.pack_start(&overlay, true, true, 0);
            vbox.reorder_child(&overlay, at);
            overlay.show();
            *o.borrow_mut() = Some(overlay.clone());
            Some(overlay)
        })
    }

    /// Moves a tab's view from the window's box to a layer over the main view.
    pub fn adopt(app: &tauri::AppHandle, view: &tauri::Webview) {
        if let Some(main) = app.get_webview("main") {
            let _ = main.with_webview(|pw| {
                overlay_around(&pw.inner());
            });
        }
        let _ = view.with_webview(|pw| {
            let w: gtk::Widget = pw.inner().upcast();
            let Some(overlay) = OVERLAY.with(|o| o.borrow().clone()) else { return };
            if let Some(parent) = w.parent() {
                if let Ok(c) = parent.downcast::<gtk::Container>() {
                    c.remove(&w);
                }
            }
            w.set_halign(gtk::Align::Start);
            w.set_valign(gtk::Align::Start);
            overlay.add_overlay(&w);
            // Over the window's right and bottom edges: resizes from there.
            crate::titlebar::edge_resize::attach(&w);
            // Over the window's corners: rounds them there too.
            crate::titlebar::round_corners::attach(&w);
        });
    }

    /// Puts a tab's view on the rectangle, in the main view's coordinates.
    pub fn place(view: &tauri::Webview, rect: Rect) {
        let _ = view.with_webview(move |pw| {
            let w = pw.inner();
            w.set_margin_start(rect.x.max(0.0).round() as i32);
            w.set_margin_top(rect.y.max(0.0).round() as i32);
            w.set_size_request(rect.w.max(1.0).round() as i32, rect.h.max(1.0).round() as i32);
            w.queue_resize();
        });
    }
}

/// Shows a tab and hides the others; `None` hides them all.
pub fn show_only(app: &AppHandle, id: Option<&str>) {
    let wanted = id.map(label);
    *visible_tab().lock().unwrap() = id.map(String::from);
    // Copied out, the lock released: `place` waits for the main thread.
    let rect = *last_rect().lock().unwrap();
    let nav = nav_label().lock().unwrap().clone();
    for (lbl, wv) in app.webviews() {
        if !lbl.starts_with("lib-") {
            continue;
        }
        // The views floating over a site: their own rule (below).
        if FLOATERS.iter().any(|f| f.owns(&lbl)) {
            continue;
        }
        // The floating navigation goes with the site shown.
        if lbl.starts_with("lib-nav") {
            if wanted.is_some() && lbl == nav {
                place(&wv, nav_rect(rect));
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
            continue;
        }
        if Some(&lbl) == wanted.as_ref() {
            place(&wv, rect);
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
    for f in FLOATERS {
        f.sync(app);
    }
    // The tab now shown tells its own tone.
    read_tone(app);
}

/// Remembers the browsing area and puts the visible view back in it.
pub fn set_rect(app: &AppHandle, rect: Rect, viewport: f64, visible: Option<&str>) {
    *last_rect().lock().unwrap() = rect;
    if viewport > 0.0 {
        *viewport_h().lock().unwrap() = viewport;
    }
    if let Some(id) = visible {
        if let Some(wv) = app.get_webview(&label(id)) {
            place(&wv, rect);
        }
        let nav = nav_label().lock().unwrap().clone();
        if let Some(wv) = app.get_webview(&nav) {
            place(&wv, nav_rect(rect));
        }
    }
}

pub fn close_tab(app: &AppHandle, id: &str) {
    if let Some(wv) = app.get_webview(&label(id)) {
        let _ = wv.close();
    }
}

pub fn navigate(app: &AppHandle, id: &str, url: &str) -> Result<()> {
    let wv = app.get_webview(&label(id)).ok_or_else(|| anyhow!("unknown tab"))?;
    wv.navigate(url::Url::parse(url)?)?;
    Ok(())
}

/// History and reload: the remote view does not have our bridge, so we go
/// through its own JavaScript context.
pub fn command(app: &AppHandle, id: &str, what: &str) -> Result<()> {
    let wv = app.get_webview(&label(id)).ok_or_else(|| anyhow!("unknown tab"))?;
    let js = match what {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(anyhow!("unknown command: {what}")),
    };
    wv.eval(js)?;
    read_tone(app);
    Ok(())
}

/// Registrable domain: "www.printables.com" gives "printables.com", and
/// "shop.example.co.uk" gives "example.co.uk" (the usual two-level public
/// suffixes).
fn registrable(host: &str) -> String {
    const TWO_LEVEL: [&str; 12] =
        ["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "co.za", "com.mx"];
    let parts: Vec<&str> = host.split('.').collect();
    let keep = if parts.len() >= 3 && TWO_LEVEL.contains(&parts[parts.len() - 2..].join(".").as_str()) { 3 } else { 2 };
    if parts.len() >= keep {
        parts[parts.len() - keep..].join(".")
    } else {
        host.to_string()
    }
}

/// True for the domain itself and its subdomains, never for a longer name
/// that merely ends with it ("notprintables.com").
fn under(domain: &str, base: &str) -> bool {
    domain == base || domain.strip_suffix(base).is_some_and(|d| d.ends_with('.'))
}

/// Logs a site out by deleting only its login cookies, from one of its tabs.
///
/// The cookie store is shared by all views: clearing it wholesale would log
/// the other sites out too. So it is filtered by domain.
pub fn logout(app: &AppHandle, tab: &str, site: &str) -> Result<usize> {
    let site = SITES.iter().find(|s| s.id == site).ok_or_else(|| anyhow!("unknown site"))?;
    let wv = app.get_webview(&label(tab)).ok_or_else(|| anyhow!(crate::t!("err.tab_closed")))?;
    let host = url::Url::parse(site.url)?.host_str().unwrap_or_default().to_string();
    let base = registrable(&host);

    let mut n = 0;
    for c in wv.cookies()? {
        let dom = c.domain().unwrap_or_default().trim_start_matches('.').to_string();
        if under(&dom, &base) {
            if wv.delete_cookie(c).is_ok() {
                n += 1;
            }
        }
    }
    let _ = wv.navigate(url::Url::parse(site.url)?);
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only "light" or "dark", and a plain "#rrggbb", from a site's view
    /// are taken.
    #[test]
    fn tone_answers_are_checked() {
        assert_eq!(parse_tone(r#""light""#), Some(("light", None)));
        assert_eq!(parse_tone(r#""dark #12AB9f""#), Some(("dark", Some("#12ab9f".into()))));
        for bad in [
            r#""""#,
            "null",
            "",
            "1",
            r#""Dark""#,
            r#""dark ""#,
            r#""dark #12345""#,
            r#""dark #1234567""#,
            r#""dark #12345g""#,
            r#""dark #123456 x""#,
            r#""dark red""#,
            r#"{"t":"dark"}"#,
            r#"["dark"]"#,
            "undefined",
            r#""light'); alert(1); ('""#,
            r#""dark #12345');""#,
        ] {
            assert_eq!(parse_tone(bad), None, "{bad}");
        }
    }

    /// The script injected in the sites is the tested one, and keeps to
    /// the main frame.
    #[test]
    fn tone_script_is_read_only() {
        assert!(TONE_JS.contains("window.top !== window"));
        assert!(TONE_JS.contains("snapstudio.navTone") && TONE_READ.contains("snapstudio.navTone"));
        for call in
            ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "document.cookie", "__TAURI__", "appendChild", "postMessage"]
        {
            assert!(!TONE_JS.contains(call), "{call} in nav-tone.js");
        }
    }

    #[test]
    fn sites_are_well_formed() {
        for s in sites() {
            assert!(url::Url::parse(s.url).is_ok(), "{} : URL valide", s.name);
            assert!(!s.id.is_empty());
        }
    }

    #[test]
    fn registrable_domain() {
        assert_eq!(registrable("www.printables.com"), "printables.com");
        assert_eq!(registrable("makerworld.com"), "makerworld.com");
        assert_eq!(registrable("a.b.cults3d.com"), "cults3d.com");
        assert_eq!(registrable("localhost"), "localhost");
    }

    #[test]
    fn unique_path_avoids_overwriting() {
        let dir = std::env::temp_dir().join("snapstudio_dl_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "piece.3mf");
        assert_eq!(first.file_name().unwrap(), "piece.3mf");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "piece.3mf");
        assert_eq!(second.file_name().unwrap(), "piece (2).3mf");
    }
}

#[cfg(test)]
mod domain_tests {
    use super::{registrable, under};

    #[test]
    fn a_site_s_cookies_and_no_other_s() {
        assert_eq!(registrable("www.printables.com"), "printables.com");
        assert_eq!(registrable("shop.example.co.uk"), "example.co.uk");
        assert_eq!(registrable("localhost"), "localhost");
        assert!(under("printables.com", "printables.com"));
        assert!(under("api.printables.com", "printables.com"));
        assert!(!under("notprintables.com", "printables.com"));
        assert!(!under("printables.community", "printables.com"));
        // Every site's own pages, and its sign-in subdomains, share its cookies.
        for (url, sub) in [
            ("https://www.myminifactory.com/", "accounts.myminifactory.com"),
            ("https://thangs.com/", "api.thangs.com"),
            ("https://www.yeggi.com/", "www.yeggi.com"),
            ("https://grabcad.com/library", "accounts.grabcad.com"),
        ] {
            let host = url::Url::parse(url).unwrap().host_str().unwrap().to_string();
            assert!(under(sub, &registrable(&host)), "{sub} under {host}");
        }
    }
}

#[cfg(test)]
mod icon_tests {
    use super::icon_links;

    #[test]
    fn the_page_s_icons_best_first() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/a.css">
            <link rel="icon" href="/favicon.ico" sizes="32x32">
            <LINK REL="Icon" TYPE="image/svg+xml" HREF="/icon.svg">
            <link rel="apple-touch-icon" href="https://cdn.x/touch.png">
            <link rel="shortcut icon" href="/old.ico">
        </head></html>"#;
        assert_eq!(icon_links(html), vec!["https://cdn.x/touch.png", "/icon.svg", "/favicon.ico", "/old.ico"]);
        assert!(icon_links("<html><body>no links</body></html>").is_empty());
    }
}
