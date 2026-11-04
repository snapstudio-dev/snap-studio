/* The "What's new" page: built from versions.json, in English or French.

   - ?lang=fr|en picks the language (the app passes its own); otherwise the
     one chosen on the site, English by default.
   - ?embed=1: shown inside the app's viewer. The site's header and footer
     are hidden (see the head), links leaving the page are handed to the app,
     which opens them in the browser, and Esc closes the viewer.
   - #v0.14 lands on a version; a previous version's entry opens.

   The current version is the full page at the top. A previous version that
   has features of its own (0.13) gets the same full section right below it,
   collapsed to a header row until opened (or landed on by its anchor); the
   others are entries of the timeline. A version not released yet has no
   "date": its hero says it is coming; give it its date on release. */
const REPO_URL = "https://github.com/kameka22/snap-studio";
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
const LANG_KEY = "snapstudio.site.lang";
const LOCALES = { en: "en-US", fr: "fr-FR" };
const params = new URLSearchParams(location.search);
const EMBED = params.get("embed") === "1";

let lang = "en";
let data = null;

const ICONS = {
  explore: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16m4.2 3.8-6 2.4-2.4 6 6-2.4zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2",
  prepare: "M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5 8.2v7.6l7 3.9 7-3.9V8.2z",
  sparkle: "M10 2.5c.7 4.3 2.7 6.4 7 7.2-4.3.8-6.3 2.9-7 7.3-.7-4.4-2.7-6.5-7-7.3 4.3-.8 6.3-2.9 7-7.2zM18.2 13.2c.4 2.1 1.3 3.1 3.3 3.5-2 .4-2.9 1.4-3.3 3.6-.4-2.2-1.3-3.2-3.3-3.6 2-.4 2.9-1.4 3.3-3.5z",
  create: "M12 2.5 14 8l5.5 2-5.5 2-2 5.5L10 12 4.5 10 10 8zm6.5 10 1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z",
  minus: "M5 11h14v2H5z",
  tabs: "M3 5h18v4H3zm0 6h8v8H3zm10 0h8v8h-8z",
  camera: "M4 7h11a2 2 0 0 1 2 2v1.5l4-3v9l-4-3V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2",
  stop: "M6 6h12v12H6z",
  progress: "M2 8h20v2H2zm0 6h20v2H2zM2 10h2v4H2zm18 0h2v4h-2zM5 11h10v2H5z",
  printer: "M6 3h12v5H6zM4 9h16a2 2 0 0 1 2 2v6h-4v4H6v-4H2v-6a2 2 0 0 1 2-2m4 7v3h8v-3z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  windows: "M3 5.5 10 4.5v7H3zm0 7h7v7l-7-1zm8-8.2L21 3v8.5H11zm0 8.2h10V21l-10-1.4z",
  check: "m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4z",
  control: "M12 2l3.5 3.5H13V9h-2V5.5H8.5zm0 20-3.5-3.5H11V15h2v3.5h2.5zM2 12l3.5-3.5V11H9v2H5.5v2.5zm20 0-3.5 3.5V13H15v-2h3.5V8.5zM12 10.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6",
  cube: "M12 2l9 5v10l-9 5-9-5V7zm0 2.3L6.2 7.5 12 10.7l5.8-3.2zM5 9.2v6.6l6 3.3v-6.6zm14 0-6 3.3v6.6l6-3.3z",
  spool: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14m0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  send: "M3 20.5 21 12 3 3.5V10l12 2-12 2z",
  shield: "M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5zm-1.2 13.6-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4z",
  mirror: "M11 2h2v20h-2zM9 6v12H3zm6 0 6 12h-6z",
  sliders: "M3 6h10v2H3zm14 0h4v2h-4zm-2-2h2v6h-2zM3 16h4v2H3zm8 0h10v2H11zm-2-2h2v6H9z",
};
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 5.4 10 4l8 8-8 8-1.4-1.4 6.6-6.6z"/></svg>';

function t(key, vars) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(v);
  return s;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/* A text of versions.json in the page's language, English when missing. */
const L = (o) => (o && typeof o === "object" ? o[lang] ?? o.en ?? "" : o ?? "");
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.sparkle}"/></svg>`;

function fmtDate(iso, withYear = true) {
  const d = new Date(`${iso}T12:00:00`);
  if (isNaN(d)) return iso || "";
  const opts = withYear ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "long" };
  return d.toLocaleDateString(LOCALES[lang] || "en-US", opts);
}

/* ?lang= first (not remembered: it is the app's choice), then the site's. */
function initialLang() {
  const q = params.get("lang");
  if (q === "fr" || q === "en") return q;
  try {
    return localStorage.getItem(LANG_KEY) === "fr" ? "fr" : "en";
  } catch {
    return "en";
  }
}

/* ------------------------------------------------------------ rendering */

function heroHtml(v) {
  const chips = chipsHtml(v);
  return `<section class="wn-hero" id="v${esc(v.version)}">
    <div class="wn-icon"><img src="../assets/icon-512.png" alt="${esc(t("wn.icon_alt"))}" width="128" height="128"></div>
    <div class="wn-eyebrow"><i></i>${esc(v.date ? t("wn.eyebrow", { date: fmtDate(v.date) }) : t("wn.eyebrow.next"))}</div>
    <h1>Snap Studio <em>${esc(v.version)}</em></h1>
    <p class="tag">${esc(L(v.tagline))}</p>
    <nav class="wn-jump">${chips}</nav>
  </section>`;
}

/* A screenshot's framing: object-position, and a zoom on that same point to
   show one part of a shared screenshot. */
function shotStyle(f) {
  const css = [];
  if (f.position) css.push(`object-position:${f.position}`);
  if (f.zoom > 1) css.push(`transform:scale(${Number(f.zoom)})`, `transform-origin:${f.position || "50% 50%"}`);
  return css.length ? ` style="${esc(css.join(";"))}"` : "";
}

function chipsHtml(v) {
  return v.features
    .map((f) => `<a href="#${esc(f.id)}"><b style="background:${esc(f.color)}"></b>${esc(L(f.chip))}</a>`)
    .join("");
}

function featureHtml(f, i) {
  const media =
    f.stage === "icon"
      ? `<div class="icon-stage"><div class="glow"></div><img class="big" src="../assets/icon-512.png" alt="">
          <div class="dock"><i></i><i></i><img src="../assets/icon-512.png" alt=""><i></i><i></i></div></div>`
      : `<div class="shot"><img src="${esc(f.image)}" alt="${esc(L(f.alt))}" loading="lazy"${shotStyle(f)}></div>`;
  return `<article class="feat${i % 2 ? " flip" : ""}${f.stage === "icon" ? " icon" : ""}" id="${esc(f.id)}" style="--c:${esc(f.edge)};--c1:${esc(f.color)}">
    <div class="media">${media}</div>
    <div class="txt">
      <div class="tagc">${icon(f.icon)}${esc(L(f.tag))}</div>
      <h3>${esc(L(f.title))}</h3>
      <p>${esc(L(f.text))}</p>
    </div>
  </article>`;
}

function smallHtml(v, h = "h2") {
  if (!v.small || !v.small.length) return "";
  const items = v.small
    .map((s) => `<li style="--c:${esc(s.color)}"><span class="i">${icon(s.icon)}</span><div><b>${esc(L(s.title))}</b><span>${esc(L(s.text))}</span></div></li>`)
    .join("");
  return `<section class="wn-small">
    <div class="wn-h2"><${h}>${esc(t("wn.small.title"))}</${h}><span>${esc(t("wn.small.sub"))}</span></div>
    <ul class="small-grid">${items}</ul>
  </section>`;
}

/* A previous version with a full section: a header row (version, tagline,
   summary) that opens the section in place. */
function laterHtml(v, open) {
  const id = `v${v.version}`;
  return `<section class="wn-later${open ? " open" : ""}" id="${esc(id)}">
    <h2 class="later-h"><button type="button" class="later-head" aria-expanded="${open}" aria-controls="${esc(id)}-body">
      <span class="lv">${esc(v.version)}</span>
      <span class="lt"><span class="le">${esc(t("wn.later.eyebrow", { date: fmtDate(v.date) }))}</span><b>${esc(L(v.tagline))}</b><span class="ls">${esc(L(v.summary))}</span></span>
      <span class="lcta"><span>${esc(t(open ? "wn.later.hide" : "wn.later.show"))}</span>${CHEVRON}</span>
    </button></h2>
    <div class="later-body" id="${esc(id)}-body" role="region" aria-label="${esc(`Snap Studio ${v.version}`)}"${open ? "" : " inert"}><div class="later-in">
      <nav class="wn-jump">${chipsHtml(v)}</nav>
      <div class="wn-feats">${v.features.map(featureHtml).join("")}</div>
      ${smallHtml(v, "h3")}
      <a class="later-notes" href="${REPO_URL}/releases/tag/v${esc(v.version)}.0">${esc(t("wn.prev.notes", { v: v.version }))}</a>
    </div></div>
  </section>`;
}

/* Opens or closes a full previous section; without animation when landing
   on its anchor, so the scroll that follows finds it at its full height. */
function setLater(sec, open, animate = true) {
  if (!sec || sec.classList.contains("open") === open) return;
  if (!animate) sec.classList.add("instant");
  sec.classList.toggle("open", open);
  const head = sec.querySelector(".later-head");
  head.setAttribute("aria-expanded", String(open));
  head.querySelector(".lcta > span").textContent = t(open ? "wn.later.hide" : "wn.later.show");
  sec.querySelector(".later-body").inert = !open;
  if (!animate) {
    void sec.offsetHeight;
    sec.classList.remove("instant");
  }
}

function previousHtml(list, open) {
  const items = list
    .map((v) => {
      const hl = v.highlights.map((h) => `<li><b>${esc(L(h.title))}</b> — ${esc(L(h.text))}</li>`).join("");
      const img = v.image ? `<img class="ver-img" src="${esc(v.image)}" alt="${esc(L(v.alt))}">` : "";
      return `<details class="ver" id="v${esc(v.version)}"${open.has(v.version) ? " open" : ""}>
        <summary><span class="v">${esc(v.version)}</span><span class="d">${esc(fmtDate(v.date, false))}</span><span class="hl">${esc(L(v.summary))}</span>${CHEVRON}</summary>
        <div class="body"><ul>${hl}</ul>${img}
          <a href="${REPO_URL}/releases/tag/v${esc(v.version)}.0">${esc(t("wn.prev.notes", { v: v.version }))}</a></div>
      </details>`;
    })
    .join("");
  return `<section class="wn-prev">
    <div class="wn-h2"><h2>${esc(t("wn.prev.title"))}</h2><span><a href="${REPO_URL}/releases">${esc(t("wn.prev.all"))}</a></span></div>
    <div class="tl">${items}
      <div class="ver older"><a href="${CHANGELOG_URL}">${esc(t("wn.older"))}</a></div>
    </div>
  </section>`;
}

function render() {
  const main = document.getElementById("wn");
  const cur = data.versions.find((v) => v.version === data.current) || data.versions[0];
  const later = data.versions.filter((v) => v !== cur && v.features && v.features.length);
  const prev = data.versions.filter((v) => v !== cur && !later.includes(v));
  // Entries opened by the reader stay open across a language switch; the
  // most recent one of the timeline is open at first, full sections closed.
  const was = [...main.querySelectorAll("details.ver[open], .wn-later.open")].map((d) => d.id.slice(1));
  const open = new Set(main.querySelector("details.ver") ? was : prev.slice(0, 1).map((v) => v.version));
  const target = decodeURIComponent(location.hash.slice(1));
  if (target.startsWith("v")) open.add(target.slice(1));
  main.innerHTML =
    heroHtml(cur) +
    `<section class="wn-feats">${cur.features.map(featureHtml).join("")}</section>` +
    smallHtml(cur) +
    later.map((v) => laterHtml(v, open.has(v.version))).join("") +
    previousHtml(prev, open) +
    `<p class="wn-foot">${t("wn.foot").split("{link}").map(esc).join(`<a href="${CHANGELOG_URL}">CHANGELOG</a>`)}</p>`;
  main.removeAttribute("aria-busy");
  document.title = t("wn.meta.title", { v: cur.version });
}

function renderError() {
  const main = document.getElementById("wn");
  main.innerHTML = `<p class="wn-status">${esc(t("wn.error"))} <a href="${CHANGELOG_URL}">CHANGELOG ›</a></p>`;
  main.removeAttribute("aria-busy");
}

/* Brings the version of the address into view, its entry opened. */
function showHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === "DETAILS") el.open = true;
  setLater(el.closest(".wn-later"), true, false);
  el.scrollIntoView({ block: "start" });
}

function applyLang(next, persist) {
  lang = next === "fr" ? "fr" : "en";
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  document.querySelectorAll(".lang [data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  if (persist) {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {}
  }
  if (data) render();
}

/* ------------------------------------------------------------ the app's viewer */

function tellApp(msg) {
  if (EMBED && window.parent !== window) window.parent.postMessage({ source: "snapstudio-whats-new", ...msg }, "*");
}

if (EMBED) {
  // A link leaving the page (GitHub, the site's home) opens in the browser:
  // the viewer only shows this page.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const url = new URL(a.getAttribute("href"), location.href);
    if (url.origin === location.origin && url.pathname === location.pathname) return;
    e.preventDefault();
    tellApp({ type: "open", url: url.href });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") tellApp({ type: "close" });
  });
}

document.getElementById("wn").addEventListener("click", (e) => {
  const head = e.target.closest(".later-head");
  if (head) setLater(head.closest(".wn-later"), head.getAttribute("aria-expanded") !== "true");
});
document.querySelectorAll(".lang [data-lang]").forEach((b) => b.addEventListener("click", () => applyLang(b.dataset.lang, true)));
window.addEventListener("hashchange", showHash);
applyLang(initialLang(), false);

fetch("versions.json", { cache: "no-cache" })
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((j) => {
    data = j;
    render();
    showHash();
    tellApp({ type: "ready" });
  })
  .catch(() => {
    renderError();
    tellApp({ type: "error" });
  });
