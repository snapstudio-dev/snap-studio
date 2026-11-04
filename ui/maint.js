"use strict";
/* Printer care & tuning: tabs Care (what the printer counts, what is due,
   what was done) and Bed Leveling (bedmesh.js); Calibration waits for #17.

   The Snapmaker U1 counts each head's tool changes and errors; Moonraker's
   history its hours and jobs (maintenance.rs). Tasks come from Snapmaker's
   maintenance guide and FAQ; what was done is logged in the app with the
   counters at that moment, and "since" counts from there. Read only:
   nothing is written to the printer. */

const MT = { pid: null, tab: "care", ctx: {}, usage: null, log: [], stale: null, loading: false, due: new Map(), open: new Set(), histOpen: false };

/* Tabs; the last one open is remembered per printer. Calibration (#17)
   is not offered yet. */
const MT_TABS = ["care", "level", "control"];
const mtTabKey = (pid) => `snapstudio.mtab.${pid}`;
const mtTabOf = (pid) => {
  const t = localStorage.getItem(mtTabKey(pid));
  return MT_TABS.includes(t) ? t : "care";
};

/* The last counters read, per printer: a printer switched off still shows
   its maintenance, from them. */
const mtCacheKey = (pid) => `snapstudio.maint.${pid}`;
function mtCached(pid) {
  try {
    return JSON.parse(localStorage.getItem(mtCacheKey(pid)) || "null");
  } catch {
    return null;
  }
}

const MT_GUIDE = "https://wiki.snapmaker.com/en/snapmaker_u1/troubleshooting/Core_Components_Maintenance_Guide";
const MT_VIDEO = "https://www.youtube.com/watch?v=EGfoaHfxalA";

/* Due after `swaps` tool changes (per head), `hours` of printing or
   `months` — whichever comes first. `t`: the video's chapter, in seconds.
   Intervals without an official figure are prudent defaults. `steps`: how
   many `maint.t.<id>.s<n>` texts. */
const MT_TASKS = [
  { id: "contacts", swaps: 100000, t: 549, steps: 3 },
  { id: "docking", swaps: 100000, t: 477, steps: 2 },
  { id: "rails", hours: 500, months: 6, t: 15, steps: 3 },
  { id: "zscrews", hours: 250, months: 3, t: 330, steps: 3 },
  { id: "nozzles", hours: 100, steps: 3 },
  { id: "plate", hours: 50, steps: 3 },
];
const MT_MONTH = 30.44 * 86400;

const mtLast = (log, id) => log.filter((e) => e.task === id).sort((a, b) => b.at - a.at)[0] || null;

/* How far a task is: { ratio, left, unit, last } — the most advanced of
   its counters. Never done: since the printer's start (and for the
   contacts, the count the printer itself reset at its last maintenance). */
function mtProgress(task, usage, log) {
  const last = mtLast(log, task.id);
  const parts = [];
  if (task.swaps) {
    if (!usage.heads.length) return null; // not a U1: no tool change counters
    const since = Math.max(0, ...usage.heads.map((h, i) => h.switch_count - (last ? last.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count)));
    parts.push({ ratio: since / task.swaps, left: task.swaps - since, unit: "swaps" });
  }
  if (task.hours) {
    const since = Math.max(0, usage.print_hours - (last?.print_hours || 0));
    parts.push({ ratio: since / task.hours, left: Math.round(task.hours - since), unit: "hours" });
  }
  if (task.months && last) {
    const months = (Date.now() / 1000 - last.at) / MT_MONTH;
    parts.push({ ratio: months / task.months, left: Math.round(task.months - months), unit: "months" });
  }
  const worst = parts.reduce((x, y) => (y.ratio > x.ratio ? y : x));
  return { ...worst, last };
}

/* "In 80 h" / "Overdue by 296 h" / "In 98,396 tool changes". */
function mtWhen(pr) {
  const n = fmtNum(Math.abs(pr.left));
  return tr(pr.left < 0 ? `maint.late.${pr.unit}` : `maint.in.${pr.unit}`, { n });
}

const mtState = (ratio) => (ratio >= 1 ? "due" : ratio >= 0.8 ? "soon" : "ok");

/* Tasks due on a printer, for the sidebar's dot. */
function mtDueCount(usage, log) {
  return MT_TASKS.map((t) => mtProgress(t, usage, log)).filter((p) => p && p.ratio >= 1).length;
}

/* A printer's counters and log. Unreachable: its last counters, with the
   time they were read (`stale`); never read: `usage` null. The log is the
   app's, always there. */
async function mtLoad(pid) {
  const p = P.list.find((x) => x.id === pid);
  if (!p) return null;
  const log = await invoke("maintenance_log", { printerId: pid }).catch(() => []);
  let usage = null, stale = null;
  try {
    usage = await invoke("printer_maintenance", { host: p.host, port: p.port });
    localStorage.setItem(mtCacheKey(pid), JSON.stringify({ usage, at: Date.now() }));
  } catch {
    const c = mtCached(pid);
    if (c?.usage) ({ usage } = c), (stale = c.at);
  }
  if (usage) MT.due.set(pid, mtDueCount(usage, log));
  // The bed mesh, read (and a new full one stored) at the same time.
  if (typeof bmLoad === "function") await bmLoad(pid).catch(() => null);
  mtSideDots();
  return { usage, log, stale };
}

/* Every printer's due tasks, quietly: at launch, then hourly. */
async function mtCheckAll() {
  await Promise.all(P.list.map((p) => mtLoad(p.id).catch(() => null)));
}

/* Due tasks of a printer: Care's, and the bed (out of tolerance, or a
   measurement due). */
const mtBedDue = (pid) => (typeof bmDueOf === "function" ? bmDueOf(pid) : null);
const mtDueAll = (pid) => (MT.due.get(pid) || 0) + (mtBedDue(pid) ? 1 : 0);

function mtSideDots() {
  document.querySelectorAll("#side-printers [data-maint]").forEach((b) => {
    const n = mtDueAll(b.dataset.maint);
    b.querySelector(".mt-dot")?.classList.toggle("hidden", !n);
    b.title = n ? tr("maint.due_n", { n }) : "";
  });
  mtTabMarks();
}

/* The ⚠ of a tab that asks for something. */
function mtTabMarks() {
  if (!MT.pid) return;
  const warn = { care: mtDueAll(MT.pid) > 0, level: !!mtBedDue(MT.pid) };
  document.querySelectorAll("#mt-tabs [data-mtab]").forEach((b) => {
    const w = !!warn[b.dataset.mtab];
    b.querySelector(".tab-warn").classList.toggle("hidden", !w);
    if (w) b.title = b.dataset.mtab === "level" ? tr(mtBedDue(MT.pid)?.kind === "out" ? "bm.alert_tab" : "bm.due_tab") : tr("maint.due_n", { n: mtDueAll(MT.pid) });
    else b.removeAttribute("title");
  });
}

/* Shows a tab of the printer shown. */
function mtSetTab(tab) {
  MT.tab = MT_TABS.includes(tab) ? tab : "care";
  if (MT.pid) localStorage.setItem(mtTabKey(MT.pid), MT.tab);
  document.querySelectorAll("#mt-tabs [data-mtab]").forEach((b) => {
    b.classList.toggle("on", b.dataset.mtab === MT.tab);
    b.setAttribute("aria-pressed", String(b.dataset.mtab === MT.tab));
  });
  $("mt-body").classList.toggle("hidden", MT.tab !== "care");
  $("bm-body").classList.toggle("hidden", MT.tab !== "level");
  $("ct-body").classList.toggle("hidden", MT.tab !== "control");
  ["bm-measure-btn", "bm-settings-btn"].forEach((id) => $(id).classList.toggle("hidden", MT.tab !== "level"));
  $("mt-refresh").title = tr(MT.tab === "level" ? "bm.refresh" : MT.tab === "control" ? "ctl.refresh" : "maint.refresh");
  mtTabMarks();
  mtRender();
  if (MT.tab === "level") bmShow(MT.pid);
  // Control reads the printer while it is shown, and only then.
  if (MT.tab === "control") ctShow(MT.pid, MT.ctx || {});
  else ctLeave();
  MT.ctx = {};
}

/* Opens Care & Tuning on a printer and a tab; `ctx` is the tab's opening
   context (Control: { head }). */
async function maintShow(pid, tab, ctx = {}) {
  const fresh = MT.pid !== pid;
  MT.ctx = ctx;
  MT.pid = pid;
  P.sel = pid;
  switchView("maint");
  if (tab || fresh) MT.tab = tab && MT_TABS.includes(tab) ? tab : mtTabOf(pid);
  // What is known shows at once; the printer's answer follows.
  if (fresh) {
    const c = mtCached(pid);
    MT.usage = c?.usage || null;
    MT.stale = c?.at || null;
    MT.log = [];
  }
  MT.loading = true;
  BM.loading = true;
  mtSetTab(MT.tab);
  const r = await mtLoad(pid).catch(() => null);
  if (MT.pid !== pid) return;
  MT.loading = false;
  BM.loading = false;
  if (r) ({ usage: MT.usage, log: MT.log, stale: MT.stale } = r);
  mtRender();
  if (MT.tab === "level") bmRender();
}

function mtRender() {
  const p = P.list.find((x) => x.id === MT.pid);
  if (!p) return;
  tbSet("maint", tr("maint.title"), p.name || p.host);
  if (MT.tab !== "care") return;
  const box = $("mt-body");
  const u = MT.usage;
  if (!u) {
    // Never read: said in one line, as on the printer's other screens, then
    // the log, which is ours.
    box.innerHTML = MT.loading
      ? `<p class="hv-note">${esc(tr("maint.loading"))}</p>`
      : `${offlineLine(tr("printers.no_answer", { name: p.name || p.host }), "data-mt-retry")}${mtHistory()}`;
    return;
  }
  const order = { due: 0, soon: 1, ok: 2 };
  const tasks = MT_TASKS.map((t) => ({ t, pr: mtProgress(t, u, MT.log) }))
    .filter((x) => x.pr)
    .map((x) => ({ ...x, st: mtState(x.pr.ratio) }))
    .sort((a, b) => order[a.st] - order[b.st] || b.pr.ratio - a.pr.ratio);
  const level = mtBedDue(MT.pid);
  const pending = tasks.filter((x) => x.st !== "ok");
  const due = pending.length + (level ? 1 : 0);

  // Summary: what to do, or what comes next.
  const next = tasks.filter((x) => x.st === "ok").sort((a, b) => b.pr.ratio - a.pr.ratio)[0];
  const never = pending.length && !MT.log.length;
  const banner = `<div class="mt-banner ${due ? "" : "ok"}">
      <div class="mt-banner-text"><b>${esc(due ? tr("maint.due_n", { n: due }) : tr("maint.all_ok"))}</b>
      <small>${esc(due ? (never ? tr("maint.never_hint") : tr("maint.others_ok")) : next ? tr("maint.next", { task: tr(`maint.t.${next.t.id}`), when: mtWhen(next.pr).toLowerCase() }) : "")}</small></div>
      ${never ? `<button class="btn small" data-mt-all>${esc(tr("maint.all_done"))}</button>` : ""}
    </div>`;

  const hm = (h) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const strip = [
    [`${fmtNum(Math.round(u.print_hours))} h`, tr("maint.u.hours")],
    [fmtNum(u.jobs), tr("maint.u.jobs")],
    [u.filament_m >= 1000 ? `${fmtDec(u.filament_m / 1000, 2)} km` : `${fmtNum(Math.round(u.filament_m))} m`, tr("maint.u.filament")],
    [hm(u.longest_print_hours), tr("maint.u.longest")],
    u.purifier_hours ? [`${fmtNum(Math.round(u.purifier_hours))} h`, tr("maint.u.purifier")] : null,
  ].filter(Boolean).map(([v, k]) => `<span><b>${esc(v)}</b>${esc(k)}</span>`).join("");

  // The bed out of tolerance: a task of its own, opening its tab.
  const levelRow = level
    ? `<div class="mt-task" data-mt-task="level">
      <div class="mt-row" data-mt-level>
        <span class="mt-chev"></span><span class="mt-dot-st ${level.kind === "out" ? "due" : "soon"}"></span>
        <span class="mt-name"><b>${esc(tr("maint.tab.level"))}</b><small class="${level.kind === "out" ? "due" : "soon"}">${esc(
          level.kind === "out" ? tr("bm.task_sub", { dev: fmtDec(level.dev, 2), limit: fmtDec(bmSettingsOf(MT.pid).limit, 2), d: mtDate(level.at) })
          : level.remind.reason === "prints" ? tr("bm.task_stale_prints", { n: level.remind.prints })
          : tr("bm.task_stale_days", { n: level.remind.days })
        )}</small></span>
        <span class="mt-mini ${level.kind === "out" ? "due" : "soon"}"><i class="full"></i></span>
        <button class="btn small primary" data-mt-level>${esc(tr("bm.open"))}</button>
      </div>
    </div>`
    : "";
  const rows = levelRow + tasks.map(({ t, pr, st }) => {
    const open = MT.open.has(t.id);
    const pct = Math.min(100, pr.ratio * 100);
    const note = pr.last ? tr("maint.last", { d: mtDate(pr.last.at) }) : t.hours ? tr("maint.never") : "";
    const steps = Array.from({ length: t.steps }, (_, i) => `<li>${esc(tr(`maint.t.${t.id}.s${i + 1}`))}</li>`).join("");
    const video = t.t ? `<button class="mt-card" data-mt-link="${esc(`${MT_VIDEO}&t=${t.t}s`)}">
        <span class="mt-thumb"><i></i><em>${Math.floor(t.t / 60)}:${String(t.t % 60).padStart(2, "0")}</em></span>
        <span class="mt-card-text"><b>${esc(tr("maint.video"))}</b><small>${esc(tr(`maint.t.${t.id}.video`))}</small></span><span class="mt-ext">↗</span></button>` : "";
    return `<div class="mt-task${open ? " open" : ""}" data-mt-task="${t.id}">
      <div class="mt-row" data-mt-toggle="${t.id}">
        <span class="mt-chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span><span class="mt-dot-st ${st}"></span>
        <span class="mt-name"><b>${esc(tr(`maint.t.${t.id}`))}</b><small class="${st === "ok" ? "" : st}">${esc([mtWhen(pr), note].filter(Boolean).join(" · "))}</small></span>
        <span class="mt-mini ${st}"><i style="width:${pct}%"></i></span>
        ${st === "ok" ? `<span class="mt-done-gap"></span>` : `<button class="btn small primary" data-mt-done="${t.id}">${esc(tr("maint.done"))}</button>`}
      </div>
      <div class="mt-detail">
        <ol class="mt-steps">${steps}</ol>
        <div class="mt-res">${video}
          <button class="mt-card" data-mt-link="${esc(MT_GUIDE)}">
            <span class="mt-doc"><svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6zm8 1.5V8h4.5zM8 12h8v1.5H8zm0 3h8v1.5H8zm0 3h5v1.5H8z"/></svg></span>
            <span class="mt-card-text"><b>${esc(tr("maint.guide"))}</b><small>${esc(tr("maint.guide_sub"))}</small></span><span class="mt-ext">↗</span></button>
        </div>
        ${st === "ok" ? `<button class="btn small mt-note-done" data-mt-done="${t.id}">${esc(tr("maint.mark_done"))}</button>` : ""}
      </div>
    </div>`;
  }).join("");

  const contacts = mtLast(MT.log, "contacts");
  const heads = u.heads.map((h, i) => {
    const base = contacts ? contacts.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count;
    const since = Math.max(0, h.switch_count - base);
    const pct = (since / 100000) * 100;
    const chip = [h.diameter ? fmtDec(h.diameter, 1) : "", h.nozzle ? tr("maint.nozzle." + h.nozzle) : ""].filter(Boolean).join(" · ");
    const issues = [
      h.error_count ? tr("maint.h.errors_n", { n: h.error_count }) : "",
      h.retry_count ? tr("maint.h.retries_n", { n: h.retry_count }) : "",
    ].filter(Boolean).join(" · ");
    return `<div class="mt-head">
      <div class="mt-head-top"><b>T${h.index}</b>${chip ? `<span class="mt-chip${h.nozzle === "high_flow" ? " hf" : ""}">${esc(chip)}</span>` : ""}</div>
      <div class="mt-big">${fmtNum(h.switch_count)}<small>${esc(tr("maint.h.swaps"))}</small></div>
      <div class="mt-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="mt-sub">${esc(tr("maint.h.towards", { p: fmtDec(pct, 1) }))}</div>
      ${issues ? `<div class="mt-hint" title="${esc(tr("maint.h.errors_hint"))}">⚠ ${esc(issues)}${h.error_count ? ` — ${esc(tr("maint.h.clean"))}` : ""}</div>` : ""}
    </div>`;
  }).join("");

  const notice = MT.loading && MT.stale
    ? `<div class="mt-stale"><span class="spinner"></span>${esc(tr("maint.connecting"))}</div>`
    : MT.stale
      ? offlineLine(tr("maint.stale", { name: p.name || p.host, d: mtDateTime(MT.stale) }), "data-mt-retry")
      : "";
  box.innerHTML = `${notice}${banner}
    <div class="mt-strip">${strip}</div>
    <div class="vp-section">${esc(tr("maint.tasks"))} <span class="mt-info" title="${esc(tr("maint.note"))}">i</span></div>
    <div class="group mt-tasks">${rows}</div>
    ${heads ? `<div class="vp-section">${esc(tr("maint.heads"))}</div><div class="mt-heads">${heads}</div>` : ""}
    ${mtHistory()}`;
  box.querySelector(".mt-hist")?.addEventListener("toggle", (e) => (MT.histOpen = e.target.open));
}

/* The log, collapsed: the app's own record, shown even printer off. */
function mtHistory() {
  // Bed measurements stored by the app join the tasks done.
  const st = bmSettingsOf(MT.pid);
  const meshes = (BM.hist.get(MT.pid) || []).map((m) => ({ mesh: m, at: m.at }));
  const all = [...MT.log, ...meshes].sort((a, b) => b.at - a.at);
  const log = all.map((e) => {
    if (e.mesh) {
      const dev = bmlStats(e.mesh)?.dev ?? 0;
      return `<div class="mt-hrow"><span>${esc(tr("bm.hist_entry"))}</span><small>${esc(mtDate(e.at))} · ${esc(tr("bm.dev_mm", { v: fmtDec(dev, 2) }))} · ${esc(tr(`bm.st.${bmlStatus(dev, st)}`))}</small></div>`;
    }
    return `<div class="mt-hrow"><span>${esc(tr(`maint.t.${e.task}`))}</span><small>${esc(mtDate(e.at))} · ${esc(tr("maint.at_hours", { n: fmtNum(Math.round(e.print_hours)) }))}</small></div>`;
  }).join("");
  return `<details class="mt-hist"${MT.histOpen ? " open" : ""}><summary>${esc(tr("maint.log_n", { n: all.length }))}</summary>
    <div class="group">${log || `<div class="mt-hrow"><span class="mt-empty">${esc(tr("maint.log.empty"))}</span></div>`}</div></details>`;
}

const mtDateTime = (ms) => new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const mtDate = (at) => new Date(at * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });

/* Logs tasks as done now; the toast offers to undo. */
async function mtMarkDone(ids) {
  const added = [];
  try {
    for (const task of ids) {
      MT.log = await invoke("maintenance_done", {
        printerId: MT.pid,
        task,
        printHours: MT.usage.print_hours,
        swaps: MT.usage.heads.map((h) => h.switch_count),
      });
      const e = MT.log[MT.log.length - 1];
      added.push({ task: e.task, at: e.at });
    }
  } catch (err) {
    toast(String(err), true);
  }
  mtAfterLog();
  if (!added.length) return;
  const pid = MT.pid;
  const msg = added.length === 1 ? tr("maint.done_toast", { task: tr(`maint.t.${added[0].task}`) }) : tr("maint.done_many", { n: added.length });
  toast(msg, false, {
    label: tr("maint.undo"),
    run: async () => {
      for (const e of added) MT.log = await invoke("maintenance_remove", { printerId: pid, task: e.task, at: e.at }).catch(() => MT.log);
      if (MT.pid === pid) mtAfterLog();
    },
  });
}

function mtAfterLog() {
  if (MT.usage) MT.due.set(MT.pid, mtDueCount(MT.usage, MT.log));
  mtSideDots();
  mtRender();
}

$("mt-body").addEventListener("click", (e) => {
  const link = e.target.closest("[data-mt-link]");
  if (link) {
    invoke("plugin:opener|open_url", { url: link.dataset.mtLink }).catch((err) => toast(String(err), true));
    return;
  }
  if (e.target.closest("[data-mt-level]")) {
    mtSetTab("level");
    return;
  }
  if (e.target.closest("[data-mt-retry]")) {
    maintShow(MT.pid);
    return;
  }
  const done = e.target.closest("[data-mt-done]");
  if (done && MT.usage) {
    mtMarkDone([done.dataset.mtDone]);
    return;
  }
  if (e.target.closest("[data-mt-all]") && MT.usage) {
    mtMarkDone(MT_TASKS.filter((t) => {
      const pr = mtProgress(t, MT.usage, MT.log);
      return pr && pr.ratio >= 0.8;
    }).map((t) => t.id));
    return;
  }
  const row = e.target.closest("[data-mt-toggle]");
  if (row) {
    const id = row.dataset.mtToggle;
    MT.open.has(id) ? MT.open.delete(id) : MT.open.add(id);
    row.parentElement.classList.toggle("open");
  }
});
$("mt-refresh").addEventListener("click", () => {
  if (!MT.pid) return;
  if (MT.tab === "control") return ctRead(true);
  maintShow(MT.pid);
});
$("mt-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mtab]");
  if (b && b.dataset.mtab !== MT.tab) mtSetTab(b.dataset.mtab);
});
window.addEventListener("langchange", () => {
  if (window.currentView !== "maint") return;
  mtSetTab(MT.tab);
});
setInterval(() => typeof P !== "undefined" && P.list.length && mtCheckAll(), 3600 * 1000);
