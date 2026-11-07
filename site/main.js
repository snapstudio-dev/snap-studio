/* Language, OS detection and the latest release's download links. */
const REPO = "kameka22/snap-studio";
const RELEASES = `https://github.com/${REPO}/releases`;
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const LANG_KEY = "snapstudio.site.lang";
const OS_NAMES = { macos: "macOS", windows: "Windows", linux: "Linux" };

let lang = "en";
let release = { state: "loading", version: null };

function t(key, vars) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(v);
  return s;
}

/* English by default; French only when chosen and remembered. */
function savedLang() {
  try {
    return localStorage.getItem(LANG_KEY) === "fr" ? "fr" : "en";
  } catch {
    return "en";
  }
}

function applyLang(next, persist) {
  lang = STRINGS[next] ? next : "en";
  document.documentElement.lang = lang;
  document.title = t("meta.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => (el.alt = t(el.dataset.i18nAlt)));
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  document.querySelectorAll("[data-i18n-roledesc]").forEach((el) => el.setAttribute("aria-roledescription", t(el.dataset.i18nRoledesc)));
  document.querySelectorAll(".lang [data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  if (typeof galleryRelabel === "function") galleryRelabel();
  if (persist) {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {}
  }
  renderDownloads();
}

function detectOS() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const s = `${p} ${navigator.userAgent}`;
  if (/Android|iPhone|iPad|iPod/i.test(s)) return null;
  if (/Mac/i.test(s)) return "macos";
  if (/Win/i.test(s)) return "windows";
  if (/Linux|X11/i.test(s)) return "linux";
  return null;
}

/* The asset for each OS in a release's files. */
function pickAssets(assets) {
  const by = (re) => assets.find((a) => re.test(a.name));
  return {
    macos: by(/\.dmg$/i),
    windows: by(/setup\.exe$/i) || by(/\.msi$/i) || by(/\.exe$/i),
    linux: by(/amd64\.AppImage$/i) || by(/x86_64\.AppImage$/i) || by(/\.AppImage$/i),
  };
}

function renderDownloads() {
  const os = detectOS();
  const links = release.links || {};
  for (const key of Object.keys(OS_NAMES)) {
    const a = document.getElementById(`dl-${key}`);
    a.href = links[key] || RELEASES;
    a.classList.toggle("current", key === os);
  }
  const hero = document.getElementById("hero-dl");
  hero.href = (os && links[os]) || (os ? `${RELEASES}` : "#download");
  document.getElementById("hero-dl-label").textContent = os ? t("dl.button_os", { os: OS_NAMES[os] }) : t("dl.button");
  document.getElementById("hero-dl-note").textContent = os ? t("dl.other") : "";
  const v = document.getElementById("dl-version");
  v.textContent =
    release.state === "ok" ? t("dl.version", { v: release.version })
    : release.state === "none" ? t("dl.none")
    : release.state === "error" ? t("dl.fallback")
    : t("dl.loading");
}

async function loadRelease() {
  try {
    const r = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 404) {
      release = { state: "none" };
    } else if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    } else {
      const j = await r.json();
      const picked = pickAssets(Array.isArray(j.assets) ? j.assets : []);
      const links = {};
      for (const [k, a] of Object.entries(picked)) if (a && a.browser_download_url) links[k] = a.browser_download_url;
      release = { state: "ok", version: j.tag_name || j.name || "", links };
    }
  } catch {
    release = { state: "error" };
  }
  renderDownloads();
}

document.querySelectorAll(".lang [data-lang]").forEach((b) => b.addEventListener("click", () => applyLang(b.dataset.lang, true)));
applyLang(savedLang(), false);
loadRelease();
