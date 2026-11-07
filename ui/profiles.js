"use strict";
/* Slicing profile details.

   The values come from Rust (`slice_details`): inheritance resolved, plus what
   Snap Studio adds for slicing (quick settings, plate, spool color) — exactly
   what the engine receives. The layout follows Snapmaker Orca's tabs, in the
   interface language: `assets/orca-settings.<lang>.json`, generated from its
   sources by `scripts/gen-orca-settings.py`. */

const INFO_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16m-1 3h2v2h-2zm0 4h2v6h-2z"/></svg>';

const PD = {
  schema: null,
  details: null,
  page: 0,
  bed: null,
  /* Filament profiles already read, for the "Bed at …" line. */
  temps: new Map(),
};

/* Bed temperature by plate type (`curr_bed_type`). */
const BED_TEMP_KEY = {
  "Cool Plate": "cool_plate_temp",
  "Engineering Plate": "eng_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Textured PEI Plate": "textured_plate_temp",
  "Textured Cool Plate": "textured_cool_plate_temp",
  "Supertack Plate": "supertack_plate_temp",
  "Graphic Effect Plate": "graphic_effect_plate_temp",
};

async function pdSchema() {
  if (PD.schema?.lang !== LANG) {
    // A language Orca's settings were not generated for reads them in English.
    const get = (l) => fetch(`assets/orca-settings.${l}.json`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
    PD.schema = await get(LANG).catch(() => get("en"));
    PD.schema.lang = LANG;
  }
  return PD.schema;
}

/* What Snap Studio currently applies in the slice sheet. */
function pdContext(head) {
  const slot = head == null ? null : SL.slots.find((s) => s.index === head);
  return {
    machine: $("s-machine").value,
    simple: currentSimple(),
    overrides: { ...(typeof advOverrides === "function" ? advOverrides() : {}), ...($("s-bed").value ? { curr_bed_type: $("s-bed").value } : {}) },
    color: slot?.present && slot.color ? slot.color : null,
  };
}

function pdFetch(name, head) {
  return invoke("slice_details", { name, ...pdContext(head) });
}

/* ------------------------------------------------------------ values */

/* Orca stores texts (G-code…) C-escaped: "\n" for a line break. */
const unescapeC = (s) =>
  typeof s === "string" && s.includes("\\")
    ? s.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "" })[c] ?? c)
    : s;

/* Displayable unit: "mm or %" → "mm", "money/kg" → "/kg". */
const unitOf = (u) => (u ? u.split(/ ou | or /)[0].replace(/^(argent|money)\//i, "/") : "");

const one = (v) => (Array.isArray(v) ? (v.length && v.every((x) => x === v[0]) ? v[0] : null) : v);

function pdFormat(key, v) {
  const meta = PD.schema.keys[key] || {};
  const fmt = (x) => {
    if (x == null || x === "") return "—";
    if (meta.type === "bool") return tr(x === "1" || x === true || x === "true" ? "common.yes" : "common.no");
    if (meta.type === "enum") return meta.enum?.[x] || x;
    let s = String(x);
    const unit = unitOf(meta.unit);
    if (unit && !s.endsWith("%") && !/[a-z]$/i.test(s)) s += unit.startsWith("/") ? ` ${unit}` : " " + unit;
    return s;
  };
  if (Array.isArray(v)) {
    const same = one(v);
    if (same !== null || v.length <= 1) return fmt(same ?? v[0]);
    // One value per head (machine) or a list (points, speeds…).
    return meta.type === "point" ? v.join(" · ") : v.map((x, i) => `T${i} ${fmt(x)}`).join(" · ");
  }
  return fmt(v);
}

/* Long or multi-line text: shown as a block under the label. */
const isBlock = (v) => typeof v === "string" && (v.includes("\n") || v.length > 80);

/* ------------------------------------------------------------ summary */

function pdTile(label, value, sub = "", strong = false) {
  return `<div class="pd-tile${strong ? " strong" : ""}"><small>${esc(label)}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
}

function pdSummary(d) {
  const v = d.values, f = (k) => pdFormat(k, v[k]);
  if (d.kind === "filament") {
    const bed = PD.bed || "Textured PEI Plate";
    const key = BED_TEMP_KEY[bed];
    const bedLabel = PD.schema.keys.curr_bed_type?.enum?.[bed] || bed;
    const others = Object.entries(BED_TEMP_KEY)
      .filter(([b, k]) => b !== bed && v[k] != null)
      .map(([b, k]) => `${esc(PD.schema.keys.curr_bed_type?.enum?.[b] || b)} ${esc(one(v[k]))} °C`)
      .join(" · ");
    const color = one(v.filament_colour);
    return [
      pdTile(tr("pd.material"), `${color ? `<i class="pd-swatch" style="background:${esc(color)}"></i>` : ""}${esc(f("filament_type"))}`, esc(one(v.filament_vendor) || "")),
      pdTile(tr("slice.nozzle"), `${esc(one(v.nozzle_temperature))} °C`, esc(tr("pd.first_layer", { v: `${one(v.nozzle_temperature_initial_layer)} °C` }))),
      pdTile(tr("slice.plate"), `${esc(one(v[key]) ?? "—")} °C`, `${esc(bedLabel)} · ${esc(tr("pd.first_layer", { v: `${one(v[key + "_initial_layer"]) ?? "—"} °C` }))}`, true),
      pdTile(tr("printers.fan"), `${esc(one(v.fan_min_speed))}–${esc(one(v.fan_max_speed))} %`),
      pdTile(tr("pd.max_flow"), `${esc(one(v.filament_max_volumetric_speed))} mm³/s`),
    ].join("") + (others ? `<div class="pd-others">${esc(tr("pd.other_plates"))} ${others}</div>` : "");
  }
  if (d.kind === "process") {
    return [
      pdTile(tr("printers.layer"), f("layer_height"), esc(tr("pd.first_layer", { v: f("initial_layer_print_height") }))),
      pdTile(tr("slice.walls"), esc(f("wall_loops")), esc(tr("pd.shells", { top: f("top_shell_layers"), bottom: f("bottom_shell_layers") }))),
      pdTile(tr("slice.infill"), esc(f("sparse_infill_density")), esc(f("sparse_infill_pattern"))),
      pdTile(tr("slice.supports"), esc(f("enable_support")), v.enable_support === "1" ? esc(f("support_type")) : ""),
      pdTile(tr("slice.plate"), esc(f("curr_bed_type")), "", true),
      pdTile(tr("feature.outer_wall"), esc(f("outer_wall_speed"))),
    ].join("");
  }
  const area = (v.printable_area || []).map((p) => p.split("x").map(Number));
  const size = area.length
    ? `${Math.round(Math.max(...area.map((p) => p[0])) - Math.min(...area.map((p) => p[0])))} × ${Math.round(Math.max(...area.map((p) => p[1])) - Math.min(...area.map((p) => p[1])))} mm`
    : "—";
  return [
    pdTile(tr("slice.plate"), size, esc(tr("pd.height", { v: f("printable_height") }))),
    pdTile(tr("slice.nozzle"), esc(f("nozzle_diameter")), esc(tr("pd.heads", { n: (v.nozzle_diameter || []).length || 1 }))),
    pdTile(tr("printers.form.model"), esc(v.printer_model || "—")),
    pdTile("Firmware", esc(f("gcode_flavor"))),
  ].join("");
}

/* ------------------------------------------------------------ tabs */

function pdPages(d) {
  const pages = PD.schema[d.kind] || [];
  if (!$("pd-all").checked) return pages;
  const used = new Set(pages.flatMap((p) => p.groups.flatMap((g) => g.keys)));
  const rest = Object.keys(d.values).filter((k) => !used.has(k)).sort();
  return rest.length ? [...pages, { title: tr("pd.other_settings"), groups: [{ title: tr("pd.outside_tabs"), keys: rest }] }] : pages;
}

function pdRow(d, key, line) {
  const meta = PD.schema.keys[key] || {};
  const v = meta.type === "string" ? unescapeC(d.values[key]) : d.values[key];
  const label = line ? `${line} — ${meta.short || meta.label || key}` : meta.label || key;
  const badges =
    (d.snap.includes(key) ? '<span class="pd-badge snap">Snap Studio</span>' : "") +
    (d.custom.includes(key) ? `<span class="pd-badge perso">${esc(tr("picker.custom"))}</span>` : "");
  const value = isBlock(v)
    ? `<pre class="pd-code${v.includes("\n") ? "" : " wrap"}">${esc(v)}</pre>`
    : `<span class="pd-val">${esc(pdFormat(key, v))}</span>`;
  return `<div class="grow-row pd-row${d.snap.includes(key) ? " snap" : ""}${isBlock(v) ? " block" : ""}" title="${esc(meta.tooltip || key)}">
    <span class="k">${esc(label)}${badges}</span>${value}</div>`;
}

function pdRender() {
  const d = PD.details;
  if (!d) return;
  const q = $("pd-search").value.trim().toLowerCase();
  const pages = pdPages(d);
  PD.page = Math.min(PD.page, pages.length - 1);
  $("pd-tabs").classList.toggle("hidden", !!q);
  $("pd-tabs").innerHTML = pages
    .map((p, i) => `<button class="seg-btn${i === PD.page ? " on" : ""}" data-page="${i}">${esc(p.title)}</button>`)
    .join("");
  // Search: across all tabs; otherwise the current tab.
  const shown = q ? pages : [pages[PD.page]];
  const html = [];
  for (const p of shown) {
    for (const g of p.groups) {
      const rows = g.keys
        .filter((k) => k in d.values)
        .filter((k) => {
          if (!q) return true;
          const meta = PD.schema.keys[k] || {};
          return [k, meta.label, g.lines?.[k], pdFormat(k, d.values[k])].some((s) => s && String(s).toLowerCase().includes(q));
        })
        .map((k) => pdRow(d, k, g.lines?.[k]));
      if (rows.length) {
        html.push(`<div class="vp-section">${esc(q ? `${p.title} › ${g.title}` : g.title)}</div><div class="group">${rows.join("")}</div>`);
      }
    }
  }
  $("pd-body").innerHTML = html.join("") || `<div class="pd-empty">${esc(tr(q ? "pd.no_match" : "pd.nothing"))}</div>`;
}

async function pdOpen(name, head) {
  if (!name) return;
  PD.bed = $("s-bed").value;
  $("pd-name").textContent = name;
  $("pd-sub").textContent = tr("pd.reading");
  $("pd-summary").innerHTML = "";
  $("pd-body").innerHTML = "";
  $("pd-search").value = "";
  PD.page = 0;
  openSheet($("pdmodal"));
  try {
    await pdSchema();
    const d = await pdFetch(name, head);
    PD.details = d;
    PD.head = head;
    pdHeader();
    $("pd-summary").innerHTML = pdSummary(d);
    pdRender();
  } catch (e) {
    $("pd-sub").textContent = tr("pd.unreadable", { err: e });
  }
}

/* "Process · Head T1 · System profile · inherits from …" */
function pdHeader() {
  const d = PD.details, head = PD.head;
  const chain = d.chain.slice(1);
  $("pd-sub").textContent = [
    tr("pd.kind." + d.kind),
    head != null && tr("pd.head", { i: head }),
    tr(d.user ? "pd.user" : "pd.system"),
    chain.length && tr("pd.inherits", { chain: chain.join(" → ") }),
  ].filter(Boolean).join(" · ");
}

/* A new language: the Orca schema is reloaded in it, then everything redrawn. */
window.addEventListener("langchange", async () => {
  if ($("pdmodal").classList.contains("hidden") || !PD.details) return;
  await pdSchema();
  pdHeader();
  $("pd-summary").innerHTML = pdSummary(PD.details);
  pdRender();
});

/* ------------------------------------------------------------ bed */

/* Temperatures for the chosen filaments: on each plate tile, on each
   spool card (nozzle); under the tiles, the per-head detail when the
   filaments used disagree. */
async function pdBedLine() {
  const heads = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  if (!heads.length) return;
  const want = heads.join("|");
  PD.want = want;
  for (const name of new Set(heads)) {
    if (PD.temps.has(name)) continue;
    try {
      const d = await invoke("slice_details", { name, machine: $("s-machine").value });
      PD.temps.set(name, d.values);
    } catch {
      PD.temps.set(name, {});
    }
  }
  if (PD.want !== want) return;
  // Heads used by the model; failing that, all of them. Plus those the
  // advanced settings send supports, walls or infill to: the engine heats
  // the plate for every filament the print may use.
  const mapped = [...slUsedSet()].filter((i) => i < heads.length);
  const extra = typeof advHeads === "function" ? Object.values(advHeads()).filter((i) => i < heads.length) : [];
  const used = mapped.length ? [...new Set([...mapped, ...extra])] : heads.map((_, i) => i);

  heads.forEach((name, i) => {
    const el = document.querySelector(`#s-heads [data-temp="${i}"]`);
    const t = one(PD.temps.get(name)?.nozzle_temperature);
    if (el) el.textContent = t ? tr("pd.nozzle_temp", { t }) : "";
  });

  PD.bedTemps = {};
  for (const [bed, key] of Object.entries(BED_TEMP_KEY)) {
    const ts = used.map((i) => +one(PD.temps.get(heads[i])?.[key])).filter((x) => !isNaN(x) && x > 0);
    if (!ts.length) continue;
    const lo = Math.min(...ts), hi = Math.max(...ts);
    PD.bedTemps[bed] = lo === hi ? `${hi} °C` : `${lo}–${hi} °C`;
  }
  document.querySelectorAll("#s-beds [data-bedtemp]").forEach((el) => (el.textContent = PD.bedTemps[el.dataset.bedtemp] || "—"));

  const key = BED_TEMP_KEY[$("s-bed").value];
  const box = $("s-bedtemp");
  const groups = new Map();
  for (const i of used) {
    const t = one((PD.temps.get(heads[i]) || {})[key]);
    if (t == null || t === "") continue;
    groups.set(`${t} °C`, [...(groups.get(`${t} °C`) || []), `T${i}`]);
  }
  box.innerHTML =
    key && groups.size > 1
      ? `${esc(tr("pd.temps_differ"))} ${[...groups].map(([t, h]) => `<b>${esc(t)}</b> (${h.join(", ")})`).join(" · ")}`
      : "";
  if (typeof slSummary === "function") slSummary();
}

/* ------------------------------------------------------------ events */

$("smodal").addEventListener("click", (e) => {
  const b = e.target.closest("[data-info]");
  if (!b) return;
  e.preventDefault();
  if (b.dataset.info === "machine") pdOpen($("s-machine").value, null);
  else if (b.dataset.info === "process") pdOpen($("s-process").value, null);
  else {
    const i = +b.dataset.head;
    pdOpen(document.querySelector(`#s-heads select[data-head="${i}"]`)?.value, i);
  }
});
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-bed, #s-heads select, #s-machine, #s-map select")) pdBedLine();
});
$("pd-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (!b) return;
  PD.page = +b.dataset.page;
  pdRender();
  $("pd-body").scrollTop = 0;
});
$("pd-search").addEventListener("input", pdRender);
$("pd-all").addEventListener("change", pdRender);
$("pd-close").addEventListener("click", () => closeSheet($("pdmodal")));
// At document level: after a click on a tab, focus is no longer in the
// sheet. It closes alone; the slice sheet stays.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("pdmodal").classList.contains("hidden")) return;
  e.stopImmediatePropagation();
  closeSheet($("pdmodal"));
}, true);
