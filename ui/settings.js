"use strict";
/* Settings: a menu of categories on the left, one pane at a time on the
   right. Changing category slides the content vertically, in the menu's
   order: a category lower in the menu comes up from below, a higher one
   down from above. The last category comes back next time. */

const SET_KEY = "snapstudio.setcat";
const SET_CATS = [...document.querySelectorAll("#set-menu .set-cat")].map((b) => b.dataset.cat);
let setCurrent = null;
/* What a category does when it shows, for the ones added from outside. */
const SET_SHOWN = {};

/* A category's title: its key, or its own text (an added section). */
const setTitleOf = (pane) => {
  const t = pane.querySelector(".set-title");
  return t?.dataset.i18n ? tr(t.dataset.i18n) : t?.textContent || "";
};

/* A section added from outside ui/ (a development build's own, injected
   at its start): its menu entry goes before About. `pane` holds a
   `.set-title`; `onShow` runs each time it shows. */
function settingsAddPane({ cat, label, color, icon, pane, onShow }) {
  const b = document.createElement("button");
  b.className = "set-cat";
  b.dataset.cat = cat;
  b.innerHTML = `<span class="glyph" style="color: ${color}">${icon}</span><span class="lbl"></span><i class="set-dot"></i>`;
  b.querySelector(".lbl").textContent = label;
  $("set-menu").insertBefore(b, document.querySelector('#set-menu .set-cat[data-cat="about"]'));
  pane.classList.add("set-pane");
  pane.dataset.cat = cat;
  $("set-stage").appendChild(pane);
  SET_CATS.splice(SET_CATS.indexOf("about"), 0, cat);
  if (onShow) SET_SHOWN[cat] = onShow;
}

/* Shows a category; `animate` slides from the previous one. */
function setCategory(cat, animate = true) {
  if (!SET_CATS.includes(cat)) cat = SET_CATS[0];
  const prev = setCurrent;
  setCurrent = cat;
  localStorage.setItem(SET_KEY, cat);
  document.querySelectorAll("#set-menu .set-cat").forEach((b) => b.classList.toggle("on", b.dataset.cat === cat));
  const panes = document.querySelectorAll("#set-stage .set-pane");
  const next = document.querySelector(`#set-stage .set-pane[data-cat="${cat}"]`);
  const old = prev && prev !== cat ? document.querySelector(`#set-stage .set-pane[data-cat="${prev}"]`) : null;
  panes.forEach((p) => {
    const keep = p === next || p === old;
    if (!keep) p.getAnimations().forEach((a) => a.cancel());
    p.classList.toggle("on", keep);
  });
  next.getAnimations().forEach((a) => a.cancel());
  tbSet("settings", tr("nav.settings"), setTitleOf(next));
  SET_SHOWN[cat]?.();
  if (cat === "ai") setAiRender();
  if (cat === "display") dispRender();
  if (cat === "about") aboutLoad();
  if (!old) {
    panes.forEach((p) => p.classList.toggle("on", p === next));
    return;
  }
  const still = !animate || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still) {
    old.classList.remove("on");
    return;
  }
  // Down the menu: the content moves up; up the menu: it moves down.
  const dir = SET_CATS.indexOf(cat) > SET_CATS.indexOf(prev) ? 1 : -1;
  const h = $("set-stage").clientHeight * 0.35;
  const opts = { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  next.scrollTop = 0;
  next.animate([{ transform: `translateY(${dir * h}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], opts);
  old.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${-dir * h}px)`, opacity: 0 }], { ...opts, fill: "forwards" });
  // The leaving pane goes once its slide is over — or at once if another
  // change comes first.
  clearTimeout(setLeave);
  setLeave = setTimeout(() => {
    old.getAnimations().forEach((a) => a.cancel());
    if (setCurrent !== prev) old.classList.remove("on");
  }, opts.duration);
}
let setLeave = 0;

$("set-menu").addEventListener("click", (e) => {
  const b = e.target.closest(".set-cat");
  if (b && b.dataset.cat !== setCurrent) setCategory(b.dataset.cat);
});

/* Arrow keys move through the menu when it has the focus. */
$("set-menu").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const i = SET_CATS.indexOf(setCurrent) + (e.key === "ArrowDown" ? 1 : -1);
  if (i >= 0 && i < SET_CATS.length) {
    setCategory(SET_CATS[i]);
    document.querySelector(`#set-menu .set-cat[data-cat="${SET_CATS[i]}"]`).focus();
  }
});

/* Opening Settings: the category that needs attention, otherwise the last
   one seen. */
function settingsShown() {
  const flagged = document.querySelector("#set-menu .set-cat.flag");
  setCategory(flagged ? flagged.dataset.cat : localStorage.getItem(SET_KEY) || SET_CATS[0], false);
}

/* ------------------------------------------------------------ AI */

function setAiRender() {
  $("set-ai-mode").value = aiChoice();
  // Which sandbox: with a Sandbox side, and where the built-in one exists.
  const side = aiWanted().some((m) => m !== "local");
  $("set-ai-sandbox-row").classList.toggle("hidden", !side || AI_OS === "windows");
  $("set-ai-sandbox").value = aiSandbox();
  $("set-ai-sandbox-sub").textContent = tr(aiSandbox() === "yolobox" ? "settings.ai.sandbox.yolobox.sub" : "settings.ai.sandbox.builtin.sub");
  // A yolobox user whose built-in sandbox is ready: offered, never switched.
  $("set-ai-builtin").classList.toggle("hidden", !(side && aiSandbox() === "yolobox" && AI_OS !== "windows" && AIS.report?.ready.sandbox));
  $("set-ai-mode")._seg?.render();
  aiRenderChecks($("set-ai-checks"), aiChoice());
}

/* The AI's dot: a chosen mode is not ready. */
function setAiFlag() {
  const r = AIS.report;
  const flag = !!r && aiWanted().some((m) => !r.ready[m]);
  document.querySelector('#set-menu .set-cat[data-cat="ai"]').classList.toggle("flag", flag);
}

$("set-ai-mode").addEventListener("change", (e) => aiSetChoice(e.target.value));
$("set-ai-sandbox").addEventListener("change", (e) => aiSetSandbox(e.target.value));
$("set-ai-builtin-go").addEventListener("click", () => aiSetSandbox("builtin"));
$("set-ai-recheck").addEventListener("click", () => {
  aiCheck(true);
  setAiRender();
});

window.addEventListener("aichange", () => {
  setAiFlag();
  if (setCurrent === "ai") setAiRender();
});

window.addEventListener("langchange", () => {
  if (setCurrent) tbSet("settings", tr("nav.settings"), setTitleOf(document.querySelector(`#set-stage .set-pane[data-cat="${setCurrent}"]`)));
  if (setCurrent === "ai") setAiRender();
});

/* ------------------------------------------------------------ display */

/* Appearance, theme and accent (themes.js). Each theme is shown as a small
   window in the resolved mode with the chosen accent, so the tiles are the
   live preview; the whole app changes at once too. */
function dispMockStyle(themeId, mode) {
  const s = { ...DISPLAY, theme: themeId };
  const tokens = displayTokens(s, mode, DISPLAY_SPOOL);
  const accent = tokens["--accent"] || (CSS.supports("color", "AccentColor") ? "AccentColor" : "#007aff");
  const rgb = parseColor(cssColor(accent)) || [0, 122, 255];
  return Object.entries({ ...tokens, "--accent": accent, "--accent-text": accentTextFor(rgb) })
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

function dispRender() {
  const mode = isDark() ? "dark" : "light";
  document.querySelectorAll("#disp-mode [data-mode-pick]").forEach((b) => {
    const on = b.dataset.modePick === DISPLAY.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
    b.tabIndex = on ? 0 : -1;
  });
  $("disp-themes").innerHTML = THEMES.map((t) => {
    const on = t.id === DISPLAY.theme;
    return `<button type="button" class="disp-theme${on ? " on" : ""}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-theme-pick="${t.id}">
      <span class="disp-mock" data-scheme="${mode}" data-mock="${t.id}" style="${esc(dispMockStyle(t.id, mode))}" aria-hidden="true">
        <span class="dm-pills"><i></i><i></i></span>
        <span class="dm-side"><i class="on"></i><i></i><i></i></span>
        <span class="dm-main"><span class="dm-card"><i></i><i class="s"></i><b></b></span><span class="dm-card"><i></i><i class="s"></i></span></span>
        <span class="dm-sheet"><i></i><i class="s"></i><b></b></span>
      </span>
      <span class="disp-name">${esc(tr(t.name))}</span>
      <span class="disp-sub">${esc(tr(t.sub))}</span>
    </button>`;
  }).join("");
  // Accent: the theme's own, the system's, a preset or a picked color.
  const theme = themeById(DISPLAY.theme);
  const own = displayAccent({ ...DISPLAY, accent: "theme" }, mode, DISPLAY_SPOOL);
  const custom = DISPLAY.accent.startsWith("#") ? DISPLAY.accent : "";
  const sw = (id, label, style, cls = "") => {
    const on = DISPLAY.accent === id;
    return `<button type="button" class="disp-sw${cls}${on ? " on" : ""}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-accent="${id}" title="${esc(label)}" aria-label="${esc(label)}" style="${style}"></button>`;
  };
  $("disp-accents").innerHTML =
    sw("theme", tr("display.accent.theme"), own ? `--c: ${own}` : "", own ? "" : " sys") +
    sw("system", tr("display.accent.system"), "", " sys") +
    '<span class="disp-sep"></span>' +
    ACCENTS.map((a) => sw(a.id, tr(a.name), `--c: ${a.hex}`)).join("") +
    `<label class="disp-sw custom${custom ? " on" : ""}" title="${esc(tr("display.accent.custom"))}"${custom ? ` style="--c: ${custom}"` : ""}>` +
    `<input type="color" id="disp-color" value="${custom || own || "#007aff"}" aria-label="${esc(tr("display.accent.custom"))}" /></label>`;
  $("disp-cvd").checked = DISPLAY.cvd;
  const preset = ACCENTS.find((a) => a.id === DISPLAY.accent);
  $("disp-accent-sub").textContent =
    DISPLAY.accent === "theme" && theme.accentFrom === "spool"
      ? DISPLAY_SPOOL ? tr("display.accent.spool", { color: DISPLAY_SPOOL.toUpperCase() }) : tr("display.accent.spool.none")
    : DISPLAY.accent === "theme" ? tr(own ? "display.accent.theme.own" : "display.accent.theme.system", { name: tr(theme.name) })
    : DISPLAY.accent === "system" ? tr("display.accent.system.sub")
    : preset ? tr(preset.name)
    : tr("display.accent.custom") + " " + custom.toUpperCase();
}

const dispSet = (patch) => {
  displaySet(patch);
  dispRender();
};
$("disp-mode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode-pick]");
  if (b) dispSet({ mode: b.dataset.modePick });
});
$("disp-themes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-pick]");
  if (b) dispSet({ theme: b.dataset.themePick });
});
$("disp-accents").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-accent]");
  if (b) dispSet({ accent: b.dataset.accent });
});
// The color picker: the app follows live while it moves (the pane is not
// rebuilt under the open picker), the color is kept when it closes.
let dispPicking = false;
$("disp-accents").addEventListener("input", (e) => {
  if (e.target.id !== "disp-color") return;
  dispPicking = true;
  displayApply({ ...DISPLAY, accent: e.target.value });
});
$("disp-accents").addEventListener("change", (e) => {
  if (e.target.id !== "disp-color") return;
  dispPicking = false;
  dispSet({ accent: e.target.value });
});
$("disp-reset").addEventListener("click", () => dispSet({ ...DISPLAY_DEFAULT }));
$("disp-cvd").addEventListener("change", (e) => dispSet({ cvd: e.target.checked }));

/* Arrow keys move the choice inside each group, as in a radio group. */
for (const [id, sel, key] of [["disp-mode", "[data-mode-pick]", "modePick"], ["disp-themes", "[data-theme-pick]", "themePick"], ["disp-accents", "button[data-accent]", "accent"]]) {
  $(id).addEventListener("keydown", (e) => {
    // In the theme grid, up / down move by a row (as many as its columns).
    const cols = id === "disp-themes" ? getComputedStyle($(id)).gridTemplateColumns.split(" ").filter(Boolean).length || 1 : 1;
    const step = { ArrowRight: 1, ArrowDown: cols, ArrowLeft: -1, ArrowUp: -cols, Home: -Infinity, End: Infinity }[e.key];
    if (!step) return;
    const items = [...$(id).querySelectorAll(sel)];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next =
      step === -Infinity ? items[0]
      : step === Infinity ? items[items.length - 1]
      : Math.abs(step) > 1 ? items[Math.min(items.length - 1, Math.max(0, i + step))]
      : items[(i + step + items.length) % items.length];
    if (next === items[i]) return;
    dispSet({ [key === "modePick" ? "mode" : key === "themePick" ? "theme" : "accent"]: next.dataset[key] });
    $(id).querySelector(`${sel.replace("]", `="${next.dataset[key]}"]`)}`)?.focus();
  });
}

window.addEventListener("themechange", () => setCurrent === "display" && !dispPicking && dispRender());
window.addEventListener("langchange", () => setCurrent === "display" && dispRender());

/* ------------------------------------------------------------ about */

const REPO = "https://github.com/kameka22/snap-studio";
const ABOUT = { version: "", system: "" };

async function aboutLoad() {
  if (!ABOUT.version) {
    [ABOUT.version, ABOUT.system] = await Promise.all([
      invoke("app_version").catch(() => ""),
      invoke("system_name").catch(() => ""),
    ]);
  }
  $("about-version").textContent = tr("about.version", { version: ABOUT.version, system: ABOUT.system });
}

/* What a bug report needs beyond the version and the system. */
function aboutDetails() {
  const engine = typeof ENG !== "undefined" && ENG.status?.installed ? `Snapmaker Orca ${ENG.status.version}` : "—";
  const ai = AIS.report ? aiAllowed().join(", ") || "not ready" : "not checked";
  return [`Language: ${LANG}`, `Slicing engine: ${engine}`, `AI: ${aiChoice()} (ready: ${ai})`].join("\n");
}

/* Opens a page of the project; a bug report comes prefilled. */
async function aboutOpen(what) {
  await aboutLoad();
  const q = (o) => new URLSearchParams(o).toString();
  const url = {
    bug: `${REPO}/issues/new?${q({ template: "bug.yml", version: ABOUT.version, os: ABOUT.system, details: aboutDetails() })}`,
    idea: `${REPO}/issues/new?${q({ template: "feature.yml", version: ABOUT.version })}`,
    contribute: `${REPO}/blob/main/${LANG === "fr" ? "CONTRIBUTING.fr.md" : "CONTRIBUTING.md"}`,
    discuss: `${REPO}/discussions`,
    github: REPO,
    issues: `${REPO}/issues`,
    licenses: `${REPO}/blob/main/ui/vendor/NOTICE.md`,
  }[what];
  if (url) invoke("plugin:opener|open_url", { url }).catch((e) => toast(String(e), true));
}

document.querySelector('#set-stage .set-pane[data-cat="about"]').addEventListener("click", (e) => {
  const b = e.target.closest("[data-about]");
  if (b) aboutOpen(b.dataset.about);
});

/* Help menu: report, suggest, the project. */
onMenu("help", (what) => aboutOpen(what));

/* ------------------------------------------------------------ pills */

/* Settings with few choices as pills over their selects (segmented.js). */
const SET_WHEEL_ICONS = {
  zoom: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3m0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10m-1 2h2v2h2v2h-2v2H9v-2H7V9h2z"/></svg>',
  pan: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.5 3.5-1.4 1.4L13 5.8V11h5.2l-1.1-1.1 1.4-1.4L22 12l-3.5 3.5-1.4-1.4 1.1-1.1H13v5.2l1.1-1.1 1.4 1.4L12 22l-3.5-3.5 1.4-1.4 1.1 1.1V13H5.8l1.1 1.1-1.4 1.4L2 12l3.5-3.5 1.4 1.4L5.8 11H11V5.8L9.9 6.9 8.5 5.5z"/></svg>',
  orbit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 0 1 7.7 5.8l1.8-1v5.4l-4.7-2.7 1.8-1A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8m-6.7 9.5 4.7 2.7-1.8 1A6 6 0 0 0 18 12h2a8 8 0 0 1-15.7 2.2l-1.8 1V9.8z"/></svg>',
};
segmented("set-wheel-action", { icons: SET_WHEEL_ICONS });
// Short words in the pills, the full ones in their tooltips.
const SET_PREF_SHORT = ["settings.thumb.short.auto", "settings.thumb.short.plate", "settings.thumb.short.model", "settings.thumb.short.render"];
segmented("opt-pref", {
  labelOf: (v, text) => (SET_PREF_SHORT[+v] ? tr(SET_PREF_SHORT[+v]) : text),
  titleOf: (v) => $("opt-pref").querySelector(`option[value="${v}"]`)?.text || "",
});
segmented("set-assoc");
segmented("set-ai-sandbox");
segmented("set-slice-level");
// Long choices: radio cards, each with what it means.
segmented("set-ai-mode", {
  cls: "cards",
  // The Sandbox card says which sandbox it is.
  subs: { get container() { return aiSandboxSub(); }, local: "welcome.ai.local.sub", both: "welcome.ai.both.sub" },
});
$("set-ai-mode").closest(".grow-row").classList.add("stack");
