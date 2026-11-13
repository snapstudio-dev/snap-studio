"use strict";
/* Slicing: printer and spools, presets, quick settings, then a preview
   of the result in the viewer, from which the G-code is saved or sent to
   the printer. The Snapmaker Orca engine runs in the background; its
   progress arrives through the `slice-progress` event. */

const SL = {
  lists: null,
  source: null,
  job: null,
  /* Saved printers and the spools read on the chosen one. */
  printers: [],
  slots: [],
  /* Filaments declared by the model: { filaments: [{index, kind, color}], used: [1, 2…] }. */
  models: [],
  /* Last preview produced, awaiting a decision. */
  preview: null,
  /* Choices kept: per machine preset, and the last printer. */
  memory: storedObject("snapstudio.slice"),
};

function rememberFor(machine) {
  return SL.memory[machine] || {};
}

function remember(machine, data) {
  SL.memory[machine] = { ...rememberFor(machine), ...data };
  SL.memory.last = machine;
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

function rememberPrinter(id) {
  SL.memory.printer = id;
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

const fillSelect = (el, items, value) => {
  el.innerHTML = items
    .map((p) => `<option value="${esc(p.name)}"${p.user ? ' data-user="1"' : ""}>${esc(p.name)}${p.user ? " — perso" : ""}</option>`)
    .join("");
  if (value && items.some((p) => p.name === value)) el.value = value;
};

/* ------------------------------------------------------------ colors */

const hexToRgb = (h) => {
  const m = /^#?([0-9a-f]{6})/i.exec(h || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const colorDistance = (a, b) => {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 1e9;
  return (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2;
};
const swatch = (color) =>
  `<span class="swatch${color ? "" : " none"}" style="${color ? `background:${esc(color)}` : ""}"></span>`;

/* ------------------------------------------------------------ opening */

/* Slicing works on the Prepare view's plate. `replaces`: a queued print
   brought back to Prepare, removed from the queue once this slice is sent. */
async function openSlice({ replaces = null } = {}) {
  // A plate from an older version may still be reading its colors: each one
  // needs a head, or the engine gets it on T0.
  if (typeof prRefreshColors === "function") await prRefreshColors();
  const scene = prepareScene();
  if (!scene) return;
  SL.source = scene;
  SL.job = null;
  SL.replaces = replaces;
  SL.touched = new Set();
  slFileLine();
  setSliceMessage("");
  setSliceProgress(null);
  showSliceBusy(false);
  // Thumbnail of the plate's first object, if it can be read.
  const first = scene.items[0]?.path;
  const th = $("s-thumb");
  th.classList.add("hidden");
  if (first) {
    th.onload = () => th.classList.remove("hidden");
    th.onerror = () => th.classList.add("hidden");
    th.src = thumbSrc(first, 160, 0);
  }
  openSheet($("smodal"));

  // Engine expected but missing: the sheet first offers to download it.
  await engStatus();
  if (engNeeded()) {
    slEngineGate(true);
    return;
  }
  slEngineGate(false);
  await sliceLoad();
}

/* Objects on the plate, and those left off it. */
function slFileLine() {
  const scene = SL.source;
  $("s-file").textContent =
    tr("slice.objects", { n: scene.items.length }) +
    (scene.skipped ? " · " + tr("slice.skipped", { n: scene.skipped }) : "");
}

/* The engine is missing: its card replaces the content, slicing waits. */
function slEngineGate(on) {
  $("s-engine").classList.toggle("hidden", !on);
  document.querySelector("#smodal .sl-box").classList.toggle("needs-engine", on);
  $("s-go").disabled = on;
  if (on) {
    engMount($("s-engine"), {
      onDone: () => {
        engUnmount($("s-engine"));
        slEngineGate(false);
        sliceLoad();
      },
    });
  }
}

/* Printers, model colors, profiles: the sheet's content. */
async function sliceLoad() {
  try {
    const [printers, ...models] = await Promise.all([
      invoke("printers_list").catch(() => []),
      ...SL.source.files.map((path) => invoke("slice_model", { path }).catch(() => null)),
    ]);
    SL.printers = printers;
    // Model colors, file by file.
    SL.models = SL.source.files.map((path, i) => {
      const m = models[i];
      return {
        path,
        stem: path.split(/[\\/]/).pop().replace(/\.(3mf|stl)$/i, ""),
        filaments: m?.filaments || [],
        used: m?.used?.length ? m.used : [1],
      };
    });
    slGroupObjects();
    const opts = [{ id: "", name: tr("slice.no_printer") }, ...printers];
    $("s-printer").innerHTML = opts
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.host)}</option>`)
      .join("");
    const keep = printers.some((p) => p.id === SL.memory.printer) ? SL.memory.printer : printers[0]?.id || "";
    $("s-printer").value = keep;
    SL.pstate = {};
    slRenderPrinters();
    await onPrinterChange();
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

const currentPrinter = () => SL.printers.find((p) => p.id === $("s-printer").value) || null;

/* A chosen printer imposes its machine and gets its spools read. */
async function onPrinterChange() {
  const printer = currentPrinter();
  SL.slots = [];
  $("s-heads-note").textContent = printer ? tr("slice.reading_spools") : "";
  slPrinterState(printer ? "checking" : null);
  SL.lists = await invoke("slice_lists", { machine: SL.memory.last || null });

  const machines = SL.lists.machines;
  let machine = SL.memory.last || SL.lists.selected.machine || machines[0]?.name;
  if (printer) {
    const saved = SL.memory["printer:" + printer.id];
    machine = (saved && machines.some((m) => m.name === saved) && saved) || matchMachine(printer, machines, machine) || machine;
  }
  fillSelect($("s-machine"), machines, machine);
  slRenderMachine();
  await onMachineChange(null);

  if (printer) {
    try {
      const st = await invoke("printer_status", { host: printer.host, port: printer.port });
      // Its state holds even if the user moved to another one meanwhile.
      slPrinterState(st.online ? st.state : "offline", printer.id);
      if (currentPrinter() !== printer) return;
      SL.slots = st.filaments || [];
      if (st.online) headsSetSlots(printer.id, SL.slots);
      $("s-heads-note").textContent = tr(!st.online
        ? "prints.unreachable"
        : SL.slots.length ? "slice.spools_read" : "slice.spools_hidden");
    } catch {
      slPrinterState("offline", printer.id);
      if (currentPrinter() !== printer) return;
      $("s-heads-note").textContent = tr("prints.unreachable");
    }
    renderHeads(null, true);
    renderModelMap(true);
  }
}

/* Machine preset whose name contains the printer's model. */
/* On a tie (U1 profiles only differ by nozzle), `preferred` — the profile
   already chosen in Orca or here — wins, then the 0.4 nozzle. */
function matchMachine(printer, machines, preferred) {
  const words = (printer.model || printer.name || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return null;
  const scored = machines
    .map((m) => ({ m, n: words.filter((w) => m.name.toLowerCase().includes(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.m.name.length - b.m.name.length);
  if (!scored.length) return null;
  const top = scored.filter((x) => x.n === scored[0].n).map((x) => x.m.name);
  return top.find((n) => n === preferred) || top.find((n) => /\(0\.4 nozzle\)/i.test(n)) || top[0];
}

/* The machine's plates: the choice sets the bed temperature, read from the
   filament profile for that plate type. The plate set on the chosen
   printer (Control) comes first, then the one last used; `keep`: the
   current choice stays (the plates' names read again). Changed here, it
   is this slice's: the printer's stays. */
function fillBeds(saved, { keep = false } = {}) {
  const sel = $("s-bed");
  const types = SL.lists?.bed_types || [];
  const onPrinter = !keep && typeof headsPlate === "function" ? headsPlate(currentPrinter()?.id) : "";
  const want = types.some((t) => t.value === onPrinter) ? onPrinter : saved;
  sel.innerHTML = types.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join("");
  sel.value = types.some((t) => t.value === want) ? want : SL.lists?.bed_type || types[0]?.value || "";
  // Tiles: one per plate, with the temperature it will give.
  const tex = PLATE_TEX;
  $("s-beds").innerHTML = types
    .map(
      (t) => `<button class="sl-bed${t.value === sel.value ? " on" : ""}" data-bed="${esc(t.value)}">
        <span class="sl-bed-tex ${tex[t.value] || "plain"}"></span>
        <b>${esc(t.label)}</b><small data-bedtemp="${esc(t.value)}">—</small></button>`
    )
    .join("");
}

$("s-beds").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bed]");
  if (!b || b.disabled) return;
  $("s-bed").value = b.dataset.bed;
  document.querySelectorAll("#s-beds .sl-bed").forEach((x) => x.classList.toggle("on", x === b));
  $("s-bed").dispatchEvent(new Event("change", { bubbles: true }));
  slSummary();
});

async function onMachineChange(mem) {
  const machine = $("s-machine").value;
  // Two quick changes (0.4 then 0.6): only the last one's lists may land,
  // or the process list and the remembered adjustments would be the
  // other machine's.
  const seq = (SL.machineSeq = (SL.machineSeq || 0) + 1);
  try {
    const lists = await invoke("slice_lists", { machine });
    if (seq !== SL.machineSeq) return;
    SL.lists = lists;
    const m = mem || rememberFor(machine);
    // The first choice known and offered for this machine; failing that, the
    // standard 0.20 mm profile.
    const known = (n) => n && SL.lists.processes.some((p) => p.name === n);
    fillSelect($("s-process"), SL.lists.processes, [m.process, SL.lists.selected.print].find(known) || slProcessFor(0.2, "Standard"));
    slRenderMachine();
    slQuality();
    fillBeds(m.bed);
    renderHeads(m.filaments || (m.filament ? [m.filament] : null), false);
    renderModelMap(false);
    await loadDefaults(m.simple);
    if (seq !== SL.machineSeq) return;
    spdLoad(m.speed);
    advLoad(m.adv);
  } catch (e) {
    if (seq === SL.machineSeq) setSliceMessage(String(e), "err");
  }
}

/* ------------------------------------------------------------ heads */

const headCount = () => Math.max(1, SL.lists?.extruders || 1);

/* Closest preset to a spool: material required, then vendor, then
   sub-type; a generic preset serves as fallback. */
function bestFilament(slot, list) {
  const kind = (slot.kind || "").trim().toUpperCase();
  if (!kind) return null;
  const vendor = (slot.vendor || "").trim().toLowerCase();
  const sub = (slot.sub_type || "").trim().toLowerCase();
  let best = null, bestScore = -1;
  for (const p of list) {
    const t = (p.ftype || "").toUpperCase();
    if (t !== kind) continue;
    const name = p.name.toLowerCase();
    let score = 10;
    if (vendor && ((p.vendor || "").toLowerCase().includes(vendor) || name.includes(vendor))) score += 5;
    if (sub && name.includes(sub)) score += 3;
    if (!vendor && /generic|générique/.test(name)) score += 2;
    if (!sub && /basic/.test(name)) score += 1;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best?.name || null;
}

/* One card per head: real spool (if known) and filament preset. */
function renderHeads(saved, fromPrinter) {
  const list = SL.lists?.filaments || [];
  const fallback = SL.lists?.selected?.filament || list[0]?.name;
  const prev = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  const rows = [];
  for (let i = 0; i < headCount(); i++) {
    const slot = SL.slots.find((s) => s.index === i);
    const auto = slot && slot.present ? bestFilament(slot, list) : null;
    // The profile set in "Heads and spools" for this printer wins.
    const pid = currentPrinter()?.id;
    const shared = pid ? headsFilaments(pid)[i] : null;
    const chosen = (shared && list.some((p) => p.name === shared) && shared) || (fromPrinter && auto) || saved?.[i] || prev[i] || auto || fallback;
    // Spool card: real color as a flat fill, material, chosen preset.
    const present = slot?.present;
    const kind = present ? [slot.kind, slot.sub_type].filter(Boolean).join(" ") || "?" : slot ? tr("slice.empty") : "";
    const sub = present
      ? slot.vendor || (auto ? "" : tr("slice.no_preset", { kind: slot.kind || "" }))
      : tr(slot ? "slice.no_spool" : "slice.spool_unknown");
    const color = present && slot.color ? slot.color : null;
    // Compact card, two per row: swatch, head and material; vendor and
    // temperature; profile.
    rows.push(`<div class="sl-headcard${slot && !present ? " is-empty" : ""}" data-card="${i}">
      <div class="sl-hc-top"><div class="sl-spool${color ? "" : " none"}"${color ? ` style="--c:${esc(color)}"` : ""}></div><b>T${i}</b><span title="${esc(kind)}">${esc(kind)}</span></div>
      <div class="sl-hc-meta"><small class="sl-hc-sub${present && !auto ? " warn" : ""}" title="${esc(sub)}">${esc(sub)}</small><small class="sl-hc-temp" data-temp="${i}"></small></div>
      <select class="hidden" data-head="${i}" tabindex="-1">${list
        .map((p) => `<option value="${esc(p.name)}"${p.name === chosen ? " selected" : ""}>${esc(p.name)}</option>`)
        .join("")}</select>
      <span class="sel-row"><button class="sl-hc-preset" data-pick-head="${i}" title="${esc(tr("slice.change_filament"))}"></button><button class="btn info-btn" data-info="head" data-head="${i}" title="${esc(tr("slice.profile_details"))}">${INFO_ICON}</button></span>
    </div>`);
  }
  $("s-heads").innerHTML = rows.join("");
  for (let i = 0; i < headCount(); i++) slHeadLabel(i);
  slUsedHeads();
  pdBedLine();
}

/* The plate's objects, identical ones grouped (same file, object and own
   choices): one block of colors each in the table. */
function slGroupObjects() {
  const groups = new Map();
  SL.source.items.forEach((it, i) => {
    const key = `${it.path}#${it.item}#${it.piece ?? ""}#${JSON.stringify(it.heads || {})}`;
    const g = groups.get(key);
    if (g) g.items.push(i);
    else groups.set(key, { key, items: [i], name: it.name, path: it.path, colors: it.colors?.length ? it.colors : [1], obj: { ...it, extruders: it.colors } });
  });
  SL.groups = [...groups.values()];
}

/* Heads chosen for each color of each object on the plate, as Prepare
   resolves them for the sheet's printer. */
function renderModelMap(fromPrinter) {
  const n = headCount();
  const prev = Object.fromEntries(
    [...document.querySelectorAll("#s-map select")].map((s) => [s.dataset.key, +s.value])
  );
  const several = SL.groups.length > 1;
  // Read-only: the heads come from Prepare's objects.
  const pid = currentPrinter()?.id;
  const rows = [];
  SL.groups.forEach((g, gi) => {
    const model = SL.models.find((m) => m.path === g.path);
    const heads = typeof prHeads === "function" ? prHeads(g.obj, pid || "", SL.slots, n) : {};
    const taken = new Set();
    const name = g.items.length > 1 ? `${g.name} ×${g.items.length}` : g.name;
    // Several colors: the object's name heads them, as in Prepare's list.
    const nested = several && g.colors.length > 1;
    if (nested) rows.push(`<div class="sl-mapobj">${esc(name)}</div>`);
    for (const e of g.colors) {
      const key = `${gi}:${e}`;
      const fil = model?.filaments.find((f) => f.index === e);
      let head = heads[e]?.h ?? (fromPrinter ? null : prev[key]);
      // A virtual head (or one deleted since) is kept as Prepare has it.
      if (!vhIs(head) && (head == null || head >= n)) head = autoHead(fil, e, taken);
      taken.add(head);
      const color = g.colors.length === 1 ? "" : tr("slice.color_n", { n: e });
      const label = nested ? color : several ? name : color || name;
      const sub = fil?.kind || "";
      rows.push(`<div class="sl-maprow${nested ? " nested" : ""}">
        ${swatch(fil?.color)}
        <span class="sl-map-label"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>
        <span class="sl-arrow">→</span>
        <span class="sl-tokens" data-tokens="${key}"></span>
        <select class="hidden" tabindex="-1" data-key="${key}" data-group="${gi}" data-ext="${e}">${Array.from({ length: n }, (_, h) => {
          const slot = SL.slots.find((s) => s.index === h);
          const desc = slot ? (slot.present ? ` · ${slot.kind || "?"}` : " · " + tr("printers.empty_tag")) : "";
          return `<option value="${h}"${h === head ? " selected" : ""}>T${h}${esc(desc)}</option>`;
        }).join("")}${vhIs(head) ? `<option value="${head}" selected>${esc(vhName(headsVirtual(pid || ""), head) || "—")}</option>` : ""}</select>
      </div>`);
    }
  });
  $("s-map").innerHTML = rows.join("");
  slOrphanLine();
  slUsedHeads();
  // Bed temperatures depend on the heads used.
  pdBedLine();
}

/* Heads used by the model: their card stands out, the others fade; each
   color's dot takes the targeted spool's. */
function slUsedHeads() {
  const used = slUsedSet();
  document.querySelectorAll("#s-heads .sl-headcard").forEach((c) => c.classList.toggle("unused", used.size > 0 && !used.has(+c.dataset.card)));
  slTokens();
  slSummary();
  return used;
}

/* Most likely head for a model color: same material and closest color
   among the spools present, without reusing a head already taken if
   possible. */
function autoHead(fil, ext, taken) {
  const n = headCount();
  const present = SL.slots.filter((s) => s.present && s.index < n);
  if (present.length) {
    const kind = (fil?.kind || "").toUpperCase();
    const ranked = present
      .map((s) => ({
        h: s.index,
        score: (kind && (s.kind || "").toUpperCase() === kind ? 0 : 1e7) + (fil?.color ? colorDistance(fil.color, s.color) : 0) + (taken.has(s.index) ? 1e8 : 0),
      }))
      .sort((a, b) => a.score - b.score);
    return ranked[0].h;
  }
  return (ext - 1) % n;
}

/* ------------------------------------------------------------ quick settings */

/* Starting values: the preset's, unless the user already chose others for
   this printer. */
async function loadDefaults(saved) {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  if (!machine || !process) return;
  let d = {};
  try {
    d = await invoke("slice_defaults", { machine, process });
  } catch {}
  const v = { ...d, ...(saved || {}) };
  // The layer height is the profile's ("Quality" chips): it is never
  // overridden, so it is read from its name or its values.
  const h = parseProcess(process)?.h ?? d.layer_height;
  $("s-layer-val").textContent = h ? `${fmtDec(+h, 2)} mm` : "—";
  setRange("s-infill", v.infill ?? 15, (x) => Math.round(x) + " %");
  setRange("s-walls", v.walls ?? 2, (x) => String(Math.round(x)));
  $("s-supports").checked = !!(SL.supportsNext ?? v.supports);
  SL.supportsNext = null;
  $("s-brim").checked = !!v.brim;
  slQuality();
  slSummary();
}

document.querySelector("#smodal .sl-stepper").addEventListener("click", (e) => {
  const b = e.target.closest("[data-step]");
  if (!b) return;
  const el = $("s-walls");
  el.value = Math.max(+el.min, Math.min(+el.max, +el.value + +b.dataset.step));
  el.dispatchEvent(new Event("input"));
  slTouch("s-walls");
  slSummary();
});

/* Heads used by the model (colors → heads), a virtual head giving its two
   physical ones; empty if unknown. */
function slUsedSet() {
  return vhPhysical(slMapValues(), headsVirtual(currentPrinter()?.id || ""));
}
/* The map's head values as they are (virtual ones included). */
const slMapValues = () => new Set([...document.querySelectorAll("#s-map select")].map((s) => +s.value));

/* Colors left without a head (a virtual head deleted since): the slice
   waits, Prepare is where to choose one. */
/* The plate prints with a virtual head. */
const slMixes = () => vhUsesVirtual(slMapValues(), headsVirtual(currentPrinter()?.id || ""));
/* Smooth mix applies: a virtual head, the plate's switch on (the default). */
const slSmooth = () => slMixes() && vhSmoothOn(PR);

const slOrphans = () => [...slMapValues()].filter((h) => vhOrphan(headsVirtual(currentPrinter()?.id || ""), h));
function slOrphanLine() {
  const n = slOrphans().length;
  $("s-orphan").classList.toggle("hidden", !n);
  if (!SL.job) $("s-go").disabled = !!n || !$("s-engine").classList.contains("hidden");
}

/* Bottom bar: what will go to the engine, in one line. */
function slSummary() {
  const used = slUsedSet();
  const bed = $("s-bed").selectedOptions[0]?.textContent || "";
  const temp = typeof PD !== "undefined" ? PD.bedTemps?.[$("s-bed").value] : null;
  const n = used.size || 1;
  // Heads chosen for supports, walls or infill: discreetly, beside them.
  const heads = typeof advHeadsSummary === "function" ? advHeadsSummary() : null;
  const parts = [
    tr("slice.sum.spools", { n }),
    bed && `${bed}${temp ? ` ${temp}` : ""}`,
    $("s-layer-val").textContent,
    tr("slice.sum.infill", { v: $("s-infill-val").textContent }),
    tr("slice.sum.walls", { v: $("s-walls-val").textContent }),
    typeof spdSummary === "function" && spdSummary(),
    $("s-supports").checked && [tr("slice.sum.supports"), heads?.supports].filter(Boolean).join(" "),
    $("s-brim").checked && tr("slice.sum.brim"),
    heads?.others,
    slSmooth() && tr("slice.sum.smooth"),
    typeof advCount === "function" && advCount() && tr("slice.sum.adv", { n: advCount() }),
  ].filter(Boolean);
  $("s-summary").innerHTML = parts
    .map((p) => (typeof p === "object" ? `<span class="${esc(p.cls)}">${esc(p.text)}</span>` : `<span>${esc(p)}</span>`))
    .join("");
  // A virtual head mixes evenly with thin layers (Snapmaker's advice).
  const layer = parseProcess($("s-process").value)?.h;
  $("s-vlayer").classList.toggle("hidden", !(slMixes() && layer > 0.12));
  // What goes to the engine changed: the prime tower's materials too, and
  // its place.
  if (typeof advRenderTower === "function") advRenderTower();
  if (typeof prTowerSheetWarning === "function") prTowerSheetWarning();
}

/* Adjustments touched by hand: they survive a profile change. */
const SL_TOUCH = { "s-infill": "infill", "s-walls": "walls", "s-supports": "supports", "s-brim": "brim" };
function slTouch(id) {
  (SL.touched ||= new Set()).add(SL_TOUCH[id]);
}

$("smodal").addEventListener("input", (e) => {
  if (e.target.id in SL_TOUCH && e.isTrusted) slTouch(e.target.id);
  if (e.target.matches("#s-infill, #s-supports, #s-brim")) slSummary();
});
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-map select")) slUsedHeads();
  if (e.target.matches("#s-supports, #s-brim")) slSummary();
  // Supports on or off change the heads counted for the plate.
  if (e.target.matches("#s-supports")) pdBedLine();
  // Switched by hand: kept at once, not only at the next slice, as
  // Prepare's badge reads it (and its button writes it).
  if (e.target.matches("#s-supports") && e.isTrusted) slSetSupports(e.target.checked);
});

function setRange(id, value, fmt) {
  const el = $(id);
  el.value = value;
  el.dataset.fmt = "1";
  $(id + "-val").textContent = fmt(+el.value);
  el.oninput = () => ($(id + "-val").textContent = fmt(+el.value));
}

/* Supports on or off for the next slices, as if switched by hand: on the
   sheet, and kept with the machine's adjustments (or, before any, for the
   sheet's next loading). Prepare's hint follows. */
function slSetSupports(on) {
  $("s-supports").checked = on;
  slTouch("s-supports");
  // An open sheet updates its summary; a closed one reloads from memory.
  if (!$("smodal").classList.contains("hidden")) $("s-supports").dispatchEvent(new Event("change", { bubbles: true }));
  const machine = $("s-machine").value || SL.memory.last;
  if (machine) {
    const m = rememberFor(machine);
    remember(machine, { simple: { ...(m.simple || {}), supports: on } });
  } else SL.supportsNext = on;
  if (typeof prHintRefresh === "function") prHintRefresh();
}

/* Whether the next slice has supports: the machine's remembered
   adjustments; off before any (the profiles' default). */
function slSupportsNext() {
  const m = SL.memory.last ? rememberFor(SL.memory.last) : {};
  return !!(m.simple?.supports ?? SL.supportsNext);
}

function currentSimple() {
  return {
    infill: +$("s-infill").value,
    walls: +$("s-walls").value,
    supports: $("s-supports").checked,
    brim: $("s-brim").checked,
  };
}

/* ------------------------------------------------------------ execution */

function setSliceMessage(text, cls) {
  const el = $("s-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}

/* Progress bar; `null` hides it. */
/* The bar never goes back (a late event, a rounding): SL.pct holds the
   furthest point; null hides it and starts over. */
function setSliceProgress(pct) {
  $("s-progress").classList.toggle("hidden", pct == null);
  SL.pct = pct == null ? 0 : Math.max(SL.pct || 0, Math.min(100, pct));
  if (pct != null) $("s-progress").firstElementChild.style.width = Math.max(2, SL.pct) + "%";
}

function showSliceBusy(busy) {
  $("s-go").classList.toggle("hidden", busy);
  $("s-cancel").classList.toggle("hidden", busy);
  $("s-stop").classList.toggle("hidden", !busy);
  document
    .querySelectorAll("#smodal select, #smodal input, #smodal .sl-areas button:not(.info-btn), #s-tower button, #s-tower-place button")
    .forEach((el) => (el.disabled = busy));
  if (busy) closePicker();
  // Unlocked: the chips of empty heads must stay inactive, and the prime
  // tower's switch while no tower can be printed.
  else {
    slTokens();
    $("s-tower-sw").disabled = !!prTowerState().reason;
  }
}

async function startSlice() {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  const filaments = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  if (!machine || !process || !filaments.length || filaments.some((f) => !f)) {
    setSliceMessage(tr("slice.need_profiles"), "err");
    return;
  }
  if (slOrphans().length) {
    setSliceMessage(tr("slice.orphan"), "err");
    return;
  }
  // Model color → head, object by object; entry i is about color i + 1.
  const maps = SL.groups.map(() => []);
  document.querySelectorAll("#s-map select").forEach((s) => (maps[+s.dataset.group][+s.dataset.ext - 1] = +s.value));
  for (const m of maps) for (let i = 0; i < m.length; i++) if (m[i] == null) m[i] = 0;
  // Virtual heads: after the physical ones (head n + k), their mixes sent.
  const pid = currentPrinter()?.id || "";
  // "By height" mode: the plate's plan (prepare-heights.js), its heads used too.
  const byHeight = typeof PR !== "undefined" && PR.assoc === "height" && PR.hz;
  const hzHeadsUsed = byHeight ? hzPlanHeads(PR.hz) : [];
  const used = new Set([...maps.flat(), ...hzHeadsUsed]);
  const eng = vhEngine(used, headsVirtual(pid), filaments.length);
  const virtual_heads = eng.heads.map((v) => ({ a: v.a, b: v.b, pct: v.pct, color: headsVirtualColor(pid, v) || null }));
  const groupOf = (i) => SL.groups.findIndex((g) => g.items.includes(i));
  const scene = SL.source.items.map(({ id, colors, heads, base, hc, hcl, ...it }, i) => ({ ...it, extruder_map: (maps[groupOf(i)] || []).map(eng.index) }));
  // Colour changes at a height (HueForge): the plate's single head
  // switched from each height up, by the engine.
  const plate = { pillars: prPillarsRequest().length > 0, byObject: String(prTowerSetting("print_sequence") || "") === "by object" };
  let heights = byHeight
    ? hzRequest(PR.hz, SL.source.items.map((it) => ({ base: it.base, scale: it.scale })), plate)
    : hcRequest(SL.source.items.map((it, i) => ({ base: it.base, hc: it.hc, hcl: it.hcl, scale: it.scale, map: scene[i].extruder_map })), plate);
  // The plan's heads as the engine numbers them (virtual heads after the
  // physical ones); its layers are imposed (hzOverrides), not checked.
  if (byHeight && heights.changes) heights = { changes: heights.changes.map((c) => ({ ...c, head: eng.index(c.head) })), layers: null };
  if (heights.error) {
    setSliceMessage(tr(`slice.heights.${heights.error}`), "err");
    return;
  }
  const heads = [...vhPhysical(used, headsVirtual(pid))];
  const empty = heads.filter((h) => SL.slots.find((s) => s.index === h && !s.present));
  if (empty.length) {
    setSliceMessage(tr("slice.head_empty", { heads: empty.map((h) => "T" + h).join(", ") }), "err");
    return;
  }
  const colors = filaments.map((_, i) => {
    const slot = SL.slots.find((s) => s.index === i);
    return slot?.present && slot.color ? slot.color : null;
  });

  // The prime tower off the plate: the engine would print it there.
  if (prTowerBlocks()) {
    setSliceMessage(tr("prepare.tower.off_plate"), "err");
    return;
  }
  // The profile's values the Speed adjustment works from must be this
  // profile's.
  await ADV.ready?.catch(() => {});
  const simple = currentSimple();
  const bed = $("s-bed").value;
  // The plate against the materials of the heads used (plate.js): a
  // warning can stop here, the glue tip is shown.
  const ftypeOf = spFtypeOf(currentPrinter()?.id || "");
  const families = heads.map((h) => spMaterialFamily(ftypeOf(filaments[h]) || spMaterialFromName(filaments[h])));
  if (!(await plateAsk({ plate: bed, families, pid: currentPrinter()?.id }))) return;
  remember(machine, { process, filaments, simple, bed, adv: SL.adv || {}, speed: SL.speed });
  if (typeof prHintRefresh === "function") prHintRefresh();
  const printer = currentPrinter();
  rememberPrinter(printer?.id || "");
  if (printer) {
    SL.memory["printer:" + printer.id] = machine;
    localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
  }

  showSliceBusy(true);
  setSliceMessage(tr("slice.preparing"), "busy");
  setSliceProgress(null);
  setSliceProgress(0);
  SL.starting = true;
  SL.early = [];
  // The tower's real size comes with the preview: it is this plate's.
  SL.towerKey = prTowerKey();
  try {
    const job = await invoke("slice_start", {
      request: {
        source: "", scene, name: SL.source.name, machine, process, filaments, simple, colors, virtual_heads,
        // One tower per material: the pillars, generated at every slice.
        pillars: prPillarsRequest(),
        ...(heights.changes.length ? { height_changes: heights.changes, height_layers: heights.layers || undefined } : {}),
        // Each layer of a virtual head split between its two heads: sent
        // with virtual heads only (otherwise the request is unchanged).
        ...(virtual_heads.length && vhSmoothOn(PR) ? { smooth_mix: true } : {}),
        overrides: { ...advOverrides(), ...spdOverrides(), ...prTowerOverrides(), ...(typeof hzOverrides === "function" ? hzOverrides() : {}), ...(bed ? { curr_bed_type: bed } : {}) },
      },
    });
    const bedLabel = $("s-bed").selectedOptions[0]?.textContent || "";
    // The plate's objects go with the print: the spool check can bring a
    // queued print back to Prepare.
    const plate = typeof prPlateOf === "function" ? prPlateOf(SL.source.items.map((it) => it.id)) : [];
    SL.request = { printer: printer?.id || "", filaments, colors, machine, process, bed, bedLabel, plate };
    SL.job = job;
    // What the job said before its id was known.
    const early = SL.early.filter((p) => p.id === job);
    SL.starting = false;
    SL.early = [];
    for (const p of early) await onSliceProgress({ payload: p });
  } catch (e) {
    SL.starting = false;
    SL.early = [];
    showSliceBusy(false);
    setSliceProgress(null);
    setSliceMessage(String(e), "err");
  }
}

async function onSliceProgress(e) {
  const p = e.payload;
  // Rust emits from the moment the job is spawned, before `slice_start`
  // has answered with its id: what arrives meanwhile is kept, and replayed
  // once the id is known (an early error would otherwise be lost, the
  // sheet stuck on "Preparing").
  if (!SL.job) {
    if (SL.starting) SL.early.push(p);
    return;
  }
  if (p.id !== SL.job) return;
  if (p.phase === "preparation") {
    setSliceMessage(tr("slice.preparing_model"), "busy");
  } else if (p.phase === "slicing") {
    if (p.percent != null) {
      // The engine's stage (its log, Rust's Tracker) and the job's share.
      stopElapsed();
      setSliceProgress(p.percent);
      const stage = p.stage ? tr(`slice.stage.${p.stage}`) : tr("slice.slicing");
      setSliceMessage(`${stage} ${Math.round(SL.pct)} %`, "busy");
    } else {
      tickElapsed(p.elapsed_s);
    }
  } else if (p.phase === "preview") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    const job = SL.job;
    SL.job = null;
    closeSheet($("smodal"));
    showPreview(job, p);
  } else if (p.phase === "cancelled") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    SL.job = null;
    setSliceMessage(tr("slice.stopped"), "");
  } else if (p.phase === "error") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    SL.job = null;
    setSliceMessage(p.message || tr("slice.engine_silent"), "err");
  }
}
listen("slice-progress", onSliceProgress);

/* The counter runs in the UI when the engine reports no progress. */
let elapsedTimer = 0;
function tickElapsed(from) {
  stopElapsed();
  const t0 = Date.now() - from * 1000;
  elapsedTimer = setInterval(() => {
    setSliceMessage(`${tr("slice.slicing")} ${Math.round((Date.now() - t0) / 1000)} s`, "busy");
  }, 500);
}
function stopElapsed() {
  clearInterval(elapsedTimer);
  elapsedTimer = 0;
}

/* ------------------------------------------------------------ preview */

function showPreview(job, p) {
  const req = SL.request || { filaments: [], colors: [] };
  prTowerSliced(p.stats?.tower, SL.towerKey);
  SL.preview = { job, source: SL.source, gcode: p.gcode, stats: p.stats || {}, printer: req.printer, saved: null, replaces: SL.replaces };
  const toolColors = req.filaments.map((_, i) => hexToRgb(req.colors[i]));
  const toolNames = req.filaments.map((name) => name.replace(/\s*@.*$/, ""));
  openPreview({
    path: p.gcode,
    name: SL.source.name + " — " + tr("ia.preview").toLowerCase(),
    stats: p.stats || {},
    toolColors,
    toolNames,
    onSend: openSend,
    onSave: savePreview,
    onEdit: () => editInPrepare(),
    // The engine's warning that objects need supports, and its quick fix.
    warnings: p.warnings || [],
    onSupports: sliceWithSupports,
    // Closing the preview deletes it: what was saved stays.
    onClose: () => {
      if (SL.preview) invoke("slice_discard", { id: SL.preview.job }).catch(() => {});
      SL.preview = null;
    },
  });
}

/* Back to the plate this preview was sliced from, Slice sheet open. A
   printer given: its spools are those read for the slice. */
function editInPrepare(printerId) {
  const replaces = SL.preview?.replaces || null;
  closeViewer();
  switchView("prepare");
  if (printerId) rememberPrinter(printerId);
  SL.opening = openSlice({ replaces });
}

/* The engine said objects need supports: back to this plate's Slice
   sheet, supports on, and slice again. */
async function sliceWithSupports() {
  editInPrepare();
  await SL.opening;
  // The sheet did not open (an empty plate), or it asks for the engine.
  if ($("smodal").classList.contains("hidden") || engNeeded()) return;
  slSetSupports(true);
  startSlice();
}

async function savePreview() {
  const pv = SL.preview;
  if (!pv) return;
  try {
    const path = await invoke("slice_save", { id: pv.job, dir: null });
    pv.saved = path;
    toast(tr("slice.gcode_saved", { name: path.split(/[\\/]/).pop() }));
    await refresh();
  } catch (e) {
    toast(String(e), true);
  }
}

/* ------------------------------------------------------------ sending */

async function openSend() {
  const pv = SL.preview;
  if (!pv) return;
  SL.remote = null;
  if (!SL.printers.length) SL.printers = await invoke("printers_list").catch(() => []);
  if (!SL.printers.length) {
    toast(tr("send.no_printer"), true);
    return;
  }
  $("snd-file").textContent = pv.source.name + (pv.stats.print_time_s ? " · " + fmtDuration(pv.stats.print_time_s) : "");
  SL.sendPid = SL.printers.some((p) => p.id === pv.printer) ? pv.printer : SL.printers[0].id;
  renderSendPrinters();
  // Options always unticked on opening, as requested.
  ["snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).checked = false));
  setSendBusy(false);
  setSendMessage("");
  setSendProgress(null);
  openSheet($("sendmodal"));
  checkSendPrinter();
}

/* The same sheet for a file already on a printer (its Files view). Start
   it there, queue it, or print it on another printer: `printer` holds the
   file, chosen by default. `file`: a RemoteFile. */
async function openSendRemote(printer, file, thumb) {
  SL.printers = await invoke("printers_list").catch(() => SL.printers);
  if (!SL.printers.some((p) => p.id === printer.id)) SL.printers = [printer, ...SL.printers];
  SL.remote = { printer, file, thumb, stats: pflSendStats(file.meta) };
  const st = SL.remote.stats;
  // The metadata does not say which heads the file uses: the G-code is
  // read before anything is checked or sent (a multi-color file must not
  // be prepared as a single-color one).
  if (!file.meta?.tools_known) {
    const remote = SL.remote;
    remote.toolsReady = invoke("pf_tools", { printerId: printer.id, path: file.path, modified: file.modified || 0 })
      .then((tools) => {
        if (tools?.length) remote.stats.tools = tools;
        if (SL.remote === remote && !$("sendmodal").classList.contains("hidden")) checkSendPrinter();
      })
      .catch(() => {});
  }
  $("snd-file").textContent = pflName(file.path) + (st.print_time_s ? " · " + fmtDuration(st.print_time_s) : "");
  SL.sendPid = printer.id;
  renderSendPrinters();
  ["snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).checked = false));
  setSendBusy(false);
  setSendMessage("");
  setSendProgress(null);
  openSheet($("sendmodal"));
  checkSendPrinter();
}

const sendPrinter = () => SL.printers.find((p) => p.id === SL.sendPid);

/* The printer picker: the print queue's chips. */
function renderSendPrinters() {
  $("snd-printer").innerHTML = printerChips(SL.printers, SL.sendPid, !!SL.sending);
}
function setSendPrinter(id) {
  if (!id || id === SL.sendPid || SL.sending) return;
  SL.sendPid = id;
  renderSendPrinters();
  checkSendPrinter();
}
const sendStats = () => (SL.remote ? SL.remote.stats : SL.preview?.stats);

/* Printer free: start, or queue. Busy or unreachable: only the queue. */
function setSendMode(mode) {
  SL.sendMode = mode;
  $("snd-go").textContent = tr(mode === "queue" ? "send.add_queue" : "send.go");
  $("snd-queue").classList.toggle("hidden", mode !== "launch");
}

/* State of the target printer: only start on an idle machine. */
async function checkSendPrinter() {
  const p = sendPrinter();
  const el = $("snd-state");
  // The bed out of tolerance: a discreet banner (Care & Tuning › Bed Leveling).
  if (typeof bmSendBanner === "function") bmSendBanner(p?.id);
  $("snd-go").disabled = true;
  setSendMode("launch");
  $("snd-queue").classList.add("hidden");
  if (!p) return;
  el.className = "pf-test busy";
  el.textContent = tr("send.querying");
  const st = await invoke("printer_status", { host: p.host, port: p.port }).catch(() => null);
  if (sendPrinter() !== p) return;
  // The chip shows the state just read.
  SL.pstate = { ...(SL.pstate || {}), [p.id]: st?.online ? st.state : "offline" };
  renderSendPrinters();
  if (!st || !st.online) {
    el.className = "pf-test err";
    el.textContent = tr("send.no_answer", { name: p.name });
    setSendMode("queue");
    $("snd-go").disabled = false;
    return;
  }
  if (["printing", "paused"].includes(st.state)) {
    // The end time inside the sentence, worded by each language.
    const job = (st.job || "").replace(/\.gcode$/, "");
    el.className = "pf-test warn";
    el.textContent = st.remaining_s
      ? tr("send.busy_until", { name: p.name, job, time: fmtClock(Date.now() + st.remaining_s * 1000) })
      : tr("send.busy", { name: p.name, job });
    setSendMode("queue");
    $("snd-go").disabled = false;
    return;
  }
  // G-code heads with no spool on this machine: to flag before sending.
  const tools = sendStats()?.tools || [];
  const missing = tools.filter((t) => (st.filaments || []).some((f) => f.index === t && !f.present));
  el.className = "pf-test" + (missing.length ? " err" : " ok");
  el.textContent = missing.length
    ? tr("send.missing", { heads: missing.map((t) => "T" + t).join(", "), name: p.name })
    : tr("send.ready", { name: p.name });
  // With the spool check, another loaded spool can stand in for an empty head.
  $("snd-go").disabled = missing.length > 0 && !spEnabled();
  setSendMode("launch");
}

function setSendMessage(text, cls) {
  const el = $("snd-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}
function setSendProgress(pct) {
  $("snd-progress").classList.toggle("hidden", pct == null);
  if (pct != null) $("snd-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
}
function setSendBusy(busy) {
  SL.sending = busy;
  $("snd-go").classList.toggle("hidden", busy);
  // After a failure, the earlier choices come back (including "Add to Queue").
  if (busy) $("snd-queue").classList.add("hidden");
  else if (SL.sendMode) setSendMode(SL.sendMode);
  $("snd-cancel").classList.toggle("hidden", busy);
  ["snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).disabled = busy));
  renderSendPrinters();
}

/* Returns how it ended, for Snappy (snappy.js): { sent, job }, { cancelled }
   or { error }. */
async function sendPrint(queue = SL.sendMode === "queue") {
  if (SL.remote) return sendRemote(queue);
  const pv = SL.preview, p = sendPrinter();
  if (!pv || !p || (!queue && $("snd-go").disabled)) return { error: "not ready to send" };
  const r = SL.request || {};
  const tools = pv.stats.tools?.length ? pv.stats.tools : [0];
  // Spools checked when the print starts now; a queued job is checked when
  // it starts from the queue.
  let map = [];
  if (!queue) {
    if (SL.checking) return { error: "a check is already running" };
    SL.checking = true;
    // The plate is still the one in Prepare: it can be sliced again there.
    const print = { thumb: thumbSrc(pv.gcode, 240, 0), name: pv.source.name, printer: p.name || p.host };
    let ok;
    try {
      ok = await spCheckBeforeStart(p, { tools, profile: r, stats: pv.stats, canEdit: true, print });
    } catch (e) {
      setSendMessage(String(e.message || e), "err");
      return { error: String(e.message || e) };
    } finally {
      SL.checking = false;
    }
    if (!ok) return { cancelled: true };
    if (ok.edit) {
      closeSheet($("sendmodal"));
      editInPrepare(p.id);
      return { cancelled: true };
    }
    map = ok.map;
  }
  setSendBusy(true);
  setSendProgress(queue ? null : 0);
  setSendMessage(tr(queue ? "send.queueing" : "send.preparing"), "busy");
  try {
    const id = await invoke("print_send", {
      request: {
        printer_id: p.id,
        job: pv.job,
        queue,
        tools,
        map,
        options: {
          bed_leveling: $("snd-level").checked,
          flow_calibration: $("snd-flow").checked,
          timelapse: $("snd-timelapse").checked,
        },
        profile: {
          machine: r.machine || "",
          process: r.process || "",
          filaments: r.filaments || [],
          bed: r.bed || null,
          bed_label: r.bedLabel || null,
          colors: r.colors || [],
          plate: r.plate?.length ? r.plate : null,
        },
      },
    });
    // A queued print sliced again: the new one takes its place, if it is
    // still waiting.
    if (pv.replaces) {
      await pjLoad();
      if (pjQueue().some((j) => j.id === pv.replaces)) await invoke("job_remove", { id: pv.replaces }).catch(() => {});
    }
    if (!queue) {
      // The printers snapshot may still say "free": the record is designated by
      // the job, not by the printer.
      await pjLoad();
      pjShow(id ? "job:" + id : null);
    } else {
      setSendBusy(false);
      closeSheet($("sendmodal"));
      closeViewer();
      await pjLoad();
      const pos = pjQueue().findIndex((j) => j.id === id) + 1;
      toast(tr("send.queued", { name: p.name }) + (pos ? ` (${tr("prints.position", { n: pos })})` : ""));
      pjShow("job:" + id);
    }
    return { sent: true, job: id };
  } catch (e) {
    setSendBusy(false);
    setSendProgress(null);
    setSendMessage(String(e), "err");
    return { error: String(e) };
  }
}

/* A file already on a printer: started (after the same spool check),
   queued, or sent to another printer, as after a slice. */
async function sendRemote(queue) {
  const { printer: src, file, stats, thumb } = SL.remote;
  const p = sendPrinter();
  if (!p || (!queue && $("snd-go").disabled) || SL.checking) return;
  if (SL.remote.toolsReady) {
    SL.checking = true;
    setSendMessage(tr("pfiles.reading_tools"), "busy");
    await SL.remote.toolsReady;
    SL.checking = false;
    setSendMessage("");
  }
  let map = [];
  if (!queue) {
    SL.checking = true;
    let ok;
    try {
      // The plate it was sliced for, from the end of the file (read once).
      if (stats.bed_type === undefined) stats.bed_type = await invoke("pf_plate", { printerId: src.id, path: file.path, modified: file.modified || 0 }).catch(() => null);
      ok = await spCheckBeforeStart(p, { tools: stats.tools, profile: {}, stats, canEdit: false, print: { thumb, name: pflName(file.path), printer: p.name || p.host } });
    } catch (e) {
      setSendMessage(String(e.message || e), "err");
      return;
    } finally {
      SL.checking = false;
    }
    if (!ok) return;
    map = ok.map || [];
  }
  setSendBusy(true);
  setSendProgress(null);
  setSendMessage(tr(queue ? "send.queueing" : "send.preparing"), "busy");
  try {
    const id = await invoke("pf_print", {
      request: {
        source_id: src.id,
        path: file.path,
        printer_id: p.id,
        queue,
        tools: stats.tools,
        map,
        options: {
          bed_leveling: $("snd-level").checked,
          flow_calibration: $("snd-flow").checked,
          timelapse: $("snd-timelapse").checked,
        },
      },
    });
    await pjLoad();
    if (!queue) pjShow(id ? "job:" + id : "live:" + p.id);
    else {
      setSendBusy(false);
      closeSheet($("sendmodal"));
      const pos = pjQueue().findIndex((j) => j.id === id) + 1;
      toast(tr("send.queued", { name: p.name }) + (pos ? ` (${tr("prints.position", { n: pos })})` : ""));
      pjShow("job:" + id);
    }
  } catch (e) {
    setSendBusy(false);
    setSendProgress(null);
    setSendMessage(String(e), "err");
  }
}

listen("print-send", (e) => {
  if (!SL.sending) return;
  const s = e.payload;
  if (s.phase === "check") setSendMessage(tr("send.checking"), "busy");
  else if (s.phase === "fetch") setSendMessage(tr("send.fetching"), "busy");
  else if (s.phase === "prepare") setSendMessage(tr("send.preparing"), "busy");
  else if (s.phase === "upload") {
    setSendProgress(s.percent);
    setSendMessage(tr("send.uploading", { p: Math.round(s.percent || 0) }), "busy");
  } else if (s.phase === "done") {
    const p = sendPrinter();
    setSendBusy(false);
    closeSheet($("sendmodal"));
    toast(tr("send.started", { name: p?.name || tr("slice.printer") }));
    if (s.message) startWarning(s.message);
    // From a printer's files, the slice preview (if any) stays as it was.
    if (!SL.remote) closeViewer();
  }
});

/* ------------------------------------------------------------ events */

window.addEventListener("langchange", () => {
  if ($("smodal").classList.contains("hidden") || !SL.source) return;
  slFileLine();
  if (SL.lists) {
    renderHeads(null, false);
    renderModelMap(false);
    // Plate names come from Rust, in the language it now speaks.
    invoke("slice_lists", { machine: $("s-machine").value })
      .then((l) => {
        SL.lists.bed_types = l.bed_types;
        fillBeds($("s-bed").value, { keep: true });
        pdBedLine();
      })
      .catch(() => {});
  }
  slSummary();
});

$("s-printer").addEventListener("change", onPrinterChange);
$("s-machine").addEventListener("change", () => onMachineChange(null));
// Changing profile (height, style) applies its values, except for the
// adjustments the user already touched in this sheet. Snappy waits for it
// (snappy.js) before changing anything else.
function slProcessChanged() {
  const cur = currentSimple();
  return loadDefaults(Object.fromEntries([...(SL.touched || [])].map((k) => [k, cur[k]]))).then(advRefreshDefaults);
}
$("s-process").addEventListener("change", slProcessChanged);
$("s-go").addEventListener("click", startSlice);
$("s-cancel").addEventListener("click", () => closeSheet($("smodal")));
$("s-stop").addEventListener("click", () => {
  if (SL.job) invoke("slice_cancel", { id: SL.job });
});
document.addEventListener("keydown", (e) => {
  if ($("smodal").classList.contains("hidden")) return;
  // A profile's details, open on top, keep their keys.
  if (!$("pdmodal").classList.contains("hidden")) return;
  if (!$("advsave").classList.contains("hidden")) return;
  // The advanced sub-panel closes first; its fields keep Enter.
  if (!$("s-adv").classList.contains("hidden")) {
    if (e.key === "Escape") advClose();
    return;
  }
  if (e.key === "Escape" && !SL.job) closeSheet($("smodal"));
  if (e.key === "Enter" && !SL.job && e.target.tagName !== "SELECT") startSlice();
});

$("snd-printer").addEventListener("click", (e) => setSendPrinter(e.target.closest("[data-printer]")?.dataset.printer));
$("snd-go").addEventListener("click", () => sendPrint());
$("snd-cancel").addEventListener("click", () => closeSheet($("sendmodal")));
$("snd-queue").addEventListener("click", () => sendPrint(true));
document.addEventListener("keydown", (e) => {
  if ($("sendmodal").classList.contains("hidden") || SL.sending) return;
  // The spool sheet, open on top, keeps its keys.
  if (!$("spmodal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeSheet($("sendmodal"));
});

/* Colors left without a head: Prepare is where to choose one. */
$("s-orphan-go").addEventListener("click", () => {
  closeSheet($("smodal"));
  switchView("prepare");
});
/* A virtual head deleted (a spool unloaded) while the sheet is open: its
   colors wait for a head. */
window.addEventListener("headschange", (e) => {
  if ($("smodal").classList.contains("hidden") || !["virtual", "mix"].includes(e.detail?.what)) return;
  slTokens();
  slOrphanLine();
  slSummary();
});
