"use strict";
/* Explore: the Snapmaker spaces and the model sites, each in a tab.
   Each tab is a native web view laid over our interface. So we only draw
   what surrounds it — the tab strip, which stands in for the toolbar in
   this view — and tell it its rectangle. It must be hidden as soon as
   something else comes in front: another sidebar entry, a dialog, the 3D
   viewer. Back, Forward and Reload float over the page (Rust lays a small
   view of ours on top of the site's).

   Two pinned pages come first: Home, the places to open — the Snapmaker
   ecosystem and the model libraries — and Favorites, the models set aside.
   A site may be open in several tabs. Nothing is read from the sites
   themselves but their favicon: each one is only shown, in its own view. */

const LIB = {
  sites: [],
  favs: [],
  icons: new Map(), // site id → data URL of its favicon
  restored: false,
  tabs: [],          // { id, site, title, url }
  active: "home",    // "home", "favs" or a tab id
  visible: false,    // is the Explore view on screen?
  /* Sites pinned to the sidebar, under Snapmaker Space (ids). */
  pins: new Set((() => {
    try {
      const v = JSON.parse(localStorage.getItem("snapstudio.libpins") || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  })()),
};

const libPinned = (id) => id === "home" || id === "favs";
/* A Snapmaker space's name is translated ("Account"); a model site keeps its brand. */
const siteName = (s) => (s ? (s.hub === "snapmaker" ? tr("snap.site." + s.id) : s.name) : "");
const siteHost = (s) => {
  try {
    return new URL(s.url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/* ------------------------------------------------------------ rectangle */

/* The native view goes where our frame is, in interface points. */
function libRect() {
  const r = $("lib-frame").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function pushRect() {
  invoke("lib_rect", {
    rect: libRect(),
    // Our page height gives away the title bar's, by which the native view
    // must be offset.
    viewport: window.innerHeight,
    visible: LIB.visible && !libPinned(LIB.active) ? LIB.active : null,
  }).catch(() => {});
}

/* ------------------------------------------------------------ tabs */

const siteOf = (t) => LIB.sites.find((s) => s.id === t.site);
const tabName = (t) => t.title || siteName(siteOf(t)) || t.site;

function renderTabs() {
  document.querySelectorAll(".lib-tab.pin").forEach((el) => el.classList.toggle("on", el.dataset.tab === LIB.active));
  const box = $("lib-tablist");
  box.innerHTML = "";
  for (const t of LIB.tabs) {
    const el = document.createElement("button");
    el.className = "lib-tab" + (t.id === LIB.active ? " on" : "");
    el.title = `${siteName(siteOf(t)) || t.site} — ${t.url}`;
    el.innerHTML = `<span class="x" title="${esc(tr("common.close"))}">✕</span>${siteIcon(siteOf(t), 14)}<span class="name">${esc(tabName(t))}</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains("x")) closeTab(t.id);
      else activateTab(t.id);
    };
    // Middle click closes, as in a browser.
    el.onauxclick = (e) => {
      if (e.button === 1) closeTab(t.id);
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      tabMenu(e, t);
    };
    box.appendChild(el);
  }
  const browsing = !libPinned(LIB.active);
  // The star and "open in the browser" act on the site shown.
  $("lib-actions").classList.toggle("hidden", !browsing);
  $("lib-home").classList.toggle("hidden", LIB.active !== "home");
  $("lib-favs").classList.toggle("hidden", LIB.active !== "favs");
  libCounts();
  if (browsing) libFavState();
  sideSync();
}

/* A passing message (a download, a copied link) in the tab strip: a
   notification bubble would show behind the native view. */
let statusTimer = 0;
function libStatus(text, ms = 3000) {
  clearTimeout(statusTimer);
  const el = $("lib-status");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  if (ms) statusTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* A new tab on a site, at its home page or at `url`. */
async function openSite(site, url = site.url) {
  const id = `${site.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  LIB.tabs.push({ id, site: site.id, title: "", url });
  LIB.active = id;
  renderTabs();
  saveTabs();
  // The rectangle must be known before creation, otherwise the view is born elsewhere.
  pushRect();
  try {
    await invoke("lib_open", { id, url });
  } catch (e) {
    toast(String(e), true);
  }
  pushRect();
}

/* The site's tab if one is open (the first), else a new one. */
function showSite(site) {
  const t = LIB.tabs.find((x) => x.site === site.id);
  if (t) activateTab(t.id);
  else openSite(site);
}

function activateTab(id) {
  LIB.active = id;
  renderTabs();
  saveTabs();
  pushRect();
  invoke("lib_show", { id: libPinned(id) ? null : id }).catch(() => {});
}

/* Open tabs come back at the next launch, each where it was. */
function saveTabs() {
  localStorage.setItem(
    "snapstudio.libtabs",
    JSON.stringify({
      tabs: LIB.tabs.map((t) => ({ site: t.site, url: t.url, title: t.title })),
      active: libPinned(LIB.active) ? LIB.active : LIB.tabs.findIndex((t) => t.id === LIB.active),
    })
  );
}

/* Native views cost memory: they are only recreated on the first visit to
   Explore, not at app startup. */
async function restoreTabs() {
  if (LIB.restored) return;
  LIB.restored = true;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("snapstudio.libtabs") || "null");
  } catch {
    saved = null;
  }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
  const want = LIB.active;
  for (const t of saved.tabs) {
    // Before this version, a tab was just its site's id.
    const siteId = typeof t === "string" ? t : t.site;
    const site = LIB.sites.find((s) => s.id === siteId);
    if (!site) continue;
    const url = typeof t === "object" && /^https?:\/\//.test(t.url || "") ? t.url : site.url;
    await openSite(site, url);
    if (typeof t === "object" && t.title) LIB.tabs[LIB.tabs.length - 1].title = t.title;
  }
  // Before the hubs were merged, `active` could be an object (one per hub).
  const a = saved.active && typeof saved.active === "object" ? saved.active.library : saved.active;
  const target = want !== "home" ? want : typeof a === "number" ? LIB.tabs[a]?.id || "home" : libPinned(a) ? a : "home";
  activateTab(target);
}

function closeTab(id) {
  invoke("lib_close", { id }).catch(() => {});
  const i = LIB.tabs.findIndex((t) => t.id === id);
  LIB.tabs = LIB.tabs.filter((t) => t.id !== id);
  if (LIB.active === id) {
    // The neighbour takes over, as in a browser.
    const next = LIB.tabs[Math.min(i, LIB.tabs.length - 1)];
    LIB.active = next ? next.id : "home";
  }
  saveTabs();
  activateTab(LIB.active);
}

function tabMenu(e, tab) {
  const name = siteName(siteOf(tab)) || tab.site;
  nativeMenu([
    { id: "tab:reload:" + tab.id, label: tr("library.reload") },
    { id: "tab:dup:" + tab.id, label: tr("library.duplicate_tab") },
    { id: "tab:copy:" + tab.id, label: tr("library.copy_link") },
    { id: "tab:browser:" + tab.id, label: tr("library.open_browser") },
    {},
    { id: "tab:logout:" + tab.id, label: tr("library.logout", { name }) },
    {},
    { id: "tab:close:" + tab.id, label: tr("library.close_tab") },
    { id: "tab:others:" + tab.id, label: tr("library.close_others"), enabled: LIB.tabs.length > 1 },
  ], e.clientX, e.clientY);
}

onMenu("tab", async (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  const tab = LIB.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (what === "reload") invoke("lib_command", { id, what: "reload" }).catch(() => {});
  if (what === "close") closeTab(id);
  if (what === "others") for (const t of LIB.tabs.filter((x) => x.id !== id)) closeTab(t.id);
  if (what === "dup" && siteOf(tab)) openSite(siteOf(tab), tab.url);
  if (what === "copy") {
    await navigator.clipboard.writeText(tab.url).catch(() => {});
    libStatus(tr("library.link_copied"));
  }
  if (what === "browser") invoke("plugin:opener|open_url", { url: tab.url }).catch((err) => toast(String(err), true));
  if (what === "logout") {
    try {
      const n = await invoke("lib_logout", { id, site: tab.site });
      libStatus(n ? tr("library.logged_out", { n }) : tr("library.no_session"));
    } catch (err) {
      libStatus(String(err), 4000);
    }
  }
});

/* ------------------------------------------------------------ icons */

/* Brand icon: rounded square in the site's color, white or dark initial
   depending on the background luminance. Color derived from the name when
   unknown. The fallback of `siteIcon`, which prefers the site's favicon. */
const BRAND = { makerworld: "#00AE42", printables: "#FA6831", thingiverse: "#248BFB", cults3d: "#7B3FE4", myminifactory: "#00C4A6", thangs: "#FFBC00", grabcad: "#E63B2D", space: "#1F6FEB", store: "#FF6B00", wiki: "#5856D6", forum: "#34C759", account: "#8E8E93" };
const IOS_PALETTE = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#00C7BE", "#30B0C7", "#32ADE6", "#007AFF", "#5856D6", "#AF52DE", "#FF2D55", "#A2845E"];
function brandColor(name) {
  const key = String(name || "?").toLowerCase().replace(/[^a-z0-9]/g, "");
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND[key] || IOS_PALETTE[h % IOS_PALETTE.length];
}
function brandIcon(name, size = 18) {
  const bg = brandColor(name);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fg = lum > 0.72 ? "#1d1d1f" : "#fff";
  const initial = esc((String(name || "?").trim()[0] || "?").toUpperCase());
  return `<span class="brand" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;background:${bg};color:${fg};font-size:${Math.round(size * 0.5)}px">${initial}</span>`;
}
/* The site's favicon once fetched (Rust keeps it), its brand initial until then. */
function siteIcon(site, size = 18) {
  if (!site) return brandIcon("?", size);
  const data = LIB.icons.get(site.id);
  if (data) return `<img class="favicon" src="${esc(data)}" alt="" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px" />`;
  return brandIcon(site.id, size);
}
/* Favicons arrive one by one; the cards and tabs redraw as they do. */
async function loadIcons() {
  await Promise.all(
    LIB.sites.map(async (s) => {
      if (LIB.icons.has(s.id)) return;
      const data = await invoke("lib_favicon", { id: s.id }).catch(() => null);
      if (data) {
        LIB.icons.set(s.id, data);
        renderHome();
        renderPins();
        renderTabs();
      }
    })
  );
}

const relDate = (secs) => {
  const d = Math.floor(Date.now() / 1000) - secs;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  if (d < 3600) return tr("library.just_now");
  if (d < 86400) return rtf.format(-Math.floor(d / 3600), "hour");
  if (d < 7 * 86400) return rtf.format(-Math.floor(d / 86400), "day");
  return new Date(secs * 1000).toLocaleDateString(locale());
};

/* The sidebar counts the favorites. */
function libCounts() {
  const n = LIB.favs.length;
  $("count-favs").textContent = n ? String(n) : "";
}

/* The star is filled when the page shown is a favorite. */
function libFavState() {
  const t = LIB.tabs.find((x) => x.id === LIB.active);
  const on = !!t && LIB.favs.some((f) => f.url === t.url);
  $("lib-fav").classList.toggle("on", on);
  $("lib-fav").title = tr(on ? "library.fav_already" : "library.fav");
}

/* ------------------------------------------------------------ favorites */

async function favAct(what, id) {
  const f = LIB.favs.find((x) => x.id === id);
  if (!f) return;
  if (what === "open") return openFavorite(f);
  if (what === "copy") {
    await navigator.clipboard.writeText(f.url).catch(() => {});
    return toast(tr("library.link_copied"));
  }
  if (what === "remove") {
    if (!(await confirmDelete(tr("library.remove.title", { name: f.title }), tr("library.remove.text"), tr("prints.remove")))) return;
    LIB.favs = await invoke("fav_remove", { id });
  }
  renderFavs();
}
onMenu("fav", (arg) => {
  const i = arg.indexOf(":");
  favAct(arg.slice(0, i), arg.slice(i + 1));
});

/* The address without its scheme, for the second line of a favorite. */
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/* Favorites: one line per link, newest first. */
function renderFavs() {
  const list = $("lib-grid");
  const has = LIB.favs.length > 0;
  libCounts();
  if (!libPinned(LIB.active)) libFavState();
  list.classList.toggle("hidden", !has);
  $("lib-empty").classList.toggle("hidden", has);
  if (!has) return;
  list.innerHTML = "";
  for (const f of LIB.favs) {
    const el = document.createElement("div");
    el.className = "fav-row";
    el.title = f.url;
    el.innerHTML = `${siteIcon(favSite(f), 28)}
      <div class="fav-text">
        <div class="fav-title">${esc(f.title)}</div>
        <div class="fav-sub">${esc(f.site)} · ${esc(relDate(f.added_at))} · <span class="fav-url">${esc(shortUrl(f.url))}</span></div>
      </div>
      <button class="btn small go">${esc(tr("common.open"))}</button>
      <button class="btn small danger del">${esc(tr("prints.remove"))}</button>`;
    el.onclick = (e) => {
      if (e.target.closest(".del")) favAct("remove", f.id);
      else favAct("open", f.id);
    };
    el.oncontextmenu = (e) =>
      nativeMenu([
        { id: "fav:open:" + f.id, label: tr("common.open") },
        { id: "fav:copy:" + f.id, label: tr("library.copy_link") },
        {},
        { id: "fav:remove:" + f.id, label: tr("library.remove_menu") },
      ], e.clientX, e.clientY);
    list.appendChild(el);
  }
}

/* The site a favorite was saved on: by its address's host. */
function favSite(f) {
  let host = "";
  try {
    host = new URL(f.url).host;
  } catch {}
  return LIB.sites.find((s) => host && (host.includes(s.id) || host === siteHost(s))) || null;
}

/* Opens a favorite in a new tab of its site. */
async function openFavorite(f) {
  const site = favSite(f) || LIB.sites[0];
  if (!site) return;
  await openSite(site, f.url);
}

async function loadFavs() {
  try {
    LIB.favs = await invoke("fav_list");
  } catch {
    LIB.favs = [];
  }
  renderFavs();
}

/* The star saves the page shown; on a favorite already, it shows Favorites.
   The address is asked of the view itself: the one kept for the tab may
   lag behind a page that changed without loading. */
$("lib-fav").addEventListener("click", async () => {
  const t = LIB.tabs.find((x) => x.id === LIB.active);
  if (!t) return;
  const url = (await invoke("lib_url", { id: t.id }).catch(() => null)) || t.url;
  if (url !== t.url) {
    t.url = url;
    saveTabs();
  }
  if (LIB.favs.some((f) => f.url === url)) return activateTab("favs");
  try {
    LIB.favs = await invoke("fav_add", { url, title: t.title || null });
    renderFavs();
    libStatus(tr("library.added"));
  } catch (e) {
    libStatus(String(e), 4000);
  }
});

/* "Open in the browser": the page shown. */
$("lib-ext").addEventListener("click", () => {
  const t = LIB.tabs.find((x) => x.id === LIB.active);
  if (t) invoke("plugin:opener|open_url", { url: t.url }).catch((err) => toast(String(err), true));
});

/* ------------------------------------------------------------ sidebar */

/* Explore itself always lands on Home; its entries open a page. */
document.querySelector('.sidebar .side-item[data-view="library"]').addEventListener("click", () => activateTab("home"));
$("side-space").addEventListener("click", () => {
  switchView("library");
  const space = LIB.sites.find((s) => s.id === "space");
  if (space) showSite(space);
});
$("side-favs").addEventListener("click", () => {
  switchView("library");
  activateTab("favs");
});

/* ------------------------------------------------------------ downloads */

listen("lib-download", async (e) => {
  const { phase, path } = e.payload;
  const name = (path || "").split(/[\\/]/).pop();
  if (phase === "started") {
    libStatus(tr("library.dl.started", { name }), 0);
  } else if (phase === "finished" && /\.(3mf|stl)$/i.test(name) && typeof prepareModels === "function") {
    // A model: straight to the plate.
    libStatus(tr("library.dl.prepare", { name }), 2500);
    await prepareModels([path]);
  } else if (phase === "finished") {
    libStatus(tr("library.dl.finished", { name }), 2500);
    // The file lands in Downloads: go and show it.
    switchView("files");
    await refresh();
    const f = state.files.find((x) => x.path === path);
    if (f) {
      setSel([f.path], { scroll: true });
      toast(tr("library.dl.added", { name: f.name }));
    } else {
      toast(tr("library.dl.done", { name }));
    }
  } else {
    libStatus(tr("library.dl.failed"), 4000);
  }
});

/* ------------------------------------------------------------ visibility */

/* Called by the sidebar: Explore comes on or goes off screen. */
function libSetVisible(on) {
  LIB.visible = on;
  if (on) {
    restoreTabs();
    pushRect();
    invoke("lib_show", { id: libPinned(LIB.active) ? null : LIB.active }).catch(() => {});
  } else {
    invoke("lib_show", { id: null }).catch(() => {});
  }
}

/* Hides the view while a dialog or the viewer is in front. */
function libSuspend() {
  invoke("lib_show", { id: null }).catch(() => {});
}

function libResume() {
  if (LIB.visible) libSetVisible(true);
}

/* ------------------------------------------------------------ events */

listen("lib-url", (e) => {
  const { id, url } = e.payload;
  const t = LIB.tabs.find((x) => x.id === id);
  if (!t) return;
  t.url = url;
  saveTabs();
  if (LIB.active === id) libFavState();
});

listen("lib-title", (e) => {
  const { id, title } = e.payload;
  const t = LIB.tabs.find((x) => x.id === id);
  if (!t || !title || title === t.title) return;
  t.title = title;
  saveTabs();
  renderTabs();
});

document.querySelectorAll(".lib-tab.pin").forEach((el) => el.addEventListener("click", () => activateTab(el.dataset.tab)));

addEventListener("resize", () => LIB.visible && pushRect());
new ResizeObserver(() => LIB.visible && pushRect()).observe($("lib-frame"));

/* ------------------------------------------------------------ home */

/* A site's card: icon, name, a line about it, its host; tinted with the
   site's colour. `hero`: the wide card of Snapmaker Space. */
function siteCard(s, hero = false) {
  const color = brandColor(s.id);
  return `<button type="button" class="ex-card${hero ? " hero" : ""}" data-site="${esc(s.id)}" style="--brand:${esc(color)}" title="${esc(s.url)}">
      <span class="ex-icon">${siteIcon(s, hero ? 44 : 32)}</span>
      <span class="ex-text">
        <span class="ex-name">${esc(siteName(s))}</span>
        <span class="ex-desc">${esc(tr("explore.desc." + s.id))}</span>
        <span class="ex-host">${esc(siteHost(s))}</span>
      </span>
      ${hero ? `<span class="btn primary ex-go">${esc(tr("common.open"))}</span>` : ""}
      ${s.id === "space" ? "" : `<span class="ex-pin${LIB.pins.has(s.id) ? " on" : ""}" data-pin="${esc(s.id)}" role="button" title="${esc(tr(LIB.pins.has(s.id) ? "explore.unpin" : "explore.pin"))}"><svg viewBox="0 0 24 24"><path d="M16 3v2h-1v6l3 3v2h-5v6l-1 1-1-1v-6H6v-2l3-3V5H8V3z"/></svg></span>`}
    </button>`;
}

/* ------------------------------------------------------------ pins */

/* A site pinned to the sidebar, under Snapmaker Space: one click opens its
   tab, or brings it back. Snapmaker Space itself is always there. */
function savePins() {
  localStorage.setItem("snapstudio.libpins", JSON.stringify([...LIB.pins]));
}
function togglePin(id) {
  if (id === "space") return;
  if (LIB.pins.has(id)) LIB.pins.delete(id);
  else LIB.pins.add(id);
  savePins();
  renderPins();
  renderHome();
}
function renderPins() {
  const box = $("side-pins");
  box.innerHTML = "";
  for (const id of LIB.pins) {
    const s = LIB.sites.find((x) => x.id === id);
    if (!s) continue;
    const b = document.createElement("button");
    b.className = "side-item";
    b.dataset.site = s.id;
    b.innerHTML = `<span class="glyph ex-glyph">${siteIcon(s, 16)}</span><span class="lbl">${esc(siteName(s))}</span>`;
    b.onclick = () => {
      switchView("library");
      showSite(s);
    };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      nativeMenu([{ id: "expin:open:" + s.id, label: tr("common.open") }, {}, { id: "expin:unpin:" + s.id, label: tr("explore.unpin") }], e.clientX, e.clientY);
    };
    box.appendChild(b);
  }
  sideSync();
}
onMenu("expin", (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  const s = LIB.sites.find((x) => x.id === id);
  if (!s) return;
  if (what === "open") {
    switchView("library");
    openSite(s);
  }
  if (what === "pin" || what === "unpin") togglePin(id);
});

/* Home: the Snapmaker ecosystem (Space wide, the four others beside), then
   the model libraries, in rows. The "+" picker lists the same cards,
   smaller. */
function renderHome() {
  const snap = LIB.sites.filter((s) => s.hub === "snapmaker");
  const libs = LIB.sites.filter((s) => s.hub === "library");
  const space = snap.find((s) => s.id === "space");
  const others = snap.filter((s) => s.id !== "space");
  $("ex-snap").innerHTML = `${space ? siteCard(space, true) : ""}<div class="ex-grid ex-four">${others.map((s) => siteCard(s)).join("")}</div>`;
  $("ex-libs").innerHTML = `<div class="ex-grid">${libs.map((s) => siteCard(s)).join("")}</div>`;
  $("ex-pick-snap").innerHTML = snap.map((s) => siteCard(s)).join("");
  $("ex-pick-libs").innerHTML = libs.map((s) => siteCard(s)).join("");
}

/* A card, on the home or in the picker: a new tab on that site; its pin
   toggles the sidebar entry; a right click offers both. */
for (const id of ["lib-home", "lib-picker"]) {
  $(id).addEventListener("click", (e) => {
    const pin = e.target.closest("[data-pin]");
    if (pin) {
      e.stopPropagation();
      togglePin(pin.dataset.pin);
      return;
    }
    const card = e.target.closest("[data-site]");
    if (!card) return;
    const s = LIB.sites.find((x) => x.id === card.dataset.site);
    if (!s) return;
    closeSheet($("lib-picker"));
    openSite(s);
  });
  $(id).addEventListener("contextmenu", (e) => {
    const card = e.target.closest("[data-site]");
    if (!card) return;
    e.preventDefault();
    const s = LIB.sites.find((x) => x.id === card.dataset.site);
    if (!s) return;
    const items = [{ id: "expin:open:" + s.id, label: tr("common.open") }];
    if (s.id !== "space") items.push({}, { id: "expin:" + (LIB.pins.has(s.id) ? "unpin" : "pin") + ":" + s.id, label: tr(LIB.pins.has(s.id) ? "explore.unpin" : "explore.pin") });
    nativeMenu(items, e.clientX, e.clientY);
  });
}

/* The "+" of the tab strip: the picker, a sheet under it. The native view
   hides meanwhile, as for every sheet. */
$("lib-add").addEventListener("click", () => openSheet($("lib-picker")));
$("lib-picker").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeSheet(e.currentTarget);
});
$("lib-picker").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet($("lib-picker"));
});
$("lib-picker-close").addEventListener("click", () => closeSheet($("lib-picker")));

(async () => {
  try {
    LIB.sites = await invoke("lib_sites");
  } catch {
    LIB.sites = [];
  }
  renderHome();
  renderPins();
  renderTabs();
  await loadFavs();
  loadIcons();
})();

window.addEventListener("langchange", () => {
  renderHome();
  renderPins();
  renderTabs();
  renderFavs();
});

/* Native views draw on top of everything: they are hidden while a sheet,
   the viewer or the welcome assistant takes the screen, and brought back
   afterwards. Every sheet counts: one opened by an event (the queue's
   next print, an update, a sign-in) would otherwise sit under the page,
   invisible, its backdrop blocking the app. */
const OVERLAY_SEL = ".modal, .viewer, .welcome";
(() => {
  const check = () => {
    const shown = [...document.querySelectorAll(OVERLAY_SEL)].some((el) => !el.classList.contains("hidden"));
    if (shown) libSuspend();
    else libResume();
  };
  const obs = new MutationObserver(check);
  for (const el of document.querySelectorAll(OVERLAY_SEL)) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
})();
