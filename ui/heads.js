"use strict";
/* Heads and spools: shared state.

   Per PRINTER: the filament profile chosen for each head (color and
   material come from the real spool the printer reports) and, per model
   file, which head prints each of its colors. One source of truth for the
   "Heads and spools" screen, the printer view, the Prepare view (D strip and
   live colors) and the slice sheet; every change fires "headschange".

   Stored in localStorage["snapstudio.heads"]:
     { printers: { <printer id | "_none">: { filaments: [name|null…],
                                             map: { <file path>: { <ext>: head } },
                                             virtual: [{ uid, a, b, pct }], nextUid } },
       active: <printer id> }
   A head value is 0–15 for a physical head, 100 + uid for a virtual one
   (virtual-logic.js). 
   The old per-machine-profile memory ("snapstudio.slice") is read once per
   printer to seed it, and is left untouched. */

const HEADS_KEY = "snapstudio.heads";
const HD_NONE = "_none";
const HD = {
  data: (() => {
    try {
      return JSON.parse(localStorage.getItem(HEADS_KEY) || "null") || {};
    } catch {
      return {};
    }
  })(),
  slots: new Map(), // printer id -> spools last read
  models: new Map(), // file path -> Promise<{ filaments, used }>
  lists: new Map(), // printer id -> Promise<slice_lists of its machine>
  listsNow: {}, // printer id -> filament profiles, once known
};
HD.data.printers ||= {};

function hdSave() {
  localStorage.setItem(HEADS_KEY, JSON.stringify(HD.data));
}
function hdEmit(detail) {
  window.dispatchEvent(new CustomEvent("headschange", { detail }));
}

/* Old memory: profiles remembered per machine profile, and the machine
   profile last used with each printer. */
function hdMigrate(pid) {
  let mem = {};
  try {
    mem = JSON.parse(localStorage.getItem("snapstudio.slice") || "{}");
  } catch {}
  const machine = pid ? mem["printer:" + pid] || (mem.printer === pid ? mem.last : null) : mem.last;
  const m = machine ? mem[machine] : null;
  if (m?.filaments) return [...m.filaments];
  if (m?.filament) return [m.filament];
  return [];
}

function headsEntry(pid) {
  const k = pid || HD_NONE;
  let e = HD.data.printers[k];
  if (!e) {
    e = HD.data.printers[k] = { filaments: hdMigrate(pid), map: {} };
    hdSave();
  }
  e.filaments ||= [];
  e.map ||= {};
  return e;
}

const headsFilaments = (pid) => headsEntry(pid).filaments;
function headsSetFilament(pid, i, name, src) {
  const e = headsEntry(pid);
  if (e.filaments[i] === name) return;
  for (let k = e.filaments.length; k < i; k++) e.filaments[k] = null;
  e.filaments[i] = name;
  hdSave();
  hdEmit({ pid, what: "filament", src });
}

const headsHeadOf = (pid, path, ext) => headsEntry(pid).map[path]?.[ext];
function headsSetHead(pid, path, ext, h, src) {
  const e = headsEntry(pid);
  (e.map[path] ||= {})[ext] = h;
  hdSave();
  hdEmit({ pid, what: "map", path, src });
}

/* Printer used by Prepare: the one last chosen there or in the slice sheet,
   otherwise the first one. A remembered "without printer" (a slice run
   before any printer was added) only counts when there is none — as in the
   slice sheet: it left Prepare with no spools and a single head (T0). */
function headsActive() {
  const list = typeof P !== "undefined" ? P.list : [];
  const ok = (id) => id && list.some((p) => p.id === id);
  const cand = [HD.data.active, typeof SL !== "undefined" ? SL.memory.printer : undefined];
  return cand.find(ok) ?? list[0]?.id ?? "";
}
function headsSetActive(pid, src) {
  if (HD.data.active === pid) return;
  HD.data.active = pid;
  hdSave();
  hdEmit({ pid, what: "active", src });
}

/* ------------------------------------------------------------ spools */

function headsSlots(pid) {
  if (!pid) return [];
  return HD.slots.get(pid) || (typeof P !== "undefined" && P.status.get(pid)?.filaments) || [];
}
function headsSetSlots(pid, slots) {
  if (!pid || !Array.isArray(slots)) return;
  const before = JSON.stringify(HD.slots.get(pid) || null);
  HD.slots.set(pid, slots);
  if (JSON.stringify(slots) === before) return;
  // A spool read: the virtual heads one of whose spools is out go.
  const gone = vhUnloaded(headsVirtual(pid), slots);
  if (gone.length) hdVirtualGone(pid, gone);
  hdEmit({ pid, what: "slots" });
}
async function headsRefreshSlots(pid) {
  const p = typeof P !== "undefined" ? P.list.find((x) => x.id === pid) : null;
  if (!p) return [];
  try {
    const st = await invoke("printer_status", { host: p.host, port: p.port });
    if (st.online) headsSetSlots(pid, st.filaments || []);
  } catch {}
  return headsSlots(pid);
}
listen("printer-status", (e) => {
  const { id, status } = e.payload || {};
  if (status?.online && status.filaments) headsSetSlots(id, status.filaments);
});

/* Number of heads: the spools reported, otherwise the profiles known,
   otherwise — nothing read from the printer yet (asleep, offline) — the
   machine profile's, rather than a single head. */
function headsCount(pid) {
  const known = Math.max(headsSlots(pid).length, headsFilaments(pid).length);
  return Math.max(1, known || (typeof SL !== "undefined" ? SL.lists?.extruders || 0 : 0));
}

/* ------------------------------------------------------------ virtual heads */

/* A printer's virtual heads, oldest first; none without a printer: their
   color needs its spools. */
function headsVirtual(pid) {
  if (!pid) return [];
  const e = headsEntry(pid);
  return (e.virtual ||= []);
}

/* A new virtual head ({ a, b, pct }): its value (100 + uid). */
function headsVirtualAdd(pid, mix) {
  const e = headsEntry(pid);
  e.virtual ||= [];
  if (!vhCanAdd(e.virtual)) return null;
  e.nextUid = Math.max(e.nextUid || 1, ...e.virtual.map((v) => v.uid + 1));
  const v = { uid: e.nextUid++, a: mix.a, b: mix.b, pct: mix.pct };
  e.virtual.push(v);
  hdSave();
  hdEmit({ pid, what: "virtual" });
  return vhValue(v.uid);
}

function headsVirtualSet(pid, uid, mix) {
  const v = headsVirtual(pid).find((x) => x.uid === uid);
  if (!v) return;
  Object.assign(v, { a: mix.a, b: mix.b, pct: mix.pct });
  hdSave();
  hdEmit({ pid, what: "virtual" });
}

/* Deleted (by hand, or a spool unloaded): what used them is left as it is,
   an orphan value meaning "no head" until a head is chosen. */
function headsVirtualDelete(pid, uids) {
  const e = headsEntry(pid);
  e.virtual = (e.virtual || []).filter((v) => !uids.includes(v.uid));
  hdSave();
  hdEmit({ pid, what: "virtual" });
}

/* Unloaded spools took virtual heads with them: deleted, said once for the
   whole read, with how many colors of the plate are left without a head. */
function hdVirtualGone(pid, gone) {
  const list = headsVirtual(pid);
  // One sentence per unloaded spool: "T2 was unloaded: V1 (T0 + T2) and
  // V2 (T3 + T2) were deleted."
  const by = new Map();
  for (const { v, out } of gone) {
    const key = out.map((h) => "T" + h).join(", ");
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(`${vhName(list, vhValue(v.uid))} (T${v.a} + T${v.b})`);
  }
  const said = [...by].map(([h, names]) => tr("heads.virtual.removed", { h, names: names.join(", "), n: names.length }));
  const values = gone.map(({ v }) => vhValue(v.uid));
  headsVirtualDelete(pid, gone.map(({ v }) => v.uid));
  const n = typeof prVirtualUsers === "function" && pid === headsActive() ? prVirtualUsers(values) : 0;
  if (n) said.push(tr("heads.virtual.orphans", { n }));
  const away = window.currentView !== "prepare" && n;
  toast(said.join(" "), true, away ? { label: tr("heads.virtual.see_prepare"), run: () => switchView("prepare") } : null);
}

/* A head's spool color, if read. */
function hdSpoolColor(pid, h) {
  const s = headsSlots(pid).find((x) => x.index === h);
  return s?.present && s.color ? s.color : "";
}

/* Mixed colors, from the engine's mixer (mix_colors), kept by colors and
   share; linear light meanwhile. Orca mixes from the lower head to the
   higher one, `t` being the higher one's share: so does this, so that the
   swatch matches Snapmaker Orca's. */
const HD_MIX = new Map();
function hdMix(ca, cb, a, b, shareB) {
  if (!ca || !cb) return ca || cb || "";
  const [lo, hi, t] = a < b ? [ca, cb, shareB] : [cb, ca, 1 - shareB];
  const key = `${lo}|${hi}|${t.toFixed(4)}`;
  if (HD_MIX.has(key)) return HD_MIX.get(key) || vhMixLinear(lo, hi, t);
  HD_MIX.set(key, null);
  invoke("mix_colors", { a: lo, b: hi, shares: [t] })
    .then(([c]) => {
      HD_MIX.set(key, c);
      hdEmit({ what: "mix" });
    })
    .catch(() => HD_MIX.delete(key));
  return vhMixLinear(lo, hi, t);
}

/* A virtual head's color now: its two spools mixed at its cadence. */
function headsVirtualColor(pid, v) {
  return v ? hdMix(hdSpoolColor(pid, v.a), hdSpoolColor(pid, v.b), v.a, v.b, vhShare(v.pct)) : "";
}

/* A head value's color: a physical head's spool, a virtual head's mix,
   nothing for an orphan. */
const headsColorOf = (pid, h) => (vhIs(h) ? headsVirtualColor(pid, vhFind(headsVirtual(pid), h)) : hdSpoolColor(pid, +h));

/* ------------------------------------------------------------ models */

/* A file added to the plate again may have been exported again with
   other filaments: what was read of it is forgotten. */
function headsForget(path) {
  HD.models.delete(path);
  hdModelNow.delete(path);
}

function headsModel(path) {
  if (!HD.models.has(path)) {
    HD.models.set(path, invoke("slice_model", { path })
      .then((m) => ({ filaments: m?.filaments || [], used: m?.used?.length ? m.used : [1] }))
      .catch(() => ({ filaments: [], used: [1] })));
  }
  return HD.models.get(path);
}
/* Resolved synchronously once loaded (Prepare's drawing loop). */
const hdModelNow = new Map();
function headsModelNow(path) {
  if (!hdModelNow.has(path)) {
    hdModelNow.set(path, null);
    headsModel(path).then((m) => {
      hdModelNow.set(path, m);
      hdEmit({ what: "model", path });
    });
  }
  return hdModelNow.get(path);
}

const hdDist = (a, b) => {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 1e9;
  return (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2;
};

/* Head of each model color: the one chosen, otherwise the most likely
   (same material, closest spool color, a head not already taken). Same rule
   as the slice sheet. { ext: { h, auto } } */
function headsResolve(pid, path, model, slots = headsSlots(pid), n = headsCount(pid)) {
  const out = {};
  const taken = new Set();
  const present = slots.filter((s) => s.present && s.index < n);
  for (const ext of model?.used || [1]) {
    let h = headsHeadOf(pid, path, ext);
    let auto = false;
    if (h == null || h >= n) {
      auto = true;
      const fil = model?.filaments?.find((f) => f.index === ext);
      if (present.length) {
        const kind = (fil?.kind || "").toUpperCase();
        h = present
          .map((s) => ({ h: s.index, score: (kind && (s.kind || "").toUpperCase() === kind ? 0 : 1e7) + (fil?.color ? hdDist(fil.color, s.color) : 0) + (taken.has(s.index) ? 1e8 : 0) }))
          .sort((a, b) => a.score - b.score)[0].h;
      } else h = (ext - 1) % n;
    }
    taken.add(h);
    out[ext] = { h, auto };
  }
  return out;
}

/* ------------------------------------------------------------ profiles */

/* Filament profiles offered for a printer: those of its machine profile. */
function headsLists(pid) {
  if (!HD.lists.has(pid)) {
    HD.lists.set(pid, (async () => {
      let mem = {};
      try {
        mem = JSON.parse(localStorage.getItem("snapstudio.slice") || "{}");
      } catch {}
      const p = P.list.find((x) => x.id === pid);
      const asked = mem["printer:" + pid] || mem.last || null;
      let l = await invoke("slice_lists", { machine: asked });
      const known = (m) => m && l.machines.some((x) => x.name === m);
      const machine = (known(mem["printer:" + pid]) && mem["printer:" + pid]) || (p && matchMachine(p, l.machines, asked));
      if (machine && machine !== asked) l = await invoke("slice_lists", { machine });
      HD.listsNow[pid] = l.filaments || [];
      hdEmit({ pid, what: "lists" });
      return l;
    })().catch((e) => {
      HD.lists.delete(pid);
      throw e;
    }));
  }
  return HD.lists.get(pid);
}

/* Profile of a head: the one chosen, otherwise the closest to its spool. */
function headsProfile(pid, i, list) {
  const chosen = headsFilaments(pid)[i];
  if (chosen && (!list || list.some((p) => p.name === chosen))) return { name: chosen, auto: false };
  const slot = headsSlots(pid).find((s) => s.index === i);
  const auto = slot?.present && list ? bestFilament(slot, list) : null;
  return { name: auto, auto: !!auto };
}

function headsPickProfile(pid, i, anchor, list, all = false) {
  const slot = headsSlots(pid).find((s) => s.index === i);
  const kind = slot?.present ? (slot.kind || "").toUpperCase() : "";
  const auto = slot?.present ? bestFilament(slot, list) : null;
  const item = (p) => ({ value: p.name, label: p.name, sub: [p.ftype, p.vendor].filter(Boolean).join(" · "), badge: p.user ? tr("picker.custom") : p.name === auto ? "auto" : "" });
  let sections;
  if (kind && !all) {
    const same = list.filter((p) => (p.ftype || "").toUpperCase() === kind);
    sections = [
      { label: tr("picker.recommended"), items: same.filter((p) => p.name === auto).map(item) },
      { label: tr("picker.yours"), items: same.filter((p) => p.user).map(item) },
      { label: tr("picker.others", { kind }), items: same.filter((p) => !p.user && p.name !== auto).map(item) },
    ];
  } else {
    const other = tr("feature.other");
    const kinds = [...new Set(list.map((p) => p.ftype || other))].sort();
    sections = kinds.map((k) => ({ label: k, items: list.filter((p) => (p.ftype || other) === k).map(item) }));
  }
  openPicker(anchor, {
    sections,
    value: headsProfile(pid, i, list).name,
    placeholder: tr("picker.search_filament"),
    foot: kind && !all ? { label: tr("picker.all_materials"), onClick: () => headsPickProfile(pid, i, anchor, list, true) } : null,
    onPick: (v) => headsSetFilament(pid, i, v, "heads"),
  });
}

/* ------------------------------------------------- "Heads and spools" view */

const HV = { pid: null };

async function headsShow(pid) {
  HV.pid = pid;
  P.sel = pid;
  switchView("heads");
  hvRender();
  await headsRefreshSlots(pid);
}

async function hvRender() {
  const pid = HV.pid;
  const p = P.list.find((x) => x.id === pid);
  if (!p) return;
  tbSet("heads", tr("heads.title"), p.name || p.host);
  let list = null;
  try {
    list = (await headsLists(pid)).filaments;
  } catch (e) {
    $("hv-msg").textContent = String(e);
  }
  if (HV.pid !== pid) return;
  const slots = headsSlots(pid);
  const n = headsCount(pid);
  $("hv-note").textContent = slots.length ? tr("heads.note") : tr("heads.no_spools");
  $("hv-grid").innerHTML = Array.from({ length: n }, (_, i) => {
    const s = slots.find((x) => x.index === i);
    const present = s?.present;
    const color = present && s.color ? s.color : null;
    const kind = present ? [s.kind, s.sub_type].filter(Boolean).join(" ") || "?" : s ? tr("slice.empty") : tr("slice.spool_unknown");
    const prof = headsProfile(pid, i, list);
    // Same component as the slice sheet's head card.
    return `<div class="sl-headcard${s && !present ? " is-empty" : ""}">
      <div class="sl-spool${color ? "" : " none"}"${color ? ` style="--c:${esc(color)}"` : ""}></div>
      <div class="sl-hc-top"><b>T${i}</b><span>${esc(kind)}</span></div>
      <small class="sl-hc-sub">${esc(present ? [s.vendor, color ? colorName(color) + " " + color.toUpperCase() : ""].filter(Boolean).join(" · ") : "")}</small>
      <span class="sel-row">${s && !present
        // A head known to be empty prints nothing: same as the slice sheet.
        ? `<button class="sl-hc-preset" disabled><span>${esc(tr("slice.head_unused"))}</span></button>`
        : `<button class="sl-hc-preset" data-pick="${i}"${list ? "" : " disabled"} title="${esc(tr("slice.change_filament"))}"><span>${esc(prof.name || "—")}</span>${prof.auto ? "<em>auto</em>" : ""}<i>▾</i></button>`}</span>
    </div>`;
  }).join("");
  $("hv-msg").textContent = list ? "" : $("hv-msg").textContent;
  vsRenderSection(pid);
}

$("hv-grid").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b || b.disabled) return;
  const list = (await headsLists(HV.pid)).filaments;
  headsPickProfile(HV.pid, +b.dataset.pick, b, list);
});
$("hv-refresh").addEventListener("click", () => HV.pid && headsRefreshSlots(HV.pid).then(hvRender));

window.addEventListener("headschange", (e) => {
  if (window.currentView === "heads" && (!e.detail?.pid || e.detail.pid === HV.pid)) hvRender();
});
window.addEventListener("langchange", () => {
  if (window.currentView === "heads") hvRender();
});
