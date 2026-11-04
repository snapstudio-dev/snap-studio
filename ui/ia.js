"use strict";
/* AI tab: one conversation per object — to modify, or to create from scratch.

   Each conversation owns a working folder, prepared by Rust: the object as
   a 3MF of colored parts, the instructions, the tools and the export skill.
   The detail screen holds the conversation and the 3D pane. */

/* A stored value, or null: a throwing storage (private mode, cleared site
   data) must not stop this script at load. */
const iaLs = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

const IA = {
  list: [],
  engine: null,
  /* The file picked in Files, while the sheet is open; null when creating
     an object from scratch. */
  source: null,
  /* "edit" from Files, "create" from the ＋ button. */
  mode: "edit",
  /* Images and models added in the sheet: they leave with the initial
     request. */
  attach: [],
  /* Conversation open on screen, or null on the list. */
  open: null,
  /* How the open conversation shows: "chat" (ia-chat.js) or "term", the raw
     Claude Code terminal on the same session. */
  view: iaLs("snapstudio.iaview") === "term" ? "term" : "chat",
  /* One emulator per conversation: leaving the tab must not erase anything.
     id -> { term, fit, el, dead } */
  terms: new Map(),
  /* List: search, filters and order (ia-list.js), kept between launches. */
  q: "",
  filters: iaStored("snapstudio.ia.filters", { kind: "all", state: "all", engine: "all" }),
  sort: IA_SORTS.includes(iaLs("snapstudio.ia.sort")) ? iaLs("snapstudio.ia.sort") : IA_SORTS[0],
  /* Card selected with the keyboard (or last clicked), by id. */
  sel: null,
  /* Card whose title is being edited. */
  renaming: null,
  /* Conversations whose last turn failed, this session. */
  failed: new Set(),
  /* Pinned conversations: on top of the list. */
  pinned: new Set(iaStored("snapstudio.ia.pinned", [])),
};

function iaStored(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(fallback)) return Array.isArray(v) ? v.filter((x) => typeof x === "string") : fallback;
    if (v && typeof v === "object") {
      const out = { ...fallback };
      for (const k of Object.keys(fallback)) if (IA_FILTERS[k]?.includes(v[k])) out[k] = v[k];
      return out;
    }
  } catch {}
  return fallback;
}

/* ------------------------------------------------------------ loading */

async function iaRefresh() {
  try {
    IA.list = await invoke("ia_list");
  } catch (e) {
    IA.list = [];
  }
  iaRender();
  // What the AI needs changes without notice — Docker starts and stops —
  // and checking takes a moment: on the side, when the tab opens, at most
  // once every 30 s (the Docker and Python probes are not free). The
  // "aichange" event the check raises redraws the list.
  if (Date.now() - (IA.checkedAt || 0) > 30000) {
    IA.checkedAt = Date.now();
    aiCheck(true).then(iaApplyAi);
  }
}

/* Why a conversation is only read: its mode is not ready (anymore), or not
   chosen. A container conversation keeps yolobox, whichever sandbox new
   ones use. */
const iaLockFor = (c) => (AIS.report && !aiEngineReady(c.engine) ? iaLockReason(c) : null);

/* New checks, or a new choice in Settings. */
window.addEventListener("aichange", () => {
  const c = IA.open ? IA.list.find((x) => x.id === IA.open) : null;
  if (c) {
    // The open conversation follows: AI switched off in Settings, or Docker
    // gone, locks it; back again unlocks it.
    const locked = iaLockFor(c);
    if (locked !== IA.locked) {
      IA.locked = locked;
      if (locked) IA.view = "chat";
      iaRender();
      iaHint(c);
    }
  } else iaRender();
  if (!$("iamodal").classList.contains("hidden")) iaRenderEngines();
  iaApplyAi();
});

/* The modes a new conversation may use (see ai-setup.js). */
const iaModes = () => aiAllowed();

function iaEngineLabel() {
  const modes = iaModes();
  if (!modes.length) return AIS.report ? tr("ia.engine.unavailable") : "";
  return modes.map((m) => tr("ais.mode." + m)).join(" · ");
}

/* Buttons that start a conversation, and the banner that says why they
   cannot. */
function iaApplyAi() {
  const reason = AIS.report ? aiBlockedReason() : null;
  for (const [id, title] of [["ia-new", "ia.new.button"], ["ia-empty-new", null], ["act-ia", null]]) {
    const b = $(id);
    b.disabled = !!reason;
    b.title = reason || (title ? tr(title) : "");
  }
  $("ia-blocked").classList.toggle("hidden", !reason || !!IA.open);
  $("ia-blocked-text").textContent = reason || "";
}

/* ------------------------------------------------------------ display */

const iaIsCreation = (c) => c.kind === "create";
/* A created object Claude has not exported a first time yet. */
const iaEmpty = (c) => !!c && iaIsCreation(c) && !c.version;

/* The original object's thumbnail, served by the thumbnail protocol. A
   created object has none: show the preview the app renders for Claude, the
   version busting the cache. */
const iaThumb = (c) =>
  iaIsCreation(c)
    ? schemeUrl("thumb", `/ia?ia=${encodeURIComponent(c.id)}&v=${c.version}`)
    : thumbSrc(c.source, 176, 0, c.created_at);

/* "from support.3mf", or "new design · My models" for a new object. */
function iaOrigin(c) {
  if (!iaIsCreation(c)) return tr("ia.from", { name: c.source_name });
  return c.dest_dir ? `${tr("ia.creation")} · ${baseName(c.dest_dir)}` : tr("ia.creation");
}

const iaEngineName = (c) => tr(c.engine === "container" ? "ia.engine.container_short" : c.engine === "sandbox" ? "ia.engine.sandbox_short" : "ia.engine.local_short");

/* Missing or unreadable source: a real tile. The fallback is wired by a
   listener (below), never an inline onerror — the app's CSP (script-src
   'self') blocks inline handlers, which left the broken-image icon. */
const IA_MISSING = '<svg viewBox="0 0 24 24"><path d="M12 2 3 7v10l9 5 9-5V7zm0 2.3 6.4 3.6L12 11.4 5.6 7.9zM5 9.6l6 3.4v6.6l-6-3.4zm8 10V13l6-3.4v6.6z"/></svg>';
function iaPlaceholder(c) {
  const hint = tr(iaIsCreation(c) ? "ia.thumb.unavailable" : "ia.thumb.source_missing");
  return `<div class="ia-thumb blank missing" title="${esc(hint)}">${IA_MISSING}<span>${esc(hint)}</span></div>`;
}

/* An error event does not bubble, but it is seen on the way down. */
$("ia-list").addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("ia-thumb")) return;
    const c = IA.list.find((x) => x.id === img.closest(".ia-card")?.dataset.id);
    if (c) img.outerHTML = iaPlaceholder(c);
  },
  true
);

/* Statuses, the most pressing first (ia-list.js `iaStatusOf`). */
const IA_STATUS_LABEL = {
  running: "ia.status.running",
  error: "ia.status.error",
  draft: "ia.status.draft",
  saved: "ia.saved_badge",
  pending: "ia.pending_badge",
};
const iaStatusKey = (c) => iaStatusOf(c, { running: typeof CHAT !== "undefined" && CHAT.busy.has(c.id), failed: IA.failed.has(c.id) });
const iaBadge = (c) => {
  const k = iaStatusKey(c);
  return `<span class="ia-st ${k}">${esc(tr(IA_STATUS_LABEL[k]))}</span>`;
};

const IA_GROUP_LABEL = {
  pinned: "ia.group.pinned",
  today: "ia.group.today",
  yesterday: "ia.group.yesterday",
  week: "ia.group.week",
  earlier: "ia.group.earlier",
};

/* The list as shown: pinned ones first, then the groups of ia-list.js. */
function iaGroups() {
  const opts = { query: IA.q, filters: IA.filters, sort: IA.sort, compare: collate };
  const pinned = IA.list.filter((c) => IA.pinned.has(c.id));
  const rest = IA.list.filter((c) => !IA.pinned.has(c.id));
  const top = iaGroupList(pinned, opts).flatMap((g) => g.items);
  const groups = iaGroupList(rest, opts);
  return top.length ? [{ key: "pinned", items: top }, ...groups] : groups;
}

/* What the list's status badge says, put where it belongs in the open
   conversation: "saved" / "not saved" on the Save button (a draft has
   nothing to save, the button is off), an error as a red dot on the
   Conversation tab, whose log holds the message; "answering" is already
   the chat's own status line with its Stop button. */
function iaDetailState() {
  const c = IA.open && IA.list.find((x) => x.id === IA.open);
  if (!c) return;
  const btn = $("ia-save");
  const path = iaSavedPath(c);
  const waiting = !$("ia-wait").classList.contains("hidden");
  btn.classList.toggle("done", !!path && !waiting);
  $("ia-save-label").textContent = tr(path && !waiting ? "ia.save_done" : "ia.save_short");
  btn.title = waiting
    ? tr("ia.save_nothing")
    : path
      ? tr("ia.save_done_title", { v: c.version, name: path.split(/[\\/]/).pop() })
      : tr("ia.save_title", { v: c.version });
  btn.setAttribute("aria-label", path && !waiting ? tr("ia.save_done_aria", { v: c.version }) : tr("ia.save"));
  const tab = document.querySelector('#ia-views [data-iaview="chat"]');
  const failed = IA.failed.has(c.id);
  tab.classList.toggle("alert", failed);
  if (failed) tab.title = tr("ia.chat_failed");
  else tab.removeAttribute("title");
  iaFitDock();
}

/* Something changed a status (a turn started, ended, failed). */
function iaStatusChanged() {
  if (IA.open) iaDetailState();
  else if (!IA.renaming && !$("view-ia").classList.contains("hidden")) iaRenderList();
}

/* Conversations under the sidebar's AI entry, like recent folders under
   Files; the open conversation is selected there. */
const IA_GLYPH = '<svg viewBox="0 0 24 24"><path d="M12 2.5 14 8l5.5 2-5.5 2-2 5.5L10 12 4.5 10 10 8zm6.5 10 1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/></svg>';
function iaRenderSide() {
  const box = $("side-ia");
  box.innerHTML = "";
  for (const c of IA.list) {
    const b = document.createElement("button");
    b.className = "side-item";
    b.dataset.conv = c.id;
    b.title = iaOrigin(c);
    b.innerHTML = `<span class="glyph" style="color: #AF52DE">${IA_GLYPH}</span><span class="lbl">${esc(c.title)}</span>`;
    b.onclick = () => {
      switchView("ia");
      if (IA.open !== c.id) iaOpen(c.id);
    };
    b.oncontextmenu = (e) => iaMenu(c.id, e.clientX, e.clientY);
    box.appendChild(b);
  }
  sideSync();
}

function iaRender() {
  iaRenderSide();
  const detail = !!IA.open;
  $("ia-engine-tag").classList.toggle("hidden", detail);
  $("ia-new").classList.toggle("hidden", detail);
  $("ia-dacts").classList.toggle("hidden", !detail);
  $("ia-views").classList.toggle("hidden", !detail);
  $("ia-back").classList.toggle("hidden", !detail);
  if (!detail) $("ia-engine-tag").textContent = iaEngineLabel();
  iaApplyAi();
  sideCount("ia", IA.list.length);
  const c = detail && IA.list.find((x) => x.id === IA.open);
  if (c) tbSet("ia", c.title, `${iaOrigin(c)} · ${iaEngineName(c)}`);
  else tbSet("ia", tr("nav.create"), IA.list.length ? tr("ia.count", { n: IA.list.length }) : "");
  $("ia-detail").classList.toggle("hidden", !detail);
  $("ia-empty").classList.toggle("hidden", detail || IA.list.length > 0);
  $("ia-listbar").classList.toggle("hidden", detail || IA.list.length === 0);
  if (detail) {
    $("ia-list").classList.add("hidden");
    $("ia-nomatch").classList.add("hidden");
    iaDetailState();
    return;
  }
  iaRenderList();
}

function iaCard(c) {
  // A created object has nothing to show before Claude's first export.
  const thumb = c.version
    ? `<img class="ia-thumb" src="${esc(iaThumb(c))}" alt="" loading="lazy" decoding="async" />`
    : `<div class="ia-thumb blank">${IA_GLYPH}</div>`;
  const when = new Date(c.updated_at * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
  const pin = IA.pinned.has(c.id) ? ` · ${esc(tr("ia.pinned"))}` : "";
  return `<article class="ia-card${c.id === IA.sel ? " sel" : ""}" data-id="${esc(c.id)}" role="option" aria-selected="${c.id === IA.sel}" tabindex="-1">
    ${thumb}
    <div class="ia-body">
      <h3>${esc(c.title)}</h3>
      <div class="ia-sub">${esc(iaOrigin(c))}</div>
      <div class="ia-meta"><span title="${esc(when)}">${esc(fmtAgo(c.updated_at))}</span> · ${c.version ? `v${c.version}` : esc(tr("ia.draft"))} · ${esc(iaEngineName(c))}${pin}</div>
      ${iaBadge(c)}
    </div>
    <button class="ia-del" data-act="ask" data-id="${esc(c.id)}" title="${esc(tr("common.delete"))}" aria-label="${esc(tr("common.delete"))}">✕</button>
  </article>`;
}

function iaRenderList() {
  // A title being typed must not vanish under a refresh.
  if (IA.renaming) return;
  const box = $("ia-list");
  const groups = iaGroups();
  const shown = groups.flatMap((g) => g.items);
  if (IA.sel && !shown.some((c) => c.id === IA.sel)) IA.sel = null;
  const none = IA.list.length > 0 && shown.length === 0;
  box.classList.toggle("hidden", IA.list.length === 0 || none);
  $("ia-nomatch").classList.toggle("hidden", !none);
  const titled = groups.length > 1 || (groups[0] && groups[0].key && groups[0].key !== "today");
  box.innerHTML = groups
    .map((g) => (titled && g.key ? `<h4 class="ia-group" role="presentation">${esc(tr(IA_GROUP_LABEL[g.key]))}</h4>` : "") + g.items.map(iaCard).join(""))
    .join("");
  const n = IA.list.length;
  tbSet("ia", tr("nav.create"), n ? (shown.length < n ? tr("ia.count_shown", { shown: shown.length, n }) : tr("ia.count", { n })) : "");
}

/* ------------------------------------------------------------ list controls */

function iaSyncListbar() {
  $("ia-q").value = IA.q;
  $("ia-f-kind").value = IA.filters.kind;
  $("ia-f-state").value = IA.filters.state;
  $("ia-f-engine").value = IA.filters.engine;
  $("ia-sort").value = IA.sort;
  iaSyncFilters();
}

/* The Filters button: how many narrow the list; the Sort button: the order. */
function iaSyncFilters() {
  const n = segActive(IA.filters);
  $("ia-fcount").textContent = n ? fmtNum(n) : "";
  $("ia-fcount").classList.toggle("hidden", !n);
  $("ia-filters").classList.toggle("on", n > 0);
  const order = $("ia-sort").selectedOptions[0]?.text || "";
  $("ia-sort-t").textContent = order;
  $("ia-sort-btn").setAttribute("aria-label", `${tr("ia.list.sort")}: ${order}`);
}

/* The filters as pills, in a popover under their button. */
for (const id of ["ia-f-kind", "ia-f-state", "ia-f-engine"]) segmented(id, { cls: "compact" });
function iaFiltersOpen(on) {
  $("ia-fpop").classList.toggle("hidden", !on);
  $("ia-filters").setAttribute("aria-expanded", String(on));
  if (on) requestAnimationFrame(() => $("ia-fpop").querySelector('.seg-btn[tabindex="0"]')?.focus());
}
$("ia-filters").addEventListener("click", () => iaFiltersOpen($("ia-fpop").classList.contains("hidden")));
$("ia-fpop").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  iaFiltersOpen(false);
  $("ia-filters").focus();
});
document.addEventListener("mousedown", (e) => {
  if (!$("ia-fpop").classList.contains("hidden") && !e.target.closest(".ia-fwrap")) iaFiltersOpen(false);
});
// Tab out of it: it closes behind.
$("ia-fpop").addEventListener("focusout", (e) => {
  if (e.relatedTarget && !e.relatedTarget.closest(".ia-fwrap")) iaFiltersOpen(false);
});

/* The order: a native menu, checked, as the Files sort. */
$("ia-sort-btn").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, [...$("ia-sort").options].map((o) => ({ id: "iasort:" + o.value, label: o.text, checked: o.value === IA.sort })))
);
onMenu("iasort", (v) => setSelect("ia-sort", v));
iaSyncListbar();

$("ia-q").addEventListener("input", (e) => {
  IA.q = e.target.value;
  iaRenderList();
});
$("ia-q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (IA.q) {
      IA.q = "";
      e.target.value = "";
      iaRenderList();
    } else {
      e.target.blur();
      $("ia-list").focus();
    }
  } else if (e.key === "ArrowDown" || e.key === "Enter") {
    // From the search, straight into the results.
    e.preventDefault();
    $("ia-list").focus();
    iaKey(e.key === "Enter" && IA.sel ? "Enter" : "ArrowDown");
  }
});
for (const [id, key] of [["ia-f-kind", "kind"], ["ia-f-state", "state"], ["ia-f-engine", "engine"]]) {
  $(id).addEventListener("change", (e) => {
    IA.filters[key] = e.target.value;
    localStorage.setItem("snapstudio.ia.filters", JSON.stringify(IA.filters));
    iaSyncFilters();
    iaRenderList();
  });
}
$("ia-sort").addEventListener("change", (e) => {
  IA.sort = e.target.value;
  localStorage.setItem("snapstudio.ia.sort", IA.sort);
  iaSyncFilters();
  iaRenderList();
});
$("ia-clearq").addEventListener("click", () => {
  IA.q = "";
  IA.filters = { kind: "all", state: "all", engine: "all" };
  localStorage.setItem("snapstudio.ia.filters", JSON.stringify(IA.filters));
  iaSyncListbar();
  iaRenderList();
  $("ia-q").focus();
});

/* Selection, moved with the keyboard. */
function iaSelect(id, scroll = true) {
  IA.sel = id;
  for (const el of $("ia-list").querySelectorAll(".ia-card")) {
    const on = el.dataset.id === id;
    el.classList.toggle("sel", on);
    el.setAttribute("aria-selected", on);
    if (on && scroll) el.scrollIntoView({ block: "nearest" });
  }
}

function iaKey(key) {
  const ids = [...$("ia-list").querySelectorAll(".ia-card")].map((el) => el.dataset.id);
  if (key === "Enter") {
    if (IA.sel) iaOpen(IA.sel);
    return true;
  }
  const i = iaMove(ids.indexOf(IA.sel), ids.length, key);
  if (i < 0) return false;
  iaSelect(ids[i]);
  return true;
}

/* On the list: ↑/↓ Home End move, Enter opens, ⌫/Delete deletes (after
   confirming), F2 renames, ⌘F/Ctrl+F searches. Fields keep their keys. */
document.addEventListener("keydown", (e) => {
  if ($("view-ia").classList.contains("hidden") || IA.open || IA.renaming) return;
  if (document.querySelector(".modal:not(.hidden)")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && IA.list.length) {
    e.preventDefault();
    $("ia-q").focus();
    $("ia-q").select();
    return;
  }
  // Only from the list itself (or nowhere): fields and buttons keep their keys.
  const at = document.activeElement;
  if (at && at !== document.body && !$("ia-list").contains(at)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(e.key)) {
    if (iaKey(e.key)) e.preventDefault();
  } else if ((e.key === "Backspace" || e.key === "Delete") && IA.sel) {
    e.preventDefault();
    iaAskDelete(IA.sel);
  } else if (e.key === "F2" && IA.sel) {
    e.preventDefault();
    iaRenameStart(IA.sel);
  } else if (e.key === "Escape" && IA.q) {
    IA.q = "";
    $("ia-q").value = "";
    iaRenderList();
  }
});

/* ------------------------------------------------------------ rename */

/* The title turns into a field in place: Enter or leaving keeps it, Esc
   gives up. An empty title keeps the old one. */
function iaRenameStart(id) {
  const c = IA.list.find((x) => x.id === id);
  if (!c) return;
  const card = $("ia-list").querySelector(`.ia-card[data-id="${CSS.escape(id)}"]`);
  const h3 = card?.querySelector("h3");
  if (!h3) {
    // Filtered out of view: clear the search so it can be edited.
    if (IA.q || Object.values(IA.filters).some((v) => v !== "all")) {
      $("ia-clearq").click();
      return iaRenameStart(id);
    }
    return;
  }
  IA.renaming = id;
  iaSelect(id, true);
  const input = document.createElement("input");
  input.className = "ia-rename";
  input.value = c.title;
  input.maxLength = 120;
  input.setAttribute("aria-label", tr("ia.rename.label"));
  h3.classList.add("editing");
  h3.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    const title = iaCleanTitle(input.value);
    IA.renaming = null;
    if (keep && title && title !== c.title) {
      try {
        const next = await invoke("ia_rename", { id, title });
        Object.assign(c, next);
        toast(tr("ia.rename.done", { title: next.title }));
      } catch (e) {
        toast(String(e), true);
      }
    }
    iaRender();
    $("ia-list").focus();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

/* ------------------------------------------------------------ creation */

/* The sheet serves both paths: only the labels, the ideas and the
   creation fields change. A large field to describe, ideas that fill it,
   then the options as controls rather than lists. */
const IA_IDEAS = {
  create: ["ia.new.idea.c1", "ia.new.idea.c2", "ia.new.idea.c3"],
  edit: ["ia.new.idea.e1", "ia.new.idea.e2", "ia.new.idea.e3"],
};
const IA_ENGINE_ICON = {
  container: '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 1 5 5v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5m0 2a3 3 0 0 0-3 3v2h6V7a3 3 0 0 0-3-3"/></svg>',
  local: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h3v2H7v-2h3v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1m1 2v8h14V7z"/></svg>',
};
const IA_NEW_MODEL_KEY = "snapstudio.ia.newModel";

function iaSheetTexts() {
  const create = IA.mode === "create";
  $("ia-mtitle").textContent = tr(create ? "ia.new_object" : "ia.new.title");
  $("ia-prompt").placeholder = tr(create ? "ia.new.describe" : "ia.new.what");
  $("ia-prompt").setAttribute("aria-label", tr(create ? "ia.new.describe" : "ia.new.what"));
  $("ia-kbd").textContent = (IS_MAC ? "⌘↩ " : "Ctrl+↩ ") + tr("ia.new.start");
  $("ia-ideas").innerHTML = IA_IDEAS[create ? "create" : "edit"]
    .map((k) => `<button type="button" class="ia-idea" data-idea="${esc(tr(k))}">${esc(tr(k))}</button>`)
    .join("");
  iaRenderEngines();
  iaRenderModels();
  iaRenderDest();
}

/* Where the conversation runs: one card per mode; a mode not chosen or not
   ready is shown off, with why. */
function iaRenderEngines() {
  const ready = iaModes();
  const cur = ready.includes(IA.engine) ? IA.engine : ready[0] || "";
  IA.engine = cur;
  // The Sandbox card runs in the chosen sandbox (built-in or yolobox).
  $("ia-engines").innerHTML = [aiSandboxEngine(aiSandbox()), "local"]
    .map((m) => {
      const on = m === cur, ok = ready.includes(m);
      const sub = ok
        ? tr(m === "local" ? "ia.new.run_local" : "ia.new.run_container")
        : !aiWanted().includes(m)
          ? tr("ia.new.run_off")
          : AIS.report
            ? tr("ia.new.run_missing")
            : tr("ais.checking");
      return `<button type="button" class="ia-engine${on ? " on" : ""}" data-engine="${m}" role="radio" aria-checked="${on}"${ok ? "" : " disabled"}>
        <span class="ia-engine-icon">${IA_ENGINE_ICON[aiSide(m)]}</span>
        <span class="ia-engine-text"><b>${esc(tr("ais.mode." + m))}</b><small>${esc(sub)}</small></span>
      </button>`;
    })
    .join("");
}

/* The Claude model of the new conversation: the account's default or one
   of those the chat offers; the last choice comes back. */
function iaRenderModels() {
  const list = [["", tr("chat.model.default")], ...(typeof CHAT_MODELS !== "undefined" ? CHAT_MODELS : [])];
  if (!list.some(([m]) => m === IA.newModel)) IA.newModel = "";
  $("ia-models").innerHTML = list
    .map(([m, name]) => `<button type="button" class="${m === IA.newModel ? "on" : ""}" data-model="${esc(m)}" role="radio" aria-checked="${m === IA.newModel}">${esc(name)}</button>`)
    .join("");
}

/* The text area grows with what is typed, up to its maximum height. */
function iaPromptFit() {
  const t = $("ia-prompt");
  t.style.height = "auto";
  t.style.height = t.scrollHeight + 2 + "px";
}

function iaSheet(mode) {
  IA.mode = mode;
  IA.newModel = iaLs(IA_NEW_MODEL_KEY) || "";
  const create = mode === "create";
  $("ia-cfields").classList.toggle("hidden", !create);
  $("ia-new-icon").innerHTML = IA_GLYPH;
  $("ia-prompt").value = "";
  IA.attach = [];
  $("ia-from-model").checked = true;
  iaRenderAttach();
  $("ia-msg").textContent = "";
  $("ia-msg").className = "pf-test";
  iaSheetTexts();
  openSheet($("iamodal"));
  iaPromptFit();
  $("ia-prompt").focus();
}

/* Called from the Files screen: the file's thumbnail heads the sheet. */
function iaStart(file) {
  if (!file || file.kind === "gcode") return;
  IA.source = file;
  $("ia-src").textContent = file.name;
  const th = $("ia-src-thumb");
  th.classList.add("hidden");
  $("ia-new-icon").classList.add("hidden");
  th.onload = () => th.classList.remove("hidden");
  th.onerror = () => {
    th.classList.add("hidden");
    $("ia-new-icon").classList.remove("hidden");
  };
  th.src = thumbSrc(file.path, 160, 0);
  iaSheet("edit");
}

/* Folders offered to store the object: the one Files shows, then the
   recent ones, and a way to pick another — a native menu on the button. */
function iaFillDest(pick) {
  IA.destDirs = [...new Set([pick, state.dir, ...(state.recents || [])].filter(Boolean))];
  IA.dest = IA.destDirs[0] || "";
  iaRenderDest();
}
function iaRenderDest() {
  $("ia-dest-name").textContent = IA.dest ? baseName(IA.dest) : tr("ia.new.other_folder");
  $("ia-dest").title = IA.dest || "";
}
$("ia-dest").addEventListener("click", () => {
  const r = $("ia-dest").getBoundingClientRect();
  nativeMenu(
    [
      ...(IA.destDirs || []).map((d, i) => ({ id: "iadest:" + i, label: baseName(d), checked: d === IA.dest })),
      {},
      { id: "iadest:other", label: tr("ia.new.other_folder") },
    ],
    r.left,
    r.bottom + 4
  );
});
onMenu("iadest", async (arg) => {
  if (arg === "other") {
    const dir = await invoke("pick_folder");
    if (dir) iaFillDest(dir);
    return;
  }
  const d = IA.destDirs?.[+arg];
  if (d) {
    IA.dest = d;
    iaRenderDest();
  }
});

/* Creation from scratch: the size limit starts from the printer's bed. */
steppersIn($("ia-cfields"));
const iaBed = () => (typeof PR !== "undefined" && PR.bed) || { w: 270, d: 270 };
function iaBedFill() {
  const bed = iaBed();
  $("ia-bx").value = bed.w;
  $("ia-by").value = bed.d;
  $("ia-bz").value = 270;
}
function iaNew() {
  IA.source = null;
  $("ia-src").textContent = "";
  $("ia-src-thumb").classList.add("hidden");
  $("ia-new-icon").classList.remove("hidden");
  iaBedFill();
  iaFillDest();
  iaSheet("create");
}
$("ia-bed-fill").addEventListener("click", iaBedFill);

$("ia-prompt").addEventListener("input", iaPromptFit);

/* Images and models for the initial request, as in the conversation:
   dropped anywhere on the window while the sheet is open (app.js), pasted
   in the request, or chosen. */
function iaRenderAttach() {
  chatRenderThumbs($("ia-attach"), IA.attach, iaRenderAttach);
  // One model in a creation sheet: the conversation may start from it.
  const models = IA.attach.filter((a) => a.kind === "model");
  const one = IA.mode === "create" && models.length === 1;
  $("ia-from-row").classList.toggle("hidden", !one);
  if (one) $("ia-from-sub").textContent = tr("ia.new.from_model_sub", { name: models[0].name });
  // Started from a model, the folder and size of a new object do not apply.
  $("ia-cfields").classList.toggle("hidden", IA.mode !== "create" || !!iaFromModel());
}
/* The model the conversation starts from, when the switch says so. */
function iaFromModel() {
  const models = IA.attach.filter((a) => a.kind === "model");
  return IA.mode === "create" && models.length === 1 && $("ia-from-model").checked ? models[0] : null;
}
$("ia-prompt").addEventListener("paste", (e) => chatPaste(e, () => IA.attach, iaRenderAttach));
$("ia-from-model").addEventListener("change", iaRenderAttach);
$("ia-drop-add").addEventListener("click", async () => {
  const paths = await chatPickFiles();
  if (!paths.length || $("iamodal").classList.contains("hidden")) return;
  await chatAttachPaths(paths, () => IA.attach);
  iaRenderAttach();
});

/* Files dropped on the window (app.js, attach-logic.js attachTarget): to
   the open sheet, or to the conversation shown. */
async function iaDropPaths(target, paths) {
  if (target === "sheet") {
    await chatAttachPaths(paths, () => IA.attach);
    iaRenderAttach();
  } else if (target === "chat") {
    if (IA.locked) {
      toast(tr("chat.drop_locked"), true);
      return;
    }
    // In the terminal view the message field is hidden: files dropped there
    // would wait unseen for the next message. The chat shows them.
    if (IA.view !== "chat") iaSwitchView("chat");
    await chatAttachPaths(paths, () => CHAT.attach);
    chatRenderAttachments();
  }
}
/* While files are dragged over the window: where they would go. */
function iaDropHint(target) {
  $("ia-drop").classList.toggle("over", target === "sheet");
  $("ia-chat").classList.toggle("drop-over", target === "chat" && !IA.locked);
}
$("ia-ideas").addEventListener("click", (e) => {
  const b = e.target.closest("[data-idea]");
  if (!b) return;
  const t = $("ia-prompt");
  t.value = b.dataset.idea;
  iaPromptFit();
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
});
$("ia-engines").addEventListener("click", (e) => {
  const b = e.target.closest("[data-engine]");
  if (!b || b.disabled) return;
  IA.engine = b.dataset.engine;
  iaRenderEngines();
});
$("ia-models").addEventListener("click", (e) => {
  const b = e.target.closest("[data-model]");
  if (!b) return;
  IA.newModel = b.dataset.model;
  localStorage.setItem(IA_NEW_MODEL_KEY, IA.newModel);
  iaRenderModels();
});

/* The size entered, or null when incomplete: then nothing is imposed. */
function iaBounds() {
  const v = ["ia-bx", "ia-by", "ia-bz"].map((k) => parseFloat($(k).value));
  return v.every((x) => x > 0) ? v : null;
}

async function iaCreate() {
  // A file still being checked would be left out of the conversation.
  if (ATTACH_CHECKING) {
    $("ia-msg").textContent = tr("ia.new.checking");
    $("ia-msg").className = "pf-test busy";
    return;
  }
  const create = IA.mode === "create";
  if (!create && !IA.source) return;
  if (!iaModes().includes(IA.engine)) {
    $("ia-msg").textContent = aiBlockedReason() || tr("ia.engine.not_ready");
    $("ia-msg").className = "pf-test err";
    return;
  }
  if (create && !$("ia-prompt").value.trim()) {
    $("ia-msg").textContent = tr("ia.new.need_prompt");
    $("ia-msg").className = "pf-test err";
    $("ia-prompt").focus();
    return;
  }
  const from = iaFromModel();
  if (create && !from && !IA.dest) {
    $("ia-msg").textContent = tr("ia.new.need_dest");
    $("ia-msg").className = "pf-test err";
    return;
  }
  const btn = $("ia-go");
  btn.disabled = true;
  $("ia-msg").textContent = tr("ia.new.preparing");
  $("ia-msg").className = "pf-test busy";
  const model = IA.newModel || null;
  try {
    // Started from the model of the sheet: an edit conversation, its result
    // saved next to that file as for "Edit with AI".
    const c = from
      ? await invoke("ia_create", { source: from.path, prompt: $("ia-prompt").value, engine: IA.engine, model })
      : create
      ? await invoke("ia_create_blank", {
          prompt: $("ia-prompt").value,
          engine: IA.engine,
          dest: IA.dest,
          bounds: iaBounds(),
          model,
        })
      : await invoke("ia_create", {
          source: IA.source.path,
          prompt: $("ia-prompt").value,
          engine: IA.engine,
          model,
        });
    const rest = IA.attach.filter((a) => a !== from);
    if (rest.length) CHAT.firstAttach.set(c.id, rest);
    IA.attach = [];
    closeSheet($("iamodal"));
    await iaRefresh();
    switchView("ia");
    toast(tr("ia.created"));
    iaOpen(c.id);
  } catch (e) {
    $("ia-msg").textContent = String(e);
    $("ia-msg").className = "pf-test err";
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ actions */

/* The confirmation lists what goes: the folder, the Claude session files,
   the running Claude. history.jsonl and saved files are said to stay. */
const IADEL = { id: null };

async function iaAskDelete(id) {
  const c = IA.list.find((x) => x.id === id);
  if (!c) return;
  let plan = { files: 0, running: false };
  try {
    plan = await invoke("ia_delete_plan", { id });
  } catch {}
  IADEL.id = id;
  $("iadel-title").textContent = tr("ia.delete.title", { name: c.title });
  const rows = [];
  if (typeof CHAT !== "undefined" && CHAT.busy.has(id)) rows.push([tr("ia.delete.item_answering"), true]);
  else if (plan.running) rows.push([tr("ia.delete.item_running"), false]);
  rows.push([tr("ia.delete.item_folder"), false]);
  rows.push([plan.files ? tr("ia.delete.item_session", { n: plan.files }) : tr("ia.delete.item_nosession"), false]);
  $("iadel-list").innerHTML = rows.map(([t, warn]) => `<li${warn ? ' class="warn"' : ""}>${esc(t)}</li>`).join("");
  $("iadel-go").disabled = false;
  openSheet($("iadelmodal"));
  // Cancel has the focus: Enter alone must not delete.
  requestAnimationFrame(() => $("iadel-cancel").focus());
}

$("iadel-cancel").addEventListener("click", () => {
  IADEL.id = null;
  closeSheet($("iadelmodal"));
});
$("iadel-go").addEventListener("click", async () => {
  const id = IADEL.id;
  if (!id) return;
  const go = $("iadel-go");
  go.disabled = true;
  $("iadel-cancel").disabled = true;
  // Closing Claude may take a few seconds: say it is under way.
  go.textContent = tr("ia.delete.deleting");
  await iaDelete(id);
  go.textContent = tr("ia.delete.confirm");
  $("iadel-cancel").disabled = false;
  IADEL.id = null;
  closeSheet($("iadelmodal"));
});
$("iadelmodal").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    $("iadel-cancel").click();
  }
});

async function iaDelete(id) {
  try {
    // Leave the screen first: nothing must keep reading the folder.
    if (IA.open === id) iaBack();
    const r = await invoke("ia_delete", { id });
    IA.list = r.list;
    // The terminal was closed on the app side: its emulator has no purpose left.
    const t = IA.terms.get(id);
    if (t) {
      t.term.dispose();
      IA.terms.delete(id);
    }
    if (typeof CHAT !== "undefined") CHAT.busy.delete(id);
    IA.failed.delete(id);
    if (IA.pinned.delete(id)) iaSavePins();
    if (IA.sel === id) IA.sel = null;
    iaRender();
    if (r.kept.length) toast(tr("ia.deleted_kept", { n: r.kept.length }), true);
    else toast(r.removed ? tr("ia.deleted_session", { n: r.removed }) : tr("ia.deleted"));
  } catch (e) {
    toast(String(e), true);
  }
}

const iaSavePins = () => localStorage.setItem("snapstudio.ia.pinned", JSON.stringify([...IA.pinned]));

async function iaDuplicate(id) {
  try {
    const c = await invoke("ia_duplicate", { id });
    IA.list = await invoke("ia_list");
    IA.sel = c.id;
    iaRender();
    toast(tr("ia.duplicated", { title: c.title }));
  } catch (e) {
    toast(String(e), true);
  }
}

/* Same menu on a card and in the sidebar. */
function iaMenu(id, x, y) {
  const c = IA.list.find((v) => v.id === id);
  if (!c) return;
  nativeMenu(
    [
      { id: "ia:open:" + id, label: tr("ia.open_conv") },
      { id: "ia:rename:" + id, label: tr("ia.rename") },
      { id: "ia:duplicate:" + id, label: tr("ia.duplicate") },
      { id: "ia:pin:" + id, label: tr(IA.pinned.has(id) ? "ia.unpin" : "ia.pin") },
      ...(c.version ? [{ id: "ia:save:" + id, label: tr("ia.save") }] : []),
      { id: "ia:folder:" + id, label: tr("ia.show_workspace") },
      {},
      { id: "ia:delete:" + id, label: tr("ia.delete.menu") },
    ],
    x,
    y
  );
}

/* ------------------------------------------------------------ events */

$("ia-list").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (btn) {
    ev.stopPropagation();
    if (btn.dataset.act === "ask") iaAskDelete(btn.dataset.id);
    return;
  }
  const card = ev.target.closest(".ia-card");
  if (!card || IA.renaming) return;
  const c = IA.list.find((x) => x.id === card.dataset.id);
  if (!c) return;
  IA.sel = c.id;
  iaOpen(c.id);
});

$("ia-list").addEventListener("contextmenu", (ev) => {
  const card = ev.target.closest(".ia-card");
  if (!card || IA.renaming) return;
  iaSelect(card.dataset.id, false);
  iaMenu(card.dataset.id, ev.clientX, ev.clientY);
});
onMenu("ia", async (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  if (what === "open") iaOpen(id);
  if (what === "delete") iaAskDelete(id);
  if (what === "rename") {
    // Renaming happens on the list: go there, drawn at once.
    if ($("view-ia").classList.contains("hidden")) switchView("ia");
    if (IA.open) iaBack();
    iaRender();
    iaRenameStart(id);
  }
  if (what === "duplicate") iaDuplicate(id);
  if (what === "pin") {
    IA.pinned.has(id) ? IA.pinned.delete(id) : IA.pinned.add(id);
    iaSavePins();
    if (!IA.open) iaRenderList();
  }
  if (what === "save") {
    try {
      const path = await invoke("ia_save", { id });
      const c = IA.list.find((x) => x.id === id);
      iaMarkSaved(c, path);
      await refresh();
      toast(tr("ia.saved_toast", { name: path.split(/[\\/]/).pop() }));
      if (!IA.open) iaRenderList();
    } catch (e) {
      toast(String(e), true);
    }
  }
  if (what === "folder") {
    const path = await invoke("ia_workspace", { id });
    invoke("reveal", { path }).catch((e) => toast(String(e), true));
  }
});

$("act-ia").addEventListener("click", () => {
  const path = [...state.sel][0];
  iaStart(state.files.find((f) => f.path === path));
});

$("ia-go").addEventListener("click", iaCreate);
$("ia-new").addEventListener("click", iaNew);
$("ia-empty-new").addEventListener("click", iaNew);
$("ia-empty-files").addEventListener("click", () => switchView("files"));
$("ia-cancel").addEventListener("click", () => closeSheet($("iamodal")));

document.addEventListener("keydown", (e) => {
  if ($("iamodal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeSheet($("iamodal"));
  // ⌘⏎ confirms; plain Enter makes a new line in the text area.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); // otherwise ⌘⏎ also goes to "Add to Slicer Plate"
    iaCreate();
  }
});

/* ------------------------------------------------------------ terminal */

/* One emulator per conversation, kept in memory while the app lives.
   Switching tabs or going back to the list must not erase anything: the
   element is detached, not destroyed. */

/* Terminal colors read from the theme's tokens (--term-*), cursor in the
   accent color (AccentColor included: the browser resolves them). */
function iaTheme() {
  return {
    background: cssColor("var(--term-bg)"),
    foreground: cssColor("var(--term-fg)"),
    cursor: cssColor("var(--accent)") || "#007aff",
    selectionBackground: cssColor("var(--term-selection)"),
  };
}

function iaTerm(id) {
  let t = IA.terms.get(id);
  if (t) return t;
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    // Read only: the session is written to from the chat.
    disableStdin: true,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    scrollback: 10000,
    allowProposedApi: true,
    theme: iaTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "ia-term-host";
  t = { term, fit, el, opened: false, ready: false, st: {} };
  IA.terms.set(id, t);
  return t;
}

window.addEventListener("themechange", () => {
  for (const t of IA.terms.values()) t.term.options.theme = iaTheme();
});

/* Fitting depends on the real on-screen size: the element must be visible,
   so after display. */
function iaFit(id) {
  const t = IA.terms.get(id);
  if (!t || !t.opened) return;
  try {
    t.fit.fit();
  } catch {}
}

/* Say ahead what is going to happen, rather than leave the user facing an
   unexpected question or a thread that does not come back. */
async function iaHint(c) {
  const el = $("ia-hint");
  if (IA.locked) {
    el.innerHTML = `${esc(IA.locked)} <button class="w-link" data-ai-settings>${esc(tr("ais.open_settings"))}</button>`;
    el.classList.remove("hidden");
    return;
  }
  if (!c.started) {
    // Only the terminal asks whether to trust the folder; the chat never does.
    if (IA.view === "term") {
      el.innerHTML = tr("ia.hint.first");
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
    return;
  }
  let resumable = true;
  try {
    resumable = await invoke("ia_resumable", { id: c.id });
  } catch {}
  // Another conversation opened meanwhile: its own hint stands.
  if (IA.open !== c.id) return;
  if (resumable) {
    el.classList.add("hidden");
    return;
  }
  el.innerHTML = tr("ia.hint.lost");
  el.classList.remove("hidden");
}

async function iaOpen(id) {
  const c = IA.list.find((x) => x.id === id);
  if (!c) return;
  IA.open = id;
  // A conversation whose mode is not ready (anymore) is only read.
  IA.locked = iaLockFor(c);
  if (IA.locked) IA.view = "chat";
  iaRender();
  $("ia-left").dataset.mode = IA.view;
  document.querySelectorAll("#ia-views [data-iaview]").forEach((b) => b.classList.toggle("on", b.dataset.iaview === IA.view));
  iaHint(c);
  // The 3D pane and the folder watch live with the screen.
  iaQueue(() => iaLoadPane(id));
  // One Claude per conversation, the chat's: the terminal shows it.
  chatOpen(c);
  if (IA.view === "term") iaTraceOpen(c);
}

/* Why a conversation is read-only. */
function iaLockReason(c) {
  if (aiChoice() === "off") return tr("ais.reason.off");
  return tr("ia.locked", { mode: tr("ais.mode." + c.engine) });
}

/* The viewer is unique: it must leave the pane as soon as the tab changes,
   otherwise files opened elsewhere would show in a hidden view — and come
   back to haunt the conversation. */
function iaSetVisible(on) {
  if (!IA.open) return;
  if (on) {
    if (!iaEmpty(IA.list.find((x) => x.id === IA.open))) iaDock();
    iaLoadPane(IA.open);
  } else {
    iaUndock();
  }
}

function iaBack() {
  iaUndock();
  IA.open = null;
  chatLeave();
  // The element goes back in reserve: the terminal history is kept.
  const host = $("ia-term");
  if (host.firstChild) host.removeChild(host.firstChild);
  iaRefresh();
}

/* ------------------------------------------------------------ detail */

$("ia-back").addEventListener("click", iaBack);

/* Red button of the open conversation: same confirmation as in the list. */
$("ia-delete").addEventListener("click", () => {
  if (IA.open) iaAskDelete(IA.open);
});

/* Terminal view: the same Stop as the chat's, shown while Claude answers. */
$("ia-term-stop").addEventListener("click", () => chatStop());

$("ia-folder").addEventListener("click", async () => {
  if (!IA.open) return;
  const path = await invoke("ia_workspace", { id: IA.open });
  invoke("reveal", { path }).catch((e) => toast(String(e), true));
});

/* ------------------------------------------------------------ splitter */

/* Share of the width between the preview and the conversation column on
   the right, kept for all conversations as a ratio, so that it follows the
   window: half and half by default, each side keeping the stylesheet's
   minimum. Dragged with the mouse, moved with ←/→ (the bar follows the
   arrow; Shift: bigger steps), reset to half and half by a double-click,
   Home or Enter. The pixel widths of earlier builds are dropped: everyone
   starts from half and half. */
const IA_CHAT_KEY = "snapstudio.ia.chatRatio";
const IA_CHAT_DEFAULT = 0.5;
["snapstudio.ia.chat", "snapstudio.ia.chatw", "snapstudio.ia.split"].forEach((k) => localStorage.removeItem(k));
const iaMinW = (el, fallback) => parseFloat(getComputedStyle(el).minWidth) || fallback;
/* Width shared by the two sides: the split less the splitter and its
   (negative) margins. */
const iaSplitW = () => {
  const bar = $("ia-splitter");
  const cs = getComputedStyle(bar);
  const used = bar.offsetWidth + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
  return Math.max(0, $("ia-left").parentElement.clientWidth - used);
};
const iaChatMin = () => iaMinW($("ia-left"), 300);
const iaChatMax = () => Math.max(iaChatMin(), iaSplitW() - iaMinW($("ia-center"), 360));
const iaRatioOk = (r) => (Number.isFinite(r) && r > 0 && r < 1 ? r : IA_CHAT_DEFAULT);
/* Lays out a ratio and returns the ratio laid out (clamped by the minimums). */
function iaChatApply(r, save = true) {
  // Dragged past an edge: the edge (the minimums do the rest).
  r = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : IA_CHAT_DEFAULT;
  const total = iaSplitW();
  // Hidden (another tab): nothing to measure; the ratio waits.
  if (!total) {
    $("ia-left").style.setProperty("--ia-chat-w", `${r * 100}%`);
    return r;
  }
  const w = Math.round(Math.min(iaChatMax(), Math.max(iaChatMin(), r * total)));
  $("ia-left").style.setProperty("--ia-chat-w", `${w}px`);
  const bar = $("ia-splitter");
  const pc = (x) => Math.round((x / total) * 100);
  bar.setAttribute("aria-valuenow", pc(w));
  bar.setAttribute("aria-valuemin", pc(iaChatMin()));
  bar.setAttribute("aria-valuemax", pc(iaChatMax()));
  bar.setAttribute("aria-valuetext", `${pc(w)} %`);
  // Not clamped: the ratio asked (0.5 stays 0.5, not its rounded pixels).
  const laid = Math.abs(w - r * total) < 1 ? r : w / total;
  if (save) localStorage.setItem(IA_CHAT_KEY, laid.toFixed(4));
  return laid;
}
/* The user's choice is kept apart from what fits: a narrow window clamps
   the column without forgetting it. */
let iaChatWanted = iaRatioOk(parseFloat(iaLs(IA_CHAT_KEY)));
let iaChatR = iaChatApply(iaChatWanted, false);
const iaChatSet = (r) => {
  iaChatR = iaChatApply(r);
  iaChatWanted = iaChatR;
};
/* A step in pixels, as a ratio of the width shared. */
const iaChatStep = (px) => iaChatR + px / (iaSplitW() || 1);

$("ia-splitter").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const bar = e.currentTarget;
  const split = $("ia-left").parentElement;
  const right = $("ia-left").getBoundingClientRect().right;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add("drag");
  split.classList.add("dragging");
  const move = (ev) => (iaChatR = iaChatApply((right - ev.clientX) / (iaSplitW() || 1), false));
  const up = () => {
    bar.removeEventListener("pointermove", move);
    bar.classList.remove("drag");
    split.classList.remove("dragging");
    iaChatSet(iaChatR);
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", up, { once: true });
  bar.addEventListener("pointercancel", up, { once: true });
});
$("ia-splitter").addEventListener("dblclick", () => iaChatSet(IA_CHAT_DEFAULT));
$("ia-splitter").addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 64 : 16;
  if (e.key === "ArrowLeft") iaChatSet(iaChatStep(step));
  else if (e.key === "ArrowRight") iaChatSet(iaChatStep(-step));
  else if (e.key === "Home" || e.key === "Enter") iaChatSet(IA_CHAT_DEFAULT);
  else return;
  e.preventDefault();
});
/* The window (or the app's sidebar) changes: the same share, refitted. */
new ResizeObserver(() => (iaChatR = iaChatApply(iaChatWanted, false))).observe($("ia-left").parentElement);

const iaResizeObserver = new ResizeObserver(() => {
  if (IA.open) iaFit(IA.open);
});
iaResizeObserver.observe($("ia-term"));

/* ------------------------------------------------------------ 3D pane */

/* The viewer is not duplicated: the app's own is moved into the pane. Same
   graphics context, same code, no possible divergence. */

/* The bed under the object in the AI preview: hidden by default (the
   object alone, framed closer), the choice kept. The viewer is shared with
   Files and Prepare: their own setting comes back when it leaves. */
const IA_BED_KEY = "snapstudio.ia.bed";
IA.bed = iaLs(IA_BED_KEY) === "1";
IA.viewerOwned = false;
function iaBedApply() {
  $("ia-bed").checked = IA.bed;
  $("ia-bed-sw").title = tr(IA.bed ? "ia.bed.hide" : "ia.bed.show");
  if (!IA.viewerOwned) return;
  V.showPlate = IA.bed;
  V.frameWithBed = true;
  $("v-plate").checked = V.showPlate;
}
function iaBedSet(on) {
  IA.bed = on;
  localStorage.setItem(IA_BED_KEY, on ? "1" : "0");
  iaBedApply();
  if (typeof frameCamera !== "function" || !IA.viewerOwned) return;
  if (V.framed) frameCamera();
  else draw();
}
$("ia-bed").addEventListener("change", () => iaBedSet($("ia-bed").checked));
// Enlarged, the viewer's own Plate switch is the same switch.
$("v-plate").addEventListener("change", () => {
  if (IA.viewerOwned && V.showPlate !== IA.bed) iaBedSet(V.showPlate);
});
iaBedApply();

/* The framing keeps clear of the floating controls: their bottom edge, and
   as much again below it. */
function iaInsetTop() {
  const t = $("ia-ptools");
  V.insetTop = t.offsetHeight ? t.offsetTop + t.offsetHeight + 8 : 0;
}

function iaDock() {
  const v = $("viewer");
  iaInsetTop();
  if (!IA.viewerOwned) {
    IA.prevPlate = V.showPlate;
    IA.viewerOwned = true;
  }
  iaBedApply();
  if (v.parentElement !== $("ia-stage")) {
    $("ia-stage").appendChild(v);
    v.classList.add("docked");
  }
  v.classList.remove("hidden");
}

function iaUndock(hide = true) {
  const v = $("viewer");
  v.classList.remove("docked");
  if (hide) {
    v.classList.add("hidden");
    V.onClose = null;
    if (IA.viewerOwned) {
      V.showPlate = IA.prevPlate;
      V.frameWithBed = false;
      $("v-plate").checked = V.showPlate;
      IA.viewerOwned = false;
    }
  }
  if (v.parentElement !== document.body) document.body.appendChild(v);
}

/* The pane is narrow: the part must be examinable full size, as from the
   Files screen. The viewer leaves its frame without reloading anything, and
   Close — or Esc — puts it back. */
function iaExpand() {
  if (!IA.open || $("viewer").classList.contains("hidden")) return;
  iaUndock(false);
  if (typeof draw === "function") draw();
  V.onClose = () => {
    iaDock();
    if (typeof draw === "function") draw();
  };
}

/* Icons of the measurement chips: the icon stands for the label, which
   stays in the tooltip and in the "All details" popover. */
const IA_STAT_ICON = {
  size: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H7.4l3.8 3.8-1.4 1.4L6 7.4V10H4zm16 16h-6v-2h2.6l-3.8-3.8 1.4-1.4 3.8 3.8V14h2z"/></svg>',
  mass: '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 2.83 4H18a1 1 0 0 1 .97.76l2.5 10A1 1 0 0 1 20.5 19h-17a1 1 0 0 1-.97-1.24l2.5-10A1 1 0 0 1 6 7h3.17A3 3 0 0 1 12 3m0 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/></svg>',
  watertight: '<svg viewBox="0 0 24 24"><path d="M12 2.7S5.5 9.9 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 9.9 12 2.7 12 2.7"/></svg>',
  faces: '<svg viewBox="0 0 24 24"><path d="M12 2.5 21.5 19h-19zm0 4L6 17h5.2zm1.6 0 .4 10.5h5.6z"/></svg>',
};

/* Estimated mass: PLA weighs 1.24 g per cubic centimeter. Without a closed
   mesh the volume means nothing, so we abstain. */
function iaRenderStats(s) {
  IA.stats = s;
  // [icon, label, full value, chip value, warn]: the chip says it short
  // ("90 × 40 × 25 mm", "≈ 39 g"), the popover and the tooltip in full.
  const short = (x) => fmtNum(x, { maximumFractionDigits: 1 });
  const rows = [["size", tr("ia.stats.size"), s.size.map((x) => fmtDec(x, 1)).join(" × ") + " mm", s.size.map(short).join("\u202f×\u202f") + "\u00a0mm"]];
  if (s.watertight === true) {
    const g = Math.round(s.volume_cm3 * 1.24);
    rows.push(["mass", tr("ia.stats.mass"), tr("ia.stats.mass_v", { g }), tr("ia.stats.mass_short", { g })]);
  }
  rows.push([
    "watertight",
    tr("ia.stats.watertight"),
    tr(s.watertight === null ? "ia.stats.unchecked" : s.watertight ? "common.yes" : "common.no"),
    tr(s.watertight === null ? "ia.stats.watertight_unchecked" : s.watertight ? "ia.stats.watertight_yes" : "ia.stats.watertight_no"),
    s.watertight === false,
  ]);
  rows.push(["faces", tr("ia.stats.faces"), fmtNum(s.triangles), tr("ia.stats.faces_short", { n: s.triangles, count: fmtNum(s.triangles) })]);
  IA.statRows = rows;
  $("ia-stats").innerHTML = rows
    .map(
      ([icon, k, v, chip, warn]) =>
        `<span class="ia-chip${warn ? " warn" : ""}" title="${esc(k)} : ${esc(v)}">${IA_STAT_ICON[icon]}<span class="v">${esc(chip)}</span></span>`
    )
    .join("");
  iaFitDock();
}

/* The toolbar under the preview stays on one line: when it runs out of
   room, the chips go one by one (last first) behind "…". Only when even
   that does not fit do the buttons take a second line, which frees the
   first one again for as many chips as fit. */
function iaFitDock() {
  const dock = $("ia-dock");
  if (!dock) return;
  // An empty zone folds away. Not with `:has(:empty)` in the CSS: WebKit
  // does not always restyle it when the zone fills, and the versions stayed
  // hidden until something else (Terminal and back) restyled the bar.
  for (const id of ["ia-versions", "ia-stats"]) $(id).parentElement.classList.toggle("empty", !$(id).childElementCount);
  if (!dock.offsetWidth) return;
  const stats = $("ia-stats");
  const chips = [...stats.children];
  const more = $("ia-more");
  const canMore = !!(IA.statRows && IA.statRows.length);
  const zone = stats.parentElement;
  const tight = (el) => el.scrollWidth > el.clientWidth + 0.5;
  const over = () => tight(dock) || tight(zone) || tight(stats);
  const fitChips = () => {
    dock.classList.remove("fit-none");
    chips.forEach((c) => c.classList.remove("off"));
    more.classList.add("hidden");
    for (let i = chips.length - 1; i >= 0 && over(); i--) {
      chips[i].classList.add("off");
      if (canMore) more.classList.remove("hidden");
    }
    if (chips.length && chips.every((c) => c.classList.contains("off"))) dock.classList.add("fit-none");
  };
  dock.classList.remove("fit-wrap");
  fitChips();
  if (over()) {
    dock.classList.add("fit-wrap");
    fitChips();
  }
  if (!$("ia-pop").classList.contains("hidden")) iaFillPop();
}

/* "All details": every measurement in full. */
function iaFillPop() {
  const rows = (IA.statRows || []).map((r) => [r[1], r[2]]);
  $("ia-pop").innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}
function iaPop(open) {
  const pop = $("ia-pop");
  if (open) iaFillPop();
  pop.classList.toggle("hidden", !open);
  $("ia-more").setAttribute("aria-expanded", String(open));
  $("ia-more").classList.toggle("on", open);
}
$("ia-more").addEventListener("click", (e) => {
  e.stopPropagation();
  iaPop($("ia-pop").classList.contains("hidden"));
});
document.addEventListener("mousedown", (e) => {
  if (!$("ia-pop").classList.contains("hidden") && !e.target.closest("#ia-pop, #ia-more")) iaPop(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("ia-pop").classList.contains("hidden")) {
    // Taken here: the same Esc must not also stop Claude (ia-chat.js).
    e.preventDefault();
    iaPop(false);
    $("ia-more").focus();
  }
});
let iaDockW = 0;
new ResizeObserver(() => {
  const w = $("ia-dock").clientWidth;
  if (w === iaDockW) return;
  iaDockW = w;
  iaFitDock();
}).observe($("ia-dock"));

async function iaRenderVersions(id, current) {
  let list = [];
  try {
    list = await invoke("ia_versions", { id });
  } catch {}
  // Up to six versions: a segmented control; beyond, a menu, newest first.
  const box = $("ia-versions");
  if (!list.length) {
    box.innerHTML = "";
  } else if (list.length <= 6) {
    box.innerHTML = `<div class="seg">${list
      .map(
        (v) =>
          `<button class="seg-btn ia-ver${v.n === current ? " on" : ""}" data-v="${v.n}" aria-pressed="${v.n === current}"
            title="${esc(tr(v.n === 1 ? "ia.version.first" : "ia.version.revert"))}">v${v.n}</button>`
      )
      .join("")}</div>`;
  } else {
    box.innerHTML = `<select class="ia-vsel" aria-label="${esc(tr("ia.versions"))}" title="${esc(tr("ia.version.revert"))}">${[...list]
      .reverse()
      .map((v) => `<option value="${v.n}"${v.n === current ? " selected" : ""} title="${esc(tr(v.n === 1 ? "ia.version.first" : "ia.version.revert"))}">v${v.n}</option>`)
      .join("")}</select>`;
  }
  iaFitDock();
}

/* An object created from scratch has nothing to show before its first
   export: the pane says so, and nothing can be saved or sliced yet. */
function iaWaiting(on) {
  $("ia-wait").classList.toggle("hidden", !on);
  $("ia-save").disabled = on;
  $("ia-slice").disabled = on;
  if (on) iaUndock();
  iaDetailState();
}

/* Reloads the object shown. The stamp busts the cache: the address never
   changes, and the old mesh would be served again. */
async function iaShowCurrent(id) {
  const c = IA.list.find((x) => x.id === id);
  if (iaEmpty(c)) {
    iaWaiting(true);
    return;
  }
  iaWaiting(false);
  try {
    const { path, stamp } = await invoke("ia_current", { id });
    iaDock();
    await openViewer(path, c ? c.title : "", "3mf", stamp);
  } catch (e) {
    IA.statRows = [];
    $("ia-stats").innerHTML = `<span class="ia-chip warn" title="${esc(tr("ia.stats.object"))} : ${esc(String(e))}"><span class="v">${esc(String(e))}</span></span>`;
    iaFitDock();
  }
}

/* Pane loads are chained: two close writes by Claude would otherwise start
   two reads where the older may finish last, and the object shown would no
   longer match the measurements beside it. */
let iaChain = Promise.resolve();
const iaQueue = (fn) => (iaChain = iaChain.then(fn).catch(() => {}));

async function iaLoadPane(id) {
  let version = 0;
  try {
    const c = await invoke("ia_get", { id });
    version = c.version;
    const known = IA.list.find((x) => x.id === id);
    if (known) Object.assign(known, { version, saved: c.saved, saved_versions: c.saved_versions });
  } catch {}
  await iaShowCurrent(id);
  await iaRenderVersions(id, version);
  iaDetailState();
  try {
    iaRenderStats(await invoke("ia_stats", { id }));
  } catch {
    IA.statRows = [];
    $("ia-stats").innerHTML = "";
    iaFitDock();
  }
}

/* End of a turn of the conversation shown: the pane is read again from
   disk — object, versions, measurements. A sandbox (re)starting or a write
   caught half-way could leave the details bar empty until then. */
listen("ia-chat", (e) => {
  const { id, events } = e.payload;
  if (id !== IA.open || !events.some((ev) => ev.type === "result" || ev.type === "exited")) return;
  iaQueue(() => (IA.open === id ? iaLoadPane(id) : null));
});

/* Claude just wrote: the object changes before the user's eyes. */
listen("ia-mesh", async (e) => {
  const { id, version, stats } = e.payload;
  const c = IA.list.find((x) => x.id === id);
  if (c) c.version = version;
  if (IA.open !== id) return;
  // A new version is not saved yet: the Save button says so.
  iaDetailState();
  iaQueue(async () => {
    await iaShowCurrent(id);
    await iaRenderVersions(id, version);
    iaRenderStats(stats);
  });
});

/* Chat or terminal: two views of the same session. Nothing is closed or
   started; the terminal reads what the chat's Claude does. */
function iaSwitchView(view) {
  if (view === IA.view) return;
  IA.view = view;
  localStorage.setItem("snapstudio.iaview", view);
  const c = IA.open && IA.list.find((x) => x.id === IA.open);
  if (!c) return;
  $("ia-left").dataset.mode = view;
  document.querySelectorAll("#ia-views [data-iaview]").forEach((b) => b.classList.toggle("on", b.dataset.iaview === view));
  if (view === "term") iaTraceOpen(c);
  else requestAnimationFrame(() => $("chat-input").focus());
}

$("ia-views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-iaview]");
  if (b) iaSwitchView(b.dataset.iaview);
});

/* Makes version `n` the current state again. */
async function iaShowVersion(id, n) {
  try {
    await invoke("ia_revert", { id, n });
    await iaQueue(() => iaLoadPane(id));
  } catch (e) {
    toast(String(e), true);
  }
}

$("ia-versions").addEventListener("change", (ev) => {
  if (ev.target.matches(".ia-vsel") && IA.open) iaShowVersion(IA.open, +ev.target.value);
});
$("ia-versions").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-v]");
  if (btn && IA.open) iaShowVersion(IA.open, +btn.dataset.v);
});

/* The preview's size changes (splitter, window, toolbar wrapping): the
   framing follows as long as the user has not moved the camera; otherwise
   only the picture is redrawn at the new aspect. */
const iaStageObserver = new ResizeObserver(() => {
  if (!IA.open || typeof draw !== "function") return;
  iaInsetTop();
  if (V.framed && typeof frameCamera === "function") frameCamera();
  else draw();
});
iaStageObserver.observe($("ia-stage"));

/* ------------------------------------------------------------ output */

/* Saves the current state into your files and returns its path. The 3MF
   joins the original object's folder (or the chosen one), under a free name. */
/* Notes the file Save wrote for the version shown. */
function iaMarkSaved(c, path) {
  if (!c) return;
  c.saved = path;
  c.saved_versions = { ...(c.saved_versions || {}), [c.version]: path };
}

/* Save writes the version shown as 3MF into your files, once: the backend
   hands back the file already written for it while that file exists. */
async function iaSave(then) {
  if (!IA.open) return;
  const c = IA.list.find((x) => x.id === IA.open);
  const before = iaSavedPath(c);
  const btns = [$("ia-save"), $("ia-slice")];
  btns.forEach((b) => (b.disabled = true));
  try {
    const path = await invoke("ia_save", { id: IA.open });
    iaMarkSaved(c, path);
    if (path !== before) {
      await refresh();
      toast(tr("ia.saved_toast", { name: path.split(/[\\/]/).pop() }));
    }
    if (then) await then(path);
  } catch (e) {
    toast(String(e), true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
    iaDetailState();
  }
}

/* Saved already: the button shows the file in the Finder rather than
   write the same version twice. If the file has gone, it is written again. */
$("ia-save").addEventListener("click", async () => {
  const path = iaSavedPath(IA.open && IA.list.find((x) => x.id === IA.open));
  if (!path) return iaSave();
  try {
    await invoke("reveal", { path });
  } catch {
    await iaSave();
  }
});

/* Slice goes on to the plate, the freshly written file being a file like
   any other — even stored outside the folder shown, as a created object may
   be. */
$("ia-slice").addEventListener("click", () =>
  iaSave(async (path) => {
    iaBack();
    await prepareModels([path]);
  })
);

$("ia-reframe").addEventListener("click", () => {
  // Bed shown: the bed and the object; hidden: the object alone.
  if (typeof frameCamera === "function") frameCamera();
});

$("ia-expand").addEventListener("click", iaExpand);
$("ia-stage").addEventListener("dblclick", (e) => {
  // A quick double click on a control is not a request to enlarge.
  if (!e.target.closest("#ia-ptools")) iaExpand();
});

window.addEventListener("langchange", () => {
  iaRender();
  iaBedApply();
  iaSyncFilters();
  if (IA.open) {
    const c = IA.list.find((x) => x.id === IA.open);
    if (c) iaHint(c);
    if (IA.stats) iaRenderStats(IA.stats);
    iaRenderVersions(IA.open, c?.version || 0);
    iaDetailState();
  }
  if (!$("iamodal").classList.contains("hidden")) iaSheetTexts();
});

// Conversations listed from launch, in the sidebar.
iaRefresh();
