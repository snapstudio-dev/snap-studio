"use strict";
/* "Prints" view: a list on the left (running, queued, then the history by
   day, with search, a filter and chips), the record of the print chosen on
   the right, always open.

   Rust keeps the job store (`jobs_list`) and polls the printers in the
   background (`prints-status`). A running print is designated by its printer
   (`live:<id>`): it may come from another tool; a stored job by its id
   (`job:<id>`). The pure part (filters, days, durations, timeline, the
   timelapse of a print) is in prints-logic.js.

   End of a print with a non-empty queue: Rust emits `queue-next`, a sheet
   offers the next one. Nothing starts without a click, bed cleared. */

const PJ = {
  jobs: [],
  live: [],
  /* Key chosen in the list or the sidebar; null: the default record. */
  sel: null,
  /* The print last seen running on each printer (printer id → { file,
     job }), its job when it is Snap Studio's: a `live:` choice follows it
     into the history when it ends. */
  liveJobs: {},
  /* List: segmented filter, chips (Sets of printer ids and materials), search. */
  filter: "all",
  printers: new Set(),
  materials: new Set(),
  q: "",
  /* The camera (camera.js) in a running print's record: on by default
     (the choice is kept); its switch, one element kept across redraws. */
  cam: { want: localStorage.getItem("snapstudio.pjcam") !== "0", el: null },
  /* The Times card's view (per layer or per type) and whether the Details
     card is open: choices kept. */
  times: localStorage.getItem("snapstudio.pjtimes") === "type" ? "type" : "layer",
  details: localStorage.getItem("snapstudio.pjdetails") === "1",
  /* Timelapses: videos listed per printer (a short cache), jobs already
     looked for this session, the one being looked for, the video element. */
  tl: { videos: {}, tried: new Set(), looking: null, el: null },
  /* The result's note: one textarea for the page, kept across redraws. */
  note: { el: null, saving: Promise.resolve() },
  /* "Start the next one?" sheet: job offered, launch in progress. */
  next: null,
  launching: false,
  /* Offers that arrived while another one was shown. */
  pending: [],
};

const PJ_BUSY = ["printing", "paused"];
const PJ_STATES = ["printing", "paused", "queued", "complete", "finished", "cancelled", "error"];
const pjState = (s) => (PJ_STATES.includes(s) ? tr("prints.state." + s) : s);

/* ------------------------------------------------------------ data */

async function pjLoad() {
  PJ.jobs = (await invoke("jobs_list").catch(() => null)) || [];
  pjTrackLive();
  pjRenderSide();
  if (window.currentView === "prints") pjRender();
}

const pjQueue = () => PJ.jobs.filter((j) => j.state === "queued");
const pjDone = () =>
  PJ.jobs.filter((j) => !["queued", "printing"].includes(j.state)).sort((a, b) => (b.finished || 0) - (a.finished || 0));
const pjActive = () => PJ.live.filter((l) => l.status.online && PJ_BUSY.includes(l.status.state));
const pjLiveOf = (printerId) => PJ.live.find((l) => l.printer_id === printerId);
const pjPrinterName = (id) => pjLiveOf(id)?.printer_name || P.list.find((p) => p.id === id)?.name || tr("slice.printer");

/* Snap Studio job behind a running print, if there is one. */
function pjJobOfLive(live) {
  const mine = PJ.jobs.filter((j) => j.printer_id === live.printer_id && j.state === "printing");
  return mine.find((j) => j.remote === live.status.job) || mine[mine.length - 1] || null;
}

/* Remembers which job is behind each running print, while it runs. A print
   from elsewhere (no job) forgets the previous one's job; the same file
   keeps it: the store may close the job a moment before the status says the
   printer is free. */
function pjTrackLive() {
  for (const l of pjActive()) {
    const job = pjJobOfLive(l), file = l.status.job || "", seen = PJ.liveJobs[l.printer_id];
    if (job) PJ.liveJobs[l.printer_id] = { file, job: job.id };
    else if (!seen || seen.file !== file) PJ.liveJobs[l.printer_id] = { file, job: null };
  }
}

const pjThumb = (job, px = 320) =>
  job?.file ? thumbSrc(job.file, px, 0, job.created) : "";

const pjName = (live) => (live.status.job || tr("prints.print")).replace(/\.gcode$/i, "");

/* Estimated start time of every queued job (job id → ms), from what
   comes before it on its printer: one pass over the queue. */
function pjStartEstimates() {
  const free = {};
  const out = new Map();
  for (const j of pjQueue()) {
    if (!(j.printer_id in free)) {
      const live = pjLiveOf(j.printer_id);
      free[j.printer_id] = Date.now() + (live && PJ_BUSY.includes(live.status.state) ? (live.status.remaining_s || 0) * 1000 : 0);
    }
    out.set(j.id, free[j.printer_id]);
    free[j.printer_id] += (j.stats?.print_time_s || 0) * 1000;
  }
  return out;
}

const pjStartEstimate = (job) => pjStartEstimates().get(job.id) ?? Date.now();

/* ------------------------------------------------------------ sidebar */

function pjRing(p) {
  const r = 6, c = 2 * Math.PI * r, k = Math.max(0, Math.min(1, p || 0));
  return `<svg class="pj-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${r}" class="track"/>
    <circle cx="8" cy="8" r="${r}" class="bar" stroke-dasharray="${(k * c).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
}

function pjRenderSide() {
  const box = $("side-prints");
  const items = [];
  for (const l of pjActive()) {
    const paused = l.status.state === "paused";
    items.push(`<button class="side-item" data-pj="live:${esc(l.printer_id)}" title="${esc(l.printer_name)}">
      <span class="glyph">${pjRing(l.status.progress)}</span>
      <span class="lbl">${esc(pjName(l))}</span>
      <span class="count">${paused ? esc(tr("prints.pause_short")) : Math.round((l.status.progress || 0) * 100) + " %"}</span></button>`);
  }
  pjQueue().forEach((j, i) => {
    items.push(`<button class="side-item" data-pj="job:${esc(j.id)}" title="${esc(pjState("queued"))} · ${esc(pjPrinterName(j.printer_id))}">
      <span class="glyph pj-num">${i + 1}</span><span class="lbl">${esc(j.name)}</span></button>`);
  });
  box.innerHTML = items.join("");
  const n = pjActive().length + pjQueue().length;
  $("count-prints").textContent = n ? String(n) : "";
  sideSync();
}

$("side-prints").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pj]");
  if (b) pjShow(b.dataset.pj);
});

/* ------------------------------------------------------------ view */

function pjShow(key) {
  PJ.sel = key || null;
  if (window.currentView !== "prints") switchView("prints");
  else {
    pjRender();
    sideSync();
  }
}

/* The record shown: the one chosen, else the first running print, else
   the latest finished one (prints-logic.js). */
function pjCurrentKey() {
  if (PJ.sel?.startsWith("live:")) {
    const id = PJ.sel.slice(5), live = pjLiveOf(id);
    if (!live || !PJ_BUSY.includes(live.status.state)) {
      // The print has finished since: its record when Snap Studio has one
      // (chosen by its own key, so the list marks it), else the default.
      const job = PJ.jobs.find((j) => j.id === PJ.liveJobs[id]?.job);
      PJ.sel = job ? "job:" + job.id : null;
    }
  }
  if (PJ.sel && pjResolve(PJ.sel)) return PJ.sel;
  return pjlDefaultKey(pjActive().map((l) => "live:" + l.printer_id), PJ.jobs);
}

/* Replaces an element's content only when it changed: a redraw every few
   seconds must not take the focus, a video or a selection away. */
function pjSet(el, html) {
  if (el._html === html) return false;
  el.innerHTML = html;
  el._html = html;
  return true;
}

function pjRender() {
  tbSet("prints", tr("nav.prints"), pjSubtitle());
  const empty = !PJ.jobs.length && !pjActive().length;
  $("pj-split").classList.toggle("hidden", empty);
  $("pj-empty").classList.toggle("hidden", !empty);
  if (empty) {
    pjLeave();
    pjSet($("pj-empty"), `<div class="empty-art">${PJ_PLACEHOLDER}</div><h1>${esc(tr("prints.empty.title"))}</h1><p>${esc(tr("prints.empty.text"))}</p>`);
    return;
  }
  const key = pjCurrentKey();
  pjRenderTools();
  pjRenderList(key);
  const it = key && pjResolve(key);
  if (it) pjRenderDetail(it);
  else {
    pjLeave();
    pjSet($("pj-detail"), "");
  }
}

function pjSubtitle() {
  const a = pjActive().length, q = pjQueue().length;
  return [a && tr("prints.n_running", { n: a }), q && tr("prints.n_queued", { n: q })].filter(Boolean).join(" · ");
}

/* What a key designates: a running print, or a stored job. */
function pjResolve(key) {
  if (key.startsWith("live:")) {
    const live = pjLiveOf(key.slice(5));
    // Over: pjCurrentKey has moved the choice to its record, if any.
    if (!live || !PJ_BUSY.includes(live.status.state)) return null;
    return { live, job: pjJobOfLive(live), active: true };
  }
  const job = PJ.jobs.find((j) => j.id === key.slice(4));
  if (!job) return null;
  if (job.state === "printing") {
    const live = pjLiveOf(job.printer_id);
    if (live && PJ_BUSY.includes(live.status.state)) return { live, job, active: true };
  }
  return { job, live: pjLiveOf(job.printer_id) };
}

const PJ_PLACEHOLDER =
  '<svg class="pj-ph" viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5 8.2v7.6l7 3.9 7-3.9V8.2z"/></svg>';
const PJ_ICONS = {
  chevron: '<svg class="pj-chev" viewBox="0 0 24 24"><path d="M9 6.4 10.4 5l7 7-7 7L9 17.6 14.6 12z"/></svg>',
  printer: '<svg viewBox="0 0 24 24"><path d="M6 3h12v5h1a3 3 0 0 1 3 3v6h-4v4H6v-4H2v-6a3 3 0 0 1 3-3h1zm2 2v3h8V5zm0 10v4h8v-4z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M12 5V2l4 4-4 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2"/></svg>',
  film: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zm2 2v2h2V6zm10 0v2h2V6zM6 10v4h12v-4zm0 6v2h2v-2zm10 0v2h2v-2z"/></svg>',
};

/* A finished print said failed in its record shows as failed. */
function pjBadge(state, job) {
  if (job?.result?.success === false && !["cancelled", "error"].includes(state)) return `<span class="pj-badge error">${esc(tr("prints.result.failed"))}</span>`;
  return `<span class="pj-badge ${esc(state)}">${esc(pjState(state))}</span>`;
}

const pjThumbHtml = (job, px) => {
  const t = job?.gcode !== false ? pjThumb(job, px) : "";
  return t ? `<img src="${esc(t)}" alt="" loading="lazy" />` : PJ_PLACEHOLDER;
};

/* ------------------------------------------------------------ list */

/* Search, filter and chips: the field is in the page, the rest is drawn. */
function pjRenderTools() {
  const n = (f) => PJ.jobs.filter((j) => pjlPasses(j, { filter: f })).length + (f === "active" ? pjForeign().length : 0);
  const counts = { active: n("active"), failed: n("failed") };
  pjSet(
    $("pj-filter"),
    PJL_FILTERS.map((f) => {
      const on = PJ.filter === f;
      return `<button type="button" class="seg-btn${on ? " on" : ""}" role="radio" aria-checked="${on}" data-filter="${f}" tabindex="${on ? 0 : -1}"><span>${esc(tr("prints.filter." + f))}</span>${
        counts[f] ? `<em>${counts[f]}</em>` : ""
      }</button>`;
    }).join("")
  );
  // Chips only where there is a choice: two printers, two materials.
  const printers = [...new Set(PJ.jobs.map((j) => j.printer_id))];
  const materials = [...new Set(PJ.jobs.flatMap(pjlMaterials))].sort();
  const chip = (kind, v, label, icon) =>
    `<button type="button" class="chip pj-chip${PJ[kind].has(v) ? " on" : ""}" data-chip="${kind}" data-v="${esc(v)}" aria-pressed="${PJ[kind].has(v)}">${icon}${esc(label)}</button>`;
  pjSet(
    $("pj-chips"),
    (printers.length > 1 ? printers.map((p) => chip("printers", p, pjPrinterName(p), PJ_ICONS.printer)).join("") : "") +
      (materials.length > 1 ? materials.map((m) => chip("materials", m, m, `<i class="d" style="--c:${esc(pjMaterialColor(m))}"></i>`)).join("") : "")
  );
  $("pj-chips").classList.toggle("hidden", !$("pj-chips").innerHTML);
}

/* A material's chip color: the first spool of that material sliced. */
function pjMaterialColor(m) {
  for (const j of PJ.jobs) {
    const s = j.stats || {};
    const i = (s.filament_types || []).findIndex((t) => String(t).toUpperCase() === m);
    const c = i >= 0 && (j.profile?.colors?.[i] || s.filament_colors?.[i]);
    if (c) return c;
  }
  return "var(--text-tertiary)";
}

const pjQuery = () => ({ filter: PJ.filter, printers: PJ.printers, materials: PJ.materials, q: PJ.q });

/* Running prints Snap Studio did not start: a key of their printer. */
const pjForeign = () => pjActive().filter((l) => !pjJobOfLive(l));

/* Jobs launched but not (or no longer) seen running on their printer. */
const pjStarting = () =>
  PJ.jobs.filter((j) => j.state === "printing" && !pjActive().some((l) => l.printer_id === j.printer_id && pjJobOfLive(l)?.id === j.id));

function pjRow(key, job, sel, inner, meta) {
  return `<button type="button" class="pj-row${sel ? " sel" : ""}" data-key="${esc(key)}" role="option" aria-selected="${sel}">
    <span class="pj-row-thumb">${pjThumbHtml(job, 96)}</span>
    <span class="pj-row-t">${inner}</span><span class="pj-row-m">${meta}</span></button>`;
}

function pjGroup(title, aside) {
  return `<div class="pj-g" role="presentation"><span>${esc(title)}</span>${aside ? `<em>${esc(aside)}</em>` : ""}</div>`;
}

/* A day's title in the list; `inline` for the middle of a sentence. */
function pjDayTitle(g, inline = false) {
  if (g.rel) return inline ? tr("prints.day." + g.rel).toLowerCase() : tr("prints.day." + g.rel);
  const [y, m, d] = g.day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { weekday: "long", day: "numeric", month: "long" };
  if (y !== new Date().getFullYear()) opts.year = "numeric";
  const s = date.toLocaleDateString(locale(), opts);
  return inline ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

const pjHm = (secs) => new Date(secs * 1000).toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });

function pjRenderList(key) {
  const q = pjQuery();
  const html = [];
  // In progress: running prints (Snap Studio's or not), then launched ones.
  const running = [];
  for (const l of pjActive()) {
    const job = pjJobOfLive(l);
    const probe = job || { name: pjName(l), printer_id: l.printer_id, state: "printing", stats: null };
    if (!pjlPasses(probe, q)) continue;
    const k = `live:${l.printer_id}`;
    const st = l.status, paused = st.state === "paused";
    const pct = Math.round((st.progress || 0) * 100);
    const sub = paused ? tr("prints.pause_short") : st.remaining_s ? tr("prints.ends_at", { time: fmtClock(Date.now() + st.remaining_s * 1000) }) : "";
    running.push(
      pjRow(k, job, k === key, `<b>${esc(job?.name || pjName(l))}</b><small>${simBadge(l.printer_id)}${esc([l.printer_name, sub].filter(Boolean).join(" · "))}</small>
        <span class="pj-mini${paused ? " paused" : ""}"><i style="width:${pct}%"></i></span>`, `<span>${pct} %</span>`)
    );
  }
  for (const j of pjStarting()) {
    if (!pjlPasses(j, q)) continue;
    const off = pjLiveOf(j.printer_id)?.status.online === false;
    running.push(pjRow("job:" + j.id, j, "job:" + j.id === key, `<b>${esc(j.name)}</b><small>${simBadge(j.printer_id)}${esc(pjPrinterName(j.printer_id))} · ${esc(tr(off ? "prints.unreachable" : "printers.cam.starting"))}</small>`, ""));
  }
  if (running.length) html.push(pjGroup(tr("prints.running"), String(running.length)), ...running);
  // Queue, with its total time and each print's estimated start.
  const queue = pjQueue();
  const shown = queue.filter((j) => pjlPasses(j, q));
  if (shown.length) {
    const total = pjlQueueTime(queue);
    const starts = pjStartEstimates();
    html.push(pjGroup(tr("prints.queue"), total ? fmtDuration(total) : ""));
    for (const j of shown) {
      const i = queue.indexOf(j);
      const t = j.stats?.print_time_s;
      const at = fmtClock(starts.get(j.id));
      html.push(
        pjRow("job:" + j.id, j, "job:" + j.id === key, `<b><span class="pj-qn">${i + 1}.</span>${esc(j.name)}</b><small>${simBadge(j.printer_id)}${esc([pjPrinterName(j.printer_id), t && fmtDuration(t)].filter(Boolean).join(" · "))}</small>`,
          `<span title="${esc(tr("prints.starts_at", { time: at }))}">${esc(at)}</span>`)
      );
    }
  }
  // History, by day.
  for (const g of pjlDays(pjDone().filter((j) => pjlPasses(j, q)))) {
    html.push(pjGroup(pjDayTitle(g), g.grams ? fmtWeight(g.grams) : ""));
    for (const j of g.jobs) {
      const d = pjlDuration(j);
      const sub = [pjPrinterName(j.printer_id), j.finished && pjHm(j.finished), d && fmtDuration(d.total)].filter(Boolean).join(" · ");
      html.push(pjRow("job:" + j.id, j, "job:" + j.id === key, `<b>${esc(j.name)}</b><small>${esc(sub)}</small>`, pjBadge(j.state, j)));
    }
  }
  if (!html.length) html.push(`<div class="pj-none">${esc(tr("prints.none_match"))}</div>`);
  // A running print changes the rows every few seconds: the row that had
  // the focus (arrow keys) gets it back.
  const focused = document.activeElement?.closest?.("#pj-rows .pj-row")?.dataset.key;
  if (pjSet($("pj-rows"), html.join("")) && focused) $("pj-rows").querySelector(`.pj-row[data-key="${CSS.escape(focused)}"]`)?.focus();
  // A new choice is brought into view; a redraw leaves the scroll alone.
  if (PJ.listKey !== key) $("pj-rows").querySelector(".pj-row.sel")?.scrollIntoView({ block: "nearest" });
  PJ.listKey = key;
}

$("pj-rows").addEventListener("click", (e) => {
  const r = e.target.closest("[data-key]");
  if (r) pjShow(r.dataset.key);
});
/* Up and down move through the list, as in Mail. */
$("pj-rows").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...$("pj-rows").querySelectorAll(".pj-row")];
  const i = rows.findIndex((r) => r.classList.contains("sel"));
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  e.preventDefault();
  pjShow(next.dataset.key);
  $("pj-rows").querySelector(`.pj-row[data-key="${CSS.escape(next.dataset.key)}"]`)?.focus();
});
$("pj-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b || PJ.filter === b.dataset.filter) return;
  PJ.filter = b.dataset.filter;
  pjRender();
});
segKeys($("pj-filter"), (b) => {
  PJ.filter = b.dataset.filter;
  pjRender();
  $("pj-filter").querySelector(`[data-filter="${PJ.filter}"]`)?.focus();
});
$("pj-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-chip]");
  if (!c) return;
  const set = PJ[c.dataset.chip];
  set.has(c.dataset.v) ? set.delete(c.dataset.v) : set.add(c.dataset.v);
  pjRender();
});
$("pj-q").addEventListener("input", (e) => {
  PJ.q = e.target.value;
  pjRender();
});
$("pj-q").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && PJ.q) {
    e.preventDefault();
    e.target.value = PJ.q = "";
    pjRender();
  }
});

/* ------------------------------------------------------------ record */

/* Header: thumbnail, name, state and what it is, then the actions. */
function pjHead(job, name, state, kicker, buttons) {
  return `<div class="pj-hd">
    <span class="pj-hd-thumb">${pjThumbHtml(job, 160)}</span>
    <div class="pj-hd-t"><h2>${esc(name)}</h2><div class="pj-kick">${pjBadge(state, job)}<span>${kicker}</span></div></div>
    <div class="pj-btns">${buttons}<button type="button" class="btn icon pj-more" data-act="more" title="${esc(tr("prints.more"))}" aria-label="${esc(tr("prints.more"))}">${PJ_ICONS.more}</button></div>
  </div>`;
}

const pjPanel = (title, body, aside = "") =>
  `<section class="pj-card pj-panel"><h3>${esc(title)}${aside ? `<small>${aside}</small>` : ""}</h3>${body}</section>`;

/* A heater as current / target. */
const pjTemp = (t) => `${Math.round(t.current)} / ${Math.round(t.target)}`;

/* The start options of a job, as words (`cap`: capitalised). */
function pjOpts(job, cap = false) {
  const o = job?.options || {}, k = cap ? "_cap" : "";
  return [o.bed_leveling && tr("prints.opt.leveling" + k), o.flow_calibration && tr("prints.opt.flow" + k), o.timelapse && tr("prints.opt.timelapse" + k)].filter(Boolean);
}

/* Filament per head: color, spool, share, weight and length; a running
   print adds each nozzle's temperature, the active one marked. */
function pjFilament(job, st) {
  const s = job?.stats;
  if (!s?.tools?.length && !s?.filament_g) return "";
  const colors = job.profile?.colors || [];
  const names = job.profile?.filaments || [];
  const tools = s.tools?.length ? s.tools : [0];
  const max = Math.max(...tools.map((t) => s.per_tool_g?.[t] || 0), 0.001);
  const rows = tools.map((t) => {
    const g = s.per_tool_g?.[t], m = s.per_tool_m?.[t];
    const c = colors[t] || s.filament_colors?.[t] || "";
    const name = names[t] || names[0] || s.filament_types?.[t] || "";
    const n = st?.nozzles?.find((x) => x.index === t);
    const temp = n ? `<span class="pj-fil-t${n.active ? " on" : ""}"><b>${pjTemp(n)} °C</b>${esc(tr(n.active ? "prints.active" : "prints.standby"))}</span>` : "";
    return `<div class="pj-fil${n?.active ? " on" : ""}" style="--c:${esc(c || "var(--text-tertiary)")}"><i></i><b>T${t}</b>
      <div class="pj-fil-n"><span>${esc(name)}</span><div class="pj-bar"><i style="width:${g != null ? ((g / max) * 100).toFixed(1) : 0}%"></i></div></div>
      <em>${g != null ? `${fmtDec(g, 1)} g` : ""}${m ? `<small>${fmtDec(m, 1)} m</small>` : ""}</em>${temp}</div>`;
  });
  const total = s.filament_g ? `${fmtDec(s.filament_g, 1)} g${s.cost ? ` · ${fmtDec(s.cost, 2)} €` : ""}` : s.cost ? `${fmtDec(s.cost, 2)} €` : "";
  return rows.join("") + (total ? `<div class="pj-fil-tot"><span>${esc(tr(s.cost ? "prints.total_cost" : "prints.total"))}</span><b>${total}</b></div>` : "");
}

/* Time per layer, from the slice: one bar per layer (or a few layers), the
   layers printed filled, the current one marked. */
function pjLayers(job, layer) {
  const ends = job?.stats?.layer_end_s;
  if (!ends || ends.length < 2) return "";
  const bars = pjlLayerBars(ends, 120);
  const max = Math.max(...bars.map((b) => b.s), 1);
  const cur = layer?.[0] || 0;
  const html = bars
    .map((b) => {
      const cls = cur > b.to ? "d" : cur >= b.from ? "c" : "";
      const which = b.from === b.to ? tr("prints.layer_n", { n: b.from }) : tr("prints.layers_n", { a: b.from, b: b.to });
      return `<i class="${cls}" style="height:${Math.max(4, (b.s / max) * 100).toFixed(1)}%" title="${esc(`${which} · ${fmtSpan(b.s)}`)}"></i>`;
    })
    .join("");
  return `<div class="pj-layers">${html}</div><div class="pj-layers-ax"><span>1</span>${cur ? `<span>${esc(tr("prints.layer_of", { a: cur, b: ends.length }))}</span>` : ""}<span>${ends.length}</span></div>`;
}

/* Time per feature, from the slice. */
function pjFeatures(job) {
  const s = job?.stats;
  if (!s?.features?.length) return "";
  const items = s.features.map((f) => ({ name: featureName(f.feature), c: FEATURES[Math.min(f.feature, FEATURES.length - 1)][1], s: f.seconds }));
  if (s.travel_s > 0) items.push({ name: tr("viewer.travel"), c: [96, 104, 126], s: s.travel_s });
  const total = items.reduce((a, f) => a + f.s, 0) || 1;
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  return `<div class="pj-stack">${items.map((f) => `<i style="width:${((f.s / total) * 100).toFixed(2)}%;background:${rgb(f.c)}" title="${esc(f.name)}"></i>`).join("")}</div>
     <div class="pj-legend">${items.map((f) => `<div><i style="background:${rgb(f.c)}"></i><span>${esc(f.name)}</span><em>${Math.round((f.s / total) * 100)} %</em></div>`).join("")}</div>`;
}

/* The Times card: per layer or per type (a small switch, the choice
   kept), on running and finished prints alike; one view alone when the
   slice has only that one. */
function pjTimes(job, layer) {
  const s = job?.stats;
  const hasLayers = (s?.layer_end_s?.length || 0) >= 2, hasTypes = !!s?.features?.length;
  if (!hasLayers && !hasTypes) return "";
  const mode = PJ.times === "type" && hasTypes ? "type" : hasLayers ? "layer" : "type";
  const seg =
    hasLayers && hasTypes
      ? `<div class="seg pj-seg-sm" role="radiogroup" aria-label="${esc(tr("prints.times"))}">${[["layer", tr("prints.times.layer")], ["type", tr("prints.times.type")]]
          .map(([v, label]) => `<button type="button" class="seg-btn${mode === v ? " on" : ""}" role="radio" aria-checked="${mode === v}" data-time="${v}"><span>${esc(label)}</span></button>`)
          .join("")}</div>`
      : "";
  const sub = mode === "layer" ? tr(layer?.[0] ? "prints.layer_time.sub_running" : "prints.layer_time.sub") : tr("prints.from_slice");
  return `<section class="pj-card pj-panel pj-times"><div class="pj-panel-hd"><h3>${esc(tr(hasLayers && hasTypes ? "prints.times" : mode === "layer" ? "prints.times.layer" : "prints.times.type"))}</h3>${seg}<small>${esc(sub)}</small></div>${mode === "layer" ? pjLayers(job, layer) : pjFeatures(job)}</section>`;
}

/* The Details card, folded to one line (machine, profile, plate, layers,
   first layer), open as three groups: the slice, the profile, the files
   and dates. The choice is kept. */
function pjDetails(job) {
  if (!job) return "";
  const s = job.stats || {}, pr = job.profile || {};
  const plate = pr.bed ? pr.bed_label || pr.bed : "";
  const sum = (a) => (a?.length ? a.reduce((x, y) => x + (y || 0), 0) : 0);
  const length = sum(s.per_tool_m), volume = sum(s.per_tool_cm3);
  const tower = s.tower ? `${fmtDec(s.tower.w, 0)} × ${fmtDec(s.tower.d, 0)} × ${fmtDec(s.tower.h, 1)} mm` : "";
  const opts = pjOpts(job, true);
  const when = (t) => (t ? esc(fmtDate(t)) : "");
  const line = [pr.machine, pr.process, plate, s.layers && tr("prints.det.layers_n", { n: s.layers }), s.first_layer_s && tr("prints.det.first_layer_short", { t: fmtSpan(s.first_layer_s) })]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  const group = (title, rows) => `<div><h4>${esc(title)}</h4><div class="pj-kv">${rows}</div></div>`;
  const body = PJ.details
    ? `<div class="pj-det-body">
      ${group(tr("prints.det.slice"), pjKv(tr("prints.det.est_time"), s.print_time_s ? esc(fmtDuration(s.print_time_s)) : "") + pjKv(tr("prints.det.first_layer"), s.first_layer_s ? esc(fmtSpan(s.first_layer_s)) : "") + pjKv(tr("prints.layers"), s.layers ? String(s.layers) : "") + pjKv(tr("prints.det.length"), length ? `${fmtDec(length, 1)} m` : "") + pjKv(tr("prints.det.volume"), volume ? `${fmtDec(volume, 1)} cm³` : "") + pjKv(tr("prints.det.tower"), esc(tower)))}
      ${group(tr("prints.det.profile"), pjKv(tr("prints.det.machine"), esc(pr.machine || "")) + pjKv(tr("prints.det.process"), esc(pr.process || "")) + pjKv(tr("slice.plate"), esc(plate)) + pjKv(tr("prints.det.options"), esc(opts.length ? opts.join(", ") : tr("prints.det.options_none"))))}
      ${group(tr("prints.det.files"), pjKv(tr("prints.det.model"), esc(job.source ? pjlBase(job.source) : "")) + pjKv(tr("prints.det.gcode"), esc(job.remote || pjlBase(job.file))) + pjKv(tr(job.state === "queued" ? "prints.det.added" : "prints.det.sliced"), when(job.created)) + pjKv(tr("prints.det.started"), when(job.started)) + pjKv(tr("prints.det.finished"), when(job.finished)))}
    </div>`
    : "";
  return `<section class="pj-card pj-det${PJ.details ? " open" : ""}">
    <button type="button" class="pj-det-hd" data-act="details" aria-expanded="${PJ.details}">${PJ_ICONS.chevron}<b>${esc(tr("prints.details"))}</b><span>${line}</span></button>${body}
  </section>`;
}

/* What happened, then for a running print where it is and when it should
   end. */
function pjTimeline(job, st) {
  const opts = pjOpts(job);
  const pauses = pjlPauses(job, job.finished ?? null);
  const rows = pjlTimeline(job).map((e) => {
    let extra = "";
    if (e.kind === "sliced") extra = job.profile?.process || "";
    if (e.kind === "started") extra = opts.join(", ");
    if (e.kind === "pause") {
      const p = pauses.find((x) => x.from === e.at);
      extra = p?.to ? fmtSpan(p.to - p.from) : "";
    }
    if (e.kind === "complete" && job.stats?.filament_g) extra = `${fmtDec(job.stats.filament_g, 1)} g`;
    const cls = e.kind === "pause" ? "tl-warn" : ["cancelled", "error"].includes(e.kind) ? "tl-bad" : "tl-done";
    return `<div class="${cls}"><time>${esc(pjHm(e.at))}</time><span>${esc(tr("prints.tl." + e.kind))}${extra ? ` <small>· ${esc(extra)}</small>` : ""}</span></div>`;
  });
  if (st) {
    const now = Date.now() / 1000;
    if (st.layer) {
      const head = st.nozzles?.find((n) => n.active);
      rows.push(`<div class="tl-now"><time>${esc(pjHm(now))}</time><span><b>${esc(tr("prints.layer_cap", { a: st.layer[0], b: st.layer[1] }))}</b>${head ? ` <small>· ${esc(tr("prints.head_active", { t: head.index }))}</small>` : ""}</span></div>`);
    }
    if (st.remaining_s && st.state !== "paused") rows.push(`<div class="tl-fut"><time>${esc(pjHm(now + st.remaining_s))}</time><span>${esc(tr("prints.tl.end_est"))}</span></div>`);
  }
  return pjPanel(tr("prints.timeline"), `<div class="pj-chrono">${rows.join("")}</div>`);
}

const pjKv = (k, v) => (v == null || v === "" ? "" : `<div><span>${esc(k)}</span><b>${v}</b></div>`);

/* Big progress block of a running print. */
function pjProgress(st) {
  const pct = Math.round((st.progress || 0) * 100);
  const head = st.nozzles?.find((n) => n.active);
  const temps = [head && pjTemp(head), st.bed && pjTemp(st.bed)].filter(Boolean);
  return `<div class="pj-card pj-big${st.state === "paused" ? " paused" : ""}">
    <div class="pj-pct">${pct} %${st.layer ? `<small>${esc(tr("prints.layer_of", { a: st.layer[0], b: st.layer[1] }))}</small>` : ""}</div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="pj-kv">
      ${pjKv(tr("prints.kv.left"), st.remaining_s ? esc(fmtDuration(st.remaining_s)) : "")}
      ${pjKv(tr("prints.kv.ends"), st.remaining_s && st.state !== "paused" ? esc(fmtClock(Date.now() + st.remaining_s * 1000)) : "")}
      ${pjKv(tr("prints.kv.elapsed"), st.elapsed_s ? esc(fmtDuration(st.elapsed_s)) : "")}
      ${pjKv(head ? tr("prints.kv.temps_head", { t: head.index }) : tr("slice.plate"), temps.length ? `${temps.join(" · ")} °C` : "")}
      ${pjKv(tr("printers.chamber"), st.chamber ? `${Math.round(st.chamber.current)} °C` : "")}
      ${pjKv(tr("printers.speed"), st.speed_factor != null ? `${Math.round(st.speed_factor * 100)} %` : "")}
      ${pjKv(tr("printers.fan"), st.fan != null ? `${Math.round(st.fan * 100)} %` : "")}
    </div></div>`;
}

const pjFile = (job) => (job?.source ? pjlBase(job.source) : job?.remote || "");

function pjRunningHtml({ job, live }) {
  const st = live.status;
  const name = job?.name || pjName(live);
  const kicker = [live.printer_name, job?.started && tr("prints.started_clock", { time: pjHm(job.started) }), pjFile(job)].filter(Boolean).map(esc).join(" · ");
  const buttons =
    (st.state === "paused"
      ? `<button type="button" class="btn" data-act="resume">${esc(tr("prints.resume"))}</button>`
      : `<button type="button" class="btn" data-act="pause">${esc(tr("prints.pause"))}</button>`) +
    `<button type="button" class="btn danger" data-act="cancel">${esc(tr("prints.cancel"))}</button>`;
  const body = job
    ? `${pjTimes(job, st.layer)}<div class="pj-two">${pjPanel(tr("prints.heads"), pjFilament(job, st))}${pjTimeline(job, st)}</div>${pjDetails(job)}`
    : `<p class="pj-note-muted">${esc(tr("prints.foreign"))}</p>`;
  return `${pjHead(job, name, st.state, kicker, buttons)}
    <div class="pj-top"><div class="pj-media pj-cam" id="pj-media"><span class="pj-cam-off">${PJ_ICONS.cam}</span></div>${pjProgress(st)}</div>${body}`;
}

function pjQueuedHtml({ job, live }) {
  const queue = pjQueue();
  const qi = queue.findIndex((j) => j.id === job.id);
  const printerName = pjPrinterName(job.printer_id);
  const printerFree = live?.status.online && !PJ_BUSY.includes(live.status.state);
  const kicker = esc(`${tr("prints.position", { n: qi + 1 })} · ${tr("prints.starts_at", { time: fmtClock(pjStartEstimate(job)) })}`);
  const buttons = `<button type="button" class="btn primary" data-act="launch"${printerFree ? "" : " disabled"} title="${printerFree ? "" : esc(tr("prints.not_free", { name: printerName }))}">${esc(tr("prints.launch_now"))}</button>
    <button type="button" class="btn" data-act="up"${qi <= 0 ? " disabled" : ""} title="${esc(tr("prints.move_up"))}" aria-label="${esc(tr("prints.move_up"))}">↑</button>
    <button type="button" class="btn" data-act="down"${qi >= queue.length - 1 ? " disabled" : ""} title="${esc(tr("prints.move_down"))}" aria-label="${esc(tr("prints.move_down"))}">↓</button>`;
  const est = job.stats?.print_time_s;
  // One chip per printer, with its state, as in the Slice sheet.
  const where = `<div class="pj-card pj-big">
      <div class="pj-for"><span>${esc(tr("prints.for"))}</span><div class="pj-printers" role="radiogroup" aria-label="${esc(tr("prints.for"))}">${printerChips(P.list, job.printer_id)}</div></div>
      <div class="pj-opts">
        <label><input type="checkbox" class="sw" role="switch" data-opt="bed_leveling"${job.options.bed_leveling ? " checked" : ""}/> ${esc(tr("prints.opt.leveling_cap"))}</label>
        <label><input type="checkbox" class="sw" role="switch" data-opt="flow_calibration"${job.options.flow_calibration ? " checked" : ""}/> ${esc(tr("prints.opt.flow_cap"))}</label>
        <label><input type="checkbox" class="sw" role="switch" data-opt="timelapse"${job.options.timelapse ? " checked" : ""}/> ${esc(tr("prints.opt.timelapse_cap"))}</label>
      </div>
      <div class="pj-kv">${pjKv(tr("viewer.est_time"), est ? esc(fmtDuration(est)) : "")}${pjKv(tr("prints.layers"), job.stats?.layers ? String(job.stats.layers) : "")}</div>
    </div>`;
  return `${pjHead(job, job.name, "queued", kicker, buttons)}
    <div class="pj-top"><div class="pj-media pj-shot">${pjThumbHtml(job, 640)}</div>${where}</div>
    <div class="pj-two">${pjPanel(tr("prints.filament"), pjFilament(job))}${pjTimeline(job)}</div>${pjTimes(job)}${pjDetails(job)}`;
}

function pjStartingHtml({ job, live }) {
  const off = live?.status.online === false;
  const kicker = `${esc(pjPrinterName(job.printer_id))} · ${esc(tr(off ? "prints.unreachable" : "printers.cam.starting"))}`;
  const buttons = off ? `<button type="button" class="btn danger" data-act="remove">${esc(tr("prints.remove_list"))}</button>` : "";
  return `${pjHead(job, job.name, "printing", kicker, buttons)}
    <div class="pj-top"><div class="pj-media pj-shot">${pjThumbHtml(job, 640)}</div><div class="pj-card pj-big"><p class="pj-note-muted">${esc(tr(off ? "prints.starting.offline" : "prints.starting.text"))}</p></div></div>
    <div class="pj-two">${pjPanel(tr("prints.filament"), pjFilament(job))}${pjTimeline(job)}</div>${pjTimes(job)}${pjDetails(job)}`;
}

/* Result card of a finished print: what the user says of it (set here
   only), real against estimated duration, the timelapse. */
function pjResultHtml(job) {
  const r = job.result || {};
  const seg = [
    ["ok", true, PJ_ICONS.check, tr("prints.result.success")],
    ["ko", false, PJ_ICONS.x, tr("prints.result.failed")],
  ]
    .map(([v, ok, icon, label]) => {
      const on = r.success === ok;
      return `<button type="button" class="seg-btn ${v}${on ? " on" : ""}" role="radio" aria-checked="${on}" data-res="${v}">${icon}<span>${esc(label)}</span></button>`;
    })
    .join("");
  const reasons =
    r.success === false
      ? `<div class="pj-reasons" role="radiogroup" aria-label="${esc(tr("prints.result.reason"))}">${PJL_REASONS.map(
          (k) => `<button type="button" class="chip pj-chip${r.reason === k ? " on" : ""}" data-reason="${k}" aria-pressed="${r.reason === k}">${esc(tr("prints.reason." + k))}</button>`
        ).join("")}</div>`
      : "";
  const d = pjlDuration(job);
  const est = job.stats?.print_time_s;
  const delta = d && pjlDelta(d.total - d.paused, est);
  const tl = job.timelapse ? `<div class="pj-note-muted">${esc(tr("prints.tl.saved", { printer: pjPrinterName(job.printer_id) }))}<span id="pj-tl-len"></span></div>` : "";
  return `<div class="pj-card pj-big pj-result">
    <h3>${esc(tr("prints.result"))}</h3>
    <div class="seg pj-outcome" role="radiogroup" aria-label="${esc(tr("prints.result"))}">${seg}</div>
    ${reasons}
    <div id="pj-note-slot"></div>
    <div class="pj-delta">
      <div><small>${esc(tr("prints.real"))}</small><b>${d ? esc(fmtDuration(d.total)) : "—"}</b>${d?.paused ? `<span class="pj-sub">${esc(tr("prints.paused_for", { t: fmtSpan(d.paused) }))}</span>` : ""}</div>
      <div><small>${esc(tr("prints.estimated"))}</small><b>${est ? esc(fmtDuration(est)) : "—"}</b>${
        delta != null && delta !== 0 ? ` <span class="pj-dt ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "−"}${Math.abs(delta)} %</span>` : ""
      }</div>
    </div>${tl}
  </div>`;
}

function pjFinishedHtml({ job }) {
  const day = pjlDays([job])[0];
  const when = job.started && job.finished ? `${pjDayTitle(day, true)}, ${pjHm(job.started)} – ${pjHm(job.finished)}` : job.finished ? fmtDate(job.finished) : "";
  const kicker = [pjPrinterName(job.printer_id), when].filter(Boolean).map(esc).join(" · ");
  const canPrepare = !!(job.profile?.plate?.length || job.source);
  const buttons = `<button type="button" class="btn primary" data-act="requeue"${job.gcode === false ? ` disabled title="${esc(tr("err.job_no_gcode"))}"` : ""}>${PJ_ICONS.redo}${esc(tr("prints.reprint"))}</button>
    <button type="button" class="btn" data-act="prepare"${canPrepare ? "" : ` disabled title="${esc(tr("prints.prepare.none"))}"`}>${esc(tr("prints.open_prepare"))}</button>`;
  const media = job.timelapse ? `<div class="pj-media" id="pj-media"></div>` : `<div class="pj-media pj-shot">${pjThumbHtml(job, 640)}<span class="pj-shot-note">${esc(pjTlNote(job))}</span></div>`;
  return `${pjHead(job, job.name, job.state, kicker, buttons)}
    <div class="pj-top">${media}${pjResultHtml(job)}</div>
    <div class="pj-two">${pjPanel(tr("prints.filament"), pjFilament(job), job.stats?.tools?.length ? esc(tr("prints.n_heads", { n: job.stats.tools.length })) : "")}${pjTimeline(job)}</div>
    ${pjTimes(job)}${pjDetails(job)}`;
}

/* Why a finished print shows its picture rather than a video. */
function pjTlNote(job) {
  if (PJ.tl.looking === job.id) return tr("prints.tl.looking");
  if (!job.options?.timelapse) return tr("prints.tl.off");
  if (pjLiveOf(job.printer_id)?.status.online === false) return tr("prints.tl.offline");
  return PJ.tl.tried.has(job.id) ? tr("prints.tl.none") : "";
}

function pjRenderDetail(it) {
  const box = $("pj-detail");
  const { job, live, active } = it;
  const html = active ? pjRunningHtml(it) : job.state === "queued" ? pjQueuedHtml(it) : job.state === "printing" ? pjStartingHtml(it) : pjFinishedHtml(it);
  box.dataset.printer = live?.printer_id || job?.printer_id || "";
  box.dataset.job = job?.id || "";
  const shown = job?.id || live?.printer_id || "";
  // Another record starts at its top; the same one keeps its scroll.
  // The note being typed survives the redraw: its element is kept, with
  // its focus and caret.
  const note = PJ.note.el, typing = note && document.activeElement === note;
  const caret = typing ? [note.selectionStart, note.selectionEnd] : null;
  if (pjSet(box, html) && box.dataset.shown !== shown) box.scrollTop = 0;
  box.dataset.shown = shown;
  const noteSlot = $("pj-note-slot");
  if (noteSlot) {
    const el = pjNoteNode(job, typing);
    if (el.parentNode !== noteSlot) noteSlot.append(el);
    if (typing && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(...caret);
    }
  }
  const slot = $("pj-media");
  // The camera and the timelapse are kept across redraws: moved, not rebuilt.
  if (active) {
    pjTlStop();
    if (slot) {
      // The camera's box goes into the slot (camera.js), the switch over it.
      camHome(slot, live.printer_id, { auto: PJ.cam.want, tag: live.status.state === "paused" ? "paused" : "live", close: false });
      const sw = pjCamSwitch();
      if (sw.parentNode !== slot) slot.append(sw);
      pjCamPaint();
    }
  } else {
    camHome(null);
    if (job.timelapse && slot) slot.append(pjTlNode(job));
    else pjTlStop();
    if (pjlIsDone(job) && !job.timelapse && job.options?.timelapse) pjFindTimelapse(job);
  }
}

/* Background tracking refreshes the record. */
function pjRefreshDetail() {
  if (window.currentView !== "prints") return;
  pjRender();
}

$("pj-detail").addEventListener("click", async (e) => {
  const tm = e.target.closest("[data-time]");
  if (tm && !tm.disabled && PJ.times !== tm.dataset.time) {
    PJ.times = tm.dataset.time;
    localStorage.setItem("snapstudio.pjtimes", PJ.times);
    return pjRender();
  }
  const b = e.target.closest("[data-act]");
  if (b?.dataset.act === "details") {
    PJ.details = !PJ.details;
    localStorage.setItem("snapstudio.pjdetails", PJ.details ? "1" : "0");
    return pjRender();
  }
  if (b && !b.disabled) pjAct(b.dataset.act, b);
  const chip = e.target.closest(".pj-printers [data-printer]");
  if (chip && !chip.classList.contains("on")) pjSetPrinter(chip.dataset.printer);
  const res = e.target.closest("[data-res]");
  if (res) {
    const want = res.dataset.res === "ok";
    // The chosen one again: back to not said (decided when the save runs,
    // after the ones before it).
    pjSaveResult((r) => ({ success: r.success === want ? null : want }));
  }
  const reason = e.target.closest("[data-reason]");
  if (reason) pjSaveResult((r) => ({ reason: r.reason === reason.dataset.reason ? null : reason.dataset.reason }));
});
/* A queued print moved to another printer. */
async function pjSetPrinter(printerId) {
  const id = $("pj-detail").dataset.job;
  if (!id) return;
  try {
    await invoke("job_edit", { id, printerId });
  } catch (err) {
    toast(String(err), true);
  }
}
$("pj-detail").addEventListener("change", async (e) => {
  if (e.target.id === "pj-cam-toggle") return pjAct("cam", e.target);
  const id = $("pj-detail").dataset.job;
  if (!id) return;
  try {
    if (e.target.dataset.opt) {
      const options = {};
      document.querySelectorAll("#pj-detail [data-opt]").forEach((c) => (options[c.dataset.opt] = c.checked));
      await invoke("job_edit", { id, options });
    }
  } catch (err) {
    toast(String(err), true);
  }
});
/* The note is saved as it is typed (after a short pause) and when the
   field is left. */
let pjNoteTimer = 0;
$("pj-detail").addEventListener("input", (e) => {
  if (e.target.id !== "pj-note") return;
  clearTimeout(pjNoteTimer);
  // The text and the record as they are now: by the time it saves, the
  // field may show another record.
  const { value, dataset: { job } } = e.target;
  pjNoteTimer = setTimeout(() => pjSaveResult({ note: value }, false, job), 800);
});
$("pj-detail").addEventListener("focusout", (e) => {
  if (e.target.id !== "pj-note") return;
  clearTimeout(pjNoteTimer);
  // The field's own record, not the one shown: the field loses the focus
  // when a redraw moves it to another record.
  const job = PJ.jobs.find((j) => j.id === e.target.dataset.job);
  // Saved without a redraw: a click that left the field must still land.
  if (job && (job.result?.note || "") !== e.target.value.trim()) pjSaveResult({ note: e.target.value }, false, job.id);
});

/* The note's textarea, one for the page, moved from record to record. Its
   text follows the store (another record, a saved result) unless it is
   being typed. */
function pjNoteNode(job, typing) {
  if (!PJ.note.el) {
    const el = document.createElement("textarea");
    el.id = "pj-note";
    el.className = "field";
    el.rows = 2;
    PJ.note.el = el;
  }
  const el = PJ.note.el, note = job.result?.note || "";
  el.placeholder = tr("prints.result.note");
  el.setAttribute("aria-label", el.placeholder);
  if (el.dataset.job !== job.id || (!typing && el.dataset.note !== note)) el.value = note;
  el.dataset.job = job.id;
  el.dataset.note = note;
  return el;
}

/* Changes the result of a print (the record's unless `id` says which);
   `redraw` false while typing. `patch` is the fields to change, or a
   function of the result as it stands. The saves go one after the other,
   each built on the result the one before it left: the last one wins. The
   note goes with every change, as it stands in the field at the click: a
   click on Success or a reason right after typing must not resend the old
   one. */
function pjSaveResult(patch, redraw = true, id = $("pj-detail").dataset.job) {
  const note = PJ.note.el?.dataset.job === id ? { note: PJ.note.el.value } : {};
  PJ.note.saving = PJ.note.saving.then(async () => {
    const job = PJ.jobs.find((j) => j.id === id);
    // Gone meanwhile (removed, pruned): nothing to say of it.
    if (!job) return;
    const cur = { success: null, reason: null, note: "", ...job.result, ...note };
    const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
    try {
      const saved = await invoke("job_set_result", { id, result: next });
      pjReplace(saved);
      if (redraw) pjRender();
    } catch (e) {
      toast(String(e), true);
    }
  });
  return PJ.note.saving;
}

/* A job changed by a command: in place, without reloading the list. */
function pjReplace(job) {
  const i = PJ.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) PJ.jobs[i] = job;
}

async function pjAct(act, el) {
  const box = $("pj-detail");
  const id = box.dataset.job, printer = box.dataset.printer;
  const job = PJ.jobs.find((j) => j.id === id);
  try {
    if (act === "pause" || act === "resume") {
      await invoke("print_action", { printerId: printer, action: act });
      toast(tr(act === "pause" ? "prints.pause_requested" : "prints.resume_requested"));
    } else if (act === "cancel") {
      const ok = await window.__TAURI__.dialog.ask(tr("prints.cancel.text"), {
        title: tr("prints.cancel.title"),
        kind: "warning",
        okLabel: tr("prints.cancel"),
        cancelLabel: tr("common.continue"),
      });
      if (ok) {
        await invoke("print_action", { printerId: printer, action: "cancel" });
        toast(tr("prints.cancel_requested"));
      }
    } else if (act === "launch" && job) {
      pjOfferNext({ printer_id: job.printer_id, printer_name: pjPrinterName(job.printer_id), finished: null, next: job }, true);
    } else if (act === "up" || act === "down") {
      await invoke("job_move", { id, delta: act === "up" ? -1 : 1 });
    } else if (act === "remove" && job) {
      const ok = await confirmDelete(
        tr(job.state === "queued" ? "prints.remove.queue" : "prints.remove.history"),
        tr("prints.remove.text", { name: job.name }),
        tr("prints.remove")
      );
      if (ok) {
        await invoke("job_remove", { id });
        PJ.sel = null;
      }
    } else if (act === "requeue" && job) {
      // Reprint: queued again; on a free printer, the start sheet opens.
      const j = await invoke("job_requeue", { id });
      await pjLoad();
      pjShow("job:" + j.id);
      const live = pjLiveOf(j.printer_id);
      if (live?.status.online && !PJ_BUSY.includes(live.status.state)) pjAct("launch");
      else toast(tr("prints.requeued"));
    } else if (act === "prepare" && job) {
      await pjOpenInPrepare(job);
    } else if (act === "paths" && job) {
      openViewer(job.file, job.name, "gcode");
    } else if (act === "printer") {
      P.sel = printer;
      prnRenderDetail();
      switchView("printers");
    } else if (act === "cam") {
      PJ.cam.want = el.checked;
      localStorage.setItem("snapstudio.pjcam", PJ.cam.want ? "1" : "0");
      PJ.cam.want ? camStart(printer) : camStop();
    } else if (act === "more") {
      const r = el.getBoundingClientRect();
      const done = job && pjlIsDone(job);
      nativeMenu(
        [
          ...(job?.file ? [{ id: "pjmore:paths", label: tr("files.view_paths"), enabled: job.gcode !== false }] : []),
          ...(pjLiveOf(printer) ? [{ id: "pjmore:printer", label: tr("prints.goto_printer") }] : []),
          ...(job && (done || job.state === "queued") ? [{}, { id: "pjmore:remove", label: tr(done ? "prints.remove_history" : "prints.remove") }] : []),
        ],
        r.left,
        r.bottom + 4
      );
    }
  } catch (e) {
    toast(String(e), true);
  }
}
onMenu("pjmore", (act) => pjAct(act));

/* Open in Prepare: the plate as it was sliced (asked first when Prepare
   holds other objects), else the model file; the printer is chosen. */
async function pjOpenInPrepare(job) {
  if (job.profile?.plate?.length) {
    if (PR.objects.length) {
      const ok = await confirmDelete(tr("spool.replace.title"), tr("spool.replace.text"), tr("spool.replace.ok"));
      if (!ok) return;
    }
    switchView("prepare");
    await prLoadPlate(job.profile.plate);
  } else if (job.source) {
    await prepareModels([job.source]);
  } else return;
  rememberPrinter(job.printer_id);
}

/* ------------------------------------------------------------ timelapse */

/* The printer's video of a finished print, looked for once per session
   when it has none yet, then kept with the job (prints-logic.js matches). */
async function pjFindTimelapse(job) {
  if (job.timelapse || PJ.tl.tried.has(job.id) || PJ.tl.looking || !job.started || !job.finished) return;
  const live = pjLiveOf(job.printer_id);
  if (!live?.status.online) return;
  PJ.tl.looking = job.id;
  let found = null;
  try {
    const c = PJ.tl.videos[job.printer_id];
    const fresh = c && Date.now() - c.at < 120000;
    const list = fresh ? c.list : await invoke("pf_videos", { printerId: job.printer_id });
    PJ.tl.videos[job.printer_id] = fresh ? c : { at: Date.now(), list };
    found = pjlMatchTimelapse(job, list, pflVideoDate, pflVideoTitle);
    if (found) pjReplace(await invoke("job_set_timelapse", { id: job.id, root: found.root, path: found.path }));
  } catch (e) {
    console.warn("[prints] timelapse", e);
  } finally {
    PJ.tl.tried.add(job.id);
    PJ.tl.looking = null;
  }
  if (window.currentView === "prints") pjRender();
}

/* The video element, one for the page: moved from record to record. */
function pjTlNode(job) {
  if (!PJ.tl.el) {
    const el = document.createElement("div");
    el.className = "pj-media-in pj-video";
    el.innerHTML = `<video id="pj-tl-video" controls playsinline preload="metadata"></video><span class="cam-tag">${PJ_ICONS.film}${esc(tr("prints.tl.tag"))}</span><span class="pj-shot-note" id="pj-tl-note"></span>`;
    const v = el.querySelector("video");
    v.addEventListener("loadedmetadata", () => {
      el.classList.remove("gone");
      const len = $("pj-tl-len");
      if (len && isFinite(v.duration)) len.textContent = ` · ${pflClock(v.duration)}`;
    });
    v.addEventListener("error", () => {
      if (!v.getAttribute("src")) return;
      el.classList.add("gone");
      el.querySelector("#pj-tl-note").textContent = tr("prints.tl.gone");
    });
    PJ.tl.el = el;
  }
  const v = PJ.tl.el.querySelector("video");
  const src = schemeUrl("prn", pflPrnQuery(job.printer_id, job.timelapse.root, job.timelapse.path));
  if (v.dataset.src !== src) {
    PJ.tl.el.classList.remove("gone");
    v.dataset.src = src;
    v.poster = job.gcode !== false ? pjThumb(job, 640) : "";
    v.src = src;
  }
  return PJ.tl.el;
}

function pjTlStop() {
  const v = PJ.tl.el?.querySelector("video");
  if (!v || !v.dataset.src) return;
  v.pause();
  v.removeAttribute("src");
  v.dataset.src = "";
  v.load();
  PJ.tl.el.remove();
}

/* Leaving the page or the record: the camera leaves (camera.js: a pinned
   one goes on in its window), the video stops. */
function pjLeave() {
  camLeave();
  pjTlStop();
}

/* ------------------------------------------------------------ camera */

/* The camera's switch in the record's corner, one element for the page. */
function pjCamSwitch() {
  if (!PJ.cam.el) {
    const el = document.createElement("label");
    el.className = "pj-cam-sw";
    el.innerHTML = `<span></span><input type="checkbox" id="pj-cam-toggle" class="sw small" role="switch" />`;
    PJ.cam.el = el;
  }
  return PJ.cam.el;
}

/* The switch and the slot as the camera says: on for this record's
   printer, or off. */
function pjCamPaint() {
  const el = PJ.cam.el, slot = $("pj-media");
  if (!el) return;
  const on = CAM.on && CAM.id === $("pj-detail").dataset.printer;
  el.querySelector("span").textContent = tr("printers.camera");
  el.querySelector("input").checked = on;
  slot?.classList.toggle("on", on);
}
document.addEventListener("cam-change", pjCamPaint);

/* ------------------------------------------------------------ next */

/* `manual`: "Start Now" from the record, not the end of a print. */
function pjOfferNext(ev, manual = false) {
  // An offer already shown (or a launch in progress): the next one waits
  // its turn, one per printer.
  if (PJ.launching || (!$("qmodal").classList.contains("hidden") && PJ.next)) {
    if (!manual) {
      PJ.pending = PJ.pending.filter((p) => p.printer_id !== ev.printer_id);
      PJ.pending.push(ev);
    }
    return;
  }
  PJ.next = ev;
  const j = ev.next;
  const f = ev.finished;
  const done = $("q-done");
  done.classList.toggle("hidden", !f);
  if (f) {
    const key = { cancelled: "queue.done.cancelled", error: "queue.done.error" }[f.state] || "queue.done.ok";
    done.innerHTML = `<b>✓ ${esc(tr(key, { name: f.name }))}</b><small>${esc(tr("queue.on", { name: ev.printer_name }))}${
      f.started && f.finished ? ` (${esc(fmtDuration(f.finished - f.started))})` : ""
    }</small>`;
  }
  $("q-title").textContent = manual ? tr("queue.title_on", { name: ev.printer_name }) : tr("queue.title");
  const thumb = pjThumb(j, 240);
  $("q-thumb").classList.toggle("hidden", !thumb);
  if (thumb) $("q-thumb").src = thumb;
  $("q-name").textContent = j.name;
  const s = j.stats || {};
  $("q-sub").textContent = [s.print_time_s && fmtDuration(s.print_time_s), s.filament_g && `${s.filament_g.toFixed(0)} g`]
    .filter(Boolean)
    .join(" · ");
  $("q-sub2").textContent = [j.profile?.bed && (j.profile.bed_label || j.profile.bed), tr("queue.on", { name: ev.printer_name })]
    .filter(Boolean)
    .join(" · ");
  $("q-free").checked = false;
  $("q-go").disabled = true;
  $("q-progress").classList.add("hidden");
  $("q-msg").textContent = "";
  $("q-later").disabled = false;
  openSheet($("qmodal"));
}

$("q-free").addEventListener("change", () => ($("q-go").disabled = !$("q-free").checked || PJ.launching));
/* Sheet closed: the next offer, if any. */
function pjQueueClosed() {
  PJ.next = null;
  const ev = PJ.pending.shift();
  // After the sheet's closing animation.
  if (ev) setTimeout(() => pjOfferNext(ev), 250);
}

$("q-later").addEventListener("click", () => {
  if (PJ.launching) return;
  if (PJ.next) invoke("queue_dismiss", { printerId: PJ.next.printer_id }).catch(() => {});
  closeSheet($("qmodal"));
  pjQueueClosed();
});
$("q-go").addEventListener("click", async () => {
  const ev = PJ.next;
  if (!ev || !$("q-free").checked || PJ.launching || PJ.checking) return;
  // Spools loaded now against those of the slice.
  const j = ev.next;
  const pid = j.printer_id || ev.printer_id;
  const printer = P.list.find((x) => x.id === pid);
  if (!printer) return;
  PJ.checking = true;
  let ok;
  try {
    // Back to Prepare: only for jobs that kept their plate; an older record
    // has nothing to slice again.
    const print = { thumb: pjThumb(j, 240), name: j.name, printer: ev.printer_name };
    ok = await spCheckBeforeStart(printer, { tools: j.tools, profile: j.profile || {}, stats: j.stats || {}, canEdit: !!j.profile?.plate?.length, print });
  } catch (e) {
    $("q-msg").className = "pf-test err";
    $("q-msg").textContent = String(e.message || e);
    return;
  } finally {
    PJ.checking = false;
  }
  if (!ok || PJ.next !== ev) return;
  if (ok.edit) return pjEditInPrepare(ev);
  PJ.launching = true;
  $("q-go").disabled = true;
  $("q-later").disabled = true;
  $("q-msg").className = "pf-test busy";
  $("q-msg").textContent = tr("send.preparing");
  try {
    await invoke("job_launch", { id: ev.next.id, map: ok.map });
    PJ.launching = false;
    closeSheet($("qmodal"));
    toast(tr("queue.launched", { name: ev.next.name, printer: ev.printer_name }));
    await pjLoad();
    pjShow("job:" + ev.next.id);
    pjQueueClosed();
  } catch (e) {
    PJ.launching = false;
    $("q-later").disabled = false;
    $("q-go").disabled = !$("q-free").checked;
    $("q-progress").classList.add("hidden");
    $("q-msg").className = "pf-test err";
    $("q-msg").textContent = String(e);
  }
});
/* Spool check's "Edit in Prepare" for a queued print: its plate replaces
   Prepare's (asked first when the plate holds other objects), and the Slice
   sheet opens on its printer, spools read again. Once the new slice is sent,
   the queued print is removed. */
async function pjEditInPrepare(ev) {
  const j = ev.next;
  if (PR.objects.length) {
    const ok = await confirmDelete(tr("spool.replace.title"), tr("spool.replace.text"), tr("spool.replace.ok"));
    if (!ok) return;
  }
  // As "Later": not offered again until the printer finishes another print.
  invoke("queue_dismiss", { printerId: ev.printer_id }).catch(() => {});
  closeSheet($("qmodal"));
  pjQueueClosed();
  switchView("prepare");
  await prLoadPlate(j.profile.plate);
  rememberPrinter(j.printer_id || ev.printer_id);
  openSlice({ replaces: j.id });
}

listen("print-send", (e) => {
  if (!PJ.launching) return;
  const s = e.payload;
  if (s.phase === "check") $("q-msg").textContent = tr("send.checking");
  else if (s.phase === "upload") {
    $("q-progress").classList.remove("hidden");
    $("q-progress").firstElementChild.style.width = Math.max(2, s.percent || 0) + "%";
    $("q-msg").textContent = tr("send.uploading", { p: Math.round(s.percent || 0) });
  } else if (s.phase === "done" && s.message) startWarning(s.message);
});

/* ------------------------------------------------------------ events */

listen("prints-status", (e) => {
  PJ.live = e.payload || [];
  // The camera's printer gone: said over the camera, wherever it shows.
  for (const l of PJ.live) camPrinterStatus(l.printer_id, l.status.online);
  pjTrackLive();
  pjRenderSide();
  pjRefreshDetail();
});
listen("jobs-changed", pjLoad);
listen("queue-next", (e) => pjOfferNext(e.payload));

/* ------------------------------------------------------------ settings */

/* Settings › Prints: the history's automatic deletion, kept by Rust
   (jobs.rs); asked first when it would delete prints at once. */
// Short words in the pills, the full ones in their tooltips.
segmented("set-history-keep", {
  labelOf: (v) => tr("settings.history.short." + (v || "never")),
  titleOf: (v) => $("set-history-keep").querySelector(`option[value="${v}"]`)?.text || "",
});
// Set without a change event: only the user's choice is saved.
invoke("jobs_retention")
  .then((d) => ($("set-history-keep").value = d ? String(d) : ""))
  .catch(() => {});
$("set-history-keep").addEventListener("change", async (e) => {
  const days = e.target.value ? +e.target.value : null;
  const before = await invoke("jobs_retention").catch(() => null);
  if (days === before) return;
  const n = pjlExpired(PJ.jobs, days, Date.now() / 1000).length;
  if (n && !(await confirmDelete(tr("settings.history.confirm.title"), tr("settings.history.confirm.text", { n }), tr("common.delete")))) {
    e.target.value = before ? String(before) : "";
    return;
  }
  try {
    await invoke("jobs_set_retention", { days });
  } catch (err) {
    toast(String(err), true);
  }
});

tbSet("prints", tr("nav.prints"));
window.addEventListener("langchange", () => {
  pjRenderSide();
  if (PJ.tl.el) PJ.tl.el.querySelector(".cam-tag").lastChild.textContent = tr("prints.tl.tag");
  pjCamPaint();
  if (window.currentView === "prints") pjRender();
  else tbSet("prints", tr("nav.prints"), pjSubtitle());
});

(async () => {
  PJ.live = (await invoke("prints_status").catch(() => null)) || [];
  await pjLoad();
  // Listeners in place: the pending question (non-empty queue on a printer
  // free at launch) can be asked.
  invoke("queue_check").catch(() => {});
})();
