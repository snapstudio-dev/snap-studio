"use strict";
/* Prepare, "By height" mode (HueForge, step 2): the plate prints with one
   head and changes head, or pauses for a spool swap, at heights. The plan
   is `PR.hz` (prepare.js, heights-logic.js): the list above the objects,
   the ruler beside the view, the model tinted by height, the import of a
   HueForge describe or 3MF. The engine gets it at the slice (slice.js). */

/* The layers the heights land on: the imported file's, else the slice
   profile's (the engine snaps them again to the profile it slices with). */
function hzLayers() {
  const l = PR.hz?.layers;
  if (l?.layer_height > 0) return { lh: l.layer_height, first: l.first_layer || l.layer_height };
  const lh = typeof prTowerNum === "function" ? prTowerNum("layer_height", 0.2) : 0.2;
  const first = typeof prTowerNum === "function" ? prTowerNum("initial_layer_print_height", lh) : lh;
  return { lh, first };
}
const hzSnapZ = (z) => {
  const { lh, first } = hzLayers();
  return hzSnap(z, lh, first);
};

/* The tallest object on the plate (mm), for the ruler and a new change. */
function hzTop() {
  let top = 0;
  for (const o of PR.objects) {
    if (bedState(o) === "out") continue;
    top = Math.max(top, (o.size?.[2] || 0) * Math.abs(o.scale?.[2] ?? 1));
  }
  return top;
}

/* The printer's loaded heads with their colours, for the import. */
function hzHeads() {
  const pid = typeof headsActive === "function" ? headsActive() : "";
  return headsSlots(pid)
    .filter((s) => s.present)
    .map((s) => ({ head: s.index, color: s.color || null }));
}

/* The plan's heads whose virtual head was deleted since: the slice waits. */
function hzOrphans() {
  if (typeof headsActive !== "function" || !PR.hz) return [];
  const list = headsVirtual(headsActive());
  return hzPlanHeads(PR.hz).filter((h) => vhOrphan(list, h)).map((h) => ({ head: h }));
}

/* "By height" without a plan (just switched, or an undo back to before
   it was made): an empty one, starting with `base`, else the head the
   first object has of its own. */
function hzEnsure(base = null) {
  if (PR.assoc !== "height" || PR.hz) return;
  const o = PR.objects.find((x) => bedState(x) !== "out");
  const own = o ? Object.values(o.heads || {})[0] : null;
  PR.hz = { base: base ?? own ?? 0, changes: [], layers: null, src: null };
}

/* One undoable edit of the plan; what the import said of its heights no
   longer holds. */
function hzEdit(fn) {
  hzEnsure();
  if (!PR.hz) return;
  prRemember();
  PR.hz = { ...PR.hz, changes: PR.hz.changes.map((c) => ({ ...c })) };
  fn(PR.hz);
  if (PR.hz.warnings) PR.hz.warnings = PR.hz.warnings.filter((w) => w.kind !== "gap");
  PR.hz.changes.sort((a, b) => a.z - b.z);
  prSave();
  prRenderInspector();
  prSchedule();
}

const hzFmt = (z) => fmtNum(Math.round(z * 1000) / 1000, { maximumFractionDigits: 3 });

/* The list above the objects: the start, then each change with its height,
   layer, head (or pause), then the layers and what the import said. */
function hzBanner(live, slots, n) {
  const hz = PR.hz || { base: 0, changes: [] };
  const { lh, first } = hzLayers();
  const tok = (h, i) => (live ? prHeadToken(h, { slots, n, own: true, attrs: ` data-hzi="${i}"` }) : `<span class="sl-token">${vhIs(h) ? `V${vhUid(h) + 1}` : `T${h}`}</span>`);
  const start = `<div class="p-color hz-line">
      <span class="hz-z">${esc(tr("hz.start"))}</span>
      <span class="p-toks">${tok(hz.base, -1)}</span>
    </div>`;
  let cur = hz.base;
  const rows = hz.changes
    .map((c, i) => {
      const pause = c.kind === "pause";
      if (!pause) cur = c.head;
      const layer = hzSnap(c.z, lh, first).layer;
      const who = pause
        ? `<span class="hz-pause" title="${esc(tr("hz.pause.title"))}">${esc(tr("hz.pause"))}</span>`
        : tok(c.head, i);
      return `<div class="p-color hz-line" data-hzrow="${i}">
        <span class="hz-z"><input type="number" class="hz-z-in" data-hzz="${i}" step="${lh}" min="${first}" value="${+c.z.toFixed(3)}" aria-label="${esc(tr("hz.height"))}" /> mm
          <small>${layer ? esc(tr("hz.layer", { n: layer })) : ""}</small></span>
        <span class="p-toks">${who}</span>
        <button type="button" class="p-ico hz-kind${pause ? " on" : ""}" data-hzk="${i}" title="${esc(tr(pause ? "hz.kind.auto" : "hz.kind.pause"))}">${HZ_ICON.pause}</button>
        <button type="button" class="p-ico" data-hzdel="${i}" title="${esc(tr("hz.remove"))}">${HZ_ICON.del}</button>
      </div>`;
    })
    .join("");
  const layers = tr(PR.hz?.layers ? "hz.layers.file" : "hz.layers.profile", { lh: hzFmt(lh), first: hzFmt(first) });
  const warns = (hz.warnings || []).map((w) => `<div class="hz-warn">${esc(hzWarnText(w))}</div>`).join("");
  return `<div class="p-grp p-hz">
      <div class="p-grp-head">
        <span class="k">${esc(tr("hz.title", { n: hz.changes.length }))}</span>
        <button type="button" class="btn" data-hzimport>${esc(tr("hz.import"))}</button>
      </div>
      <div class="group">${start}${rows}</div>
      <div class="hz-foot">
        <button type="button" class="btn small" data-hzadd>${esc(tr("hz.add"))}</button>
        <small class="vp-sub">${esc(layers)}</small>
      </div>
      ${warns}
    </div>`;
}

const HZ_ICON = {
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>',
};

/* What the import said, for the list and the sheet. */
function hzWarnText(w) {
  if (w.kind === "gap") return tr("hz.warn.gap", { z: hzFmt(w.z), to: hzFmt(w.to) });
  if (w.kind === "unloaded") return tr("hz.warn.unloaded", { name: w.name || w.hex || "?" });
  if (w.kind === "unknown") return tr("hz.warn.unknown", { name: w.name });
  if (w.kind === "ranges") return tr("hz.warn.ranges");
  return "";
}

/* A head for the start (`i` -1) or a change. */
function hzPickHead(tok, i) {
  const cur = i < 0 ? PR.hz?.base : PR.hz?.changes[i]?.head;
  prHeadPicker(tok, cur, (h) =>
    hzEdit((hz) => {
      if (i < 0) hz.base = h;
      else if (hz.changes[i]) hz.changes[i].head = h;
      // A head chosen by hand: what the import said of its colours is past.
      if (hz.warnings) hz.warnings = hz.warnings.filter((w) => w.kind !== "unloaded" && w.kind !== "unknown");
    }),
  );
}

/* A new change: ten layers above the last one (or halfway up the plate),
   on the next head. */
function hzAdd(z) {
  hzEnsure();
  const hz = PR.hz;
  if (!hz) return;
  const { lh } = hzLayers();
  const last = hz.changes[hz.changes.length - 1];
  const want = z ?? (last ? last.z + 10 * lh : Math.max(hzTop() / 2, 1));
  const snap = hzSnapZ(want);
  if (hz.changes.some((c) => Math.abs(c.z - snap.z) < 1e-4)) return toast(tr("hz.taken", { z: hzFmt(snap.z) }), true);
  const n = Math.max(1, headsCount(headsActive()));
  const head = ((last && last.kind !== "pause" ? last.head : hz.base) + 1) % n;
  hzEdit((p) => p.changes.push({ z: snap.z, head, kind: "auto" }));
}

/* A change's height typed: snapped to a layer top. */
function hzMove(i, z) {
  if (!(z > 0)) return prRenderInspector();
  const snap = hzSnapZ(z);
  if (PR.hz.changes.some((c, j) => j !== i && Math.abs(c.z - snap.z) < 1e-4)) {
    toast(tr("hz.taken", { z: hzFmt(snap.z) }), true);
    return prRenderInspector();
  }
  hzEdit((hz) => (hz.changes[i].z = snap.z));
}

$("p-list").addEventListener("click", (e) => {
  if (PR.assoc !== "height") return;
  if (e.target.closest("[data-hzadd]")) return hzAdd();
  if (e.target.closest("[data-hzimport]")) return hzOpenImport();
  const k = e.target.closest("[data-hzk]");
  if (k) {
    const i = +k.dataset.hzk;
    return hzEdit((hz) => {
      const c = hz.changes[i];
      if (!c) return;
      // Back to a head change: the head in force, to be changed.
      if (c.kind === "pause") c.kind = "auto";
      else c.kind = "pause";
    });
  }
  const del = e.target.closest("[data-hzdel]");
  if (del) hzEdit((hz) => hz.changes.splice(+del.dataset.hzdel, 1));
});
$("p-list").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-hzz]");
  if (inp) hzMove(+inp.dataset.hzz, parseFloat(String(inp.value).replace(",", ".")));
});

/* ------------------------------------------------------------ the view */

/* The shader's bands (PREP_FS): from each band's bottom, its head's spool
   colour; none outside "by height" mode. */
function hzUniforms(gl, prog) {
  const on = PR.assoc === "height" && PR.hz;
  const bands = on ? hzBands(PR.hz).slice(0, 16) : [];
  const z = new Float32Array(16), col = new Float32Array(16 * 3);
  const pid = typeof headsActive === "function" ? headsActive() : "";
  bands.forEach((b, i) => {
    z[i] = b.from;
    const rgb = hexToRgb(headsColorOf(pid, b.head)) || [154, 154, 154];
    col.set(rgb.map((x) => x / 255), i * 3);
  });
  gl.uniform1i(gl.getUniformLocation(prog, "uHzN"), bands.length);
  gl.uniform1fv(gl.getUniformLocation(prog, "uHzZ"), z);
  gl.uniform3fv(gl.getUniformLocation(prog, "uHzCol"), col);
}

/* The ruler beside the view: the bands from the bed to the tallest object,
   each with its head; a click adds a change at that height. */
function hzRuler() {
  const el = $("p-hz-ruler");
  const on = PR.assoc === "height" && PR.hz && PR.objects.some((o) => bedState(o) !== "out");
  el.classList.toggle("hidden", !on);
  if (!on) return;
  const pid = headsActive();
  const top = Math.max(hzTop(), ...PR.hz.changes.map((c) => c.z + 0.5), 1);
  const bands = hzBands(PR.hz).filter((b) => b.from < top);
  el.innerHTML =
    bands
      .map((b) => {
        const to = Math.min(b.to ?? top, top);
        const c = headsColorOf(pid, b.head) || "#9a9a9a";
        const name = vhIs(b.head) ? vhName(headsVirtual(pid), b.head) : `T${b.head}`;
        return `<div class="hz-band${b.pause ? " pause" : ""}" title="${esc(name)}" style="bottom:${(b.from / top) * 100}%;height:${((to - b.from) / top) * 100}%;--c:${esc(c)}">
          <span class="hz-tag">${esc(name)}</span>${b.from > 0 ? `<span class="hz-tick">${esc(hzFmt(b.from))}</span>` : ""}</div>`;
      })
      .join("") + `<span class="hz-top">${esc(hzFmt(top))} mm</span>`;
  el.dataset.top = top;
}
$("p-hz-ruler").addEventListener("click", (e) => {
  const el = $("p-hz-ruler"), r = el.getBoundingClientRect();
  const top = +el.dataset.top || 0;
  if (!top || !r.height) return;
  hzAdd(((r.bottom - e.clientY) / r.height) * top);
});

/* ------------------------------------------------------------ import */

/* A HueForge 3MF added to the plate: its list becomes the plate's, the
   mode switches to "by height", its colours go to the loaded heads. */
async function hzAdoptFile(path, hc, heights) {
  const model = await headsModel(path).catch(() => null);
  const colours = Object.fromEntries((model?.filaments || []).map((f) => [f.index, f.color]));
  const layers = heights?.layer_height ? { layer_height: heights.layer_height, first_layer: heights.first_layer ?? heights.layer_height } : null;
  // A plan already made (by hand, or by a file added before) is kept.
  if (PR.hz?.changes?.length) return toast(tr("hz.kept"), true);
  const { plan, warnings } = hzFromFile(hc, colours, layers, hzHeads());
  if (heights?.ranges) warnings.push({ kind: "ranges" });
  PR.hz = { ...plan, warnings };
  PR.assoc = "height";
  prSave();
  prRenderInspector();
  prSchedule();
  if (warnings.length) toast(tr("hz.imported.warn", { n: plan.changes.length }));
  else toast(tr("hz.imported", { n: plan.changes.length }));
}

const HZI = { parsed: null };

function hzOpenImport() {
  $("hz-text").value = "";
  HZI.parsed = null;
  hzPreview();
  openSheet($("hzmodal"));
  $("hz-text").focus();
}

/* What the pasted text gives, before importing it. */
function hzPreview() {
  const d = hzParseDescribe($("hz-text").value);
  HZI.parsed = d?.swaps.length && d.layer_height ? d : null;
  $("hz-go").disabled = !HZI.parsed;
  const box = $("hz-preview");
  if (!$("hz-text").value.trim()) return (box.innerHTML = "");
  if (!HZI.parsed) return (box.innerHTML = `<div class="hz-warn">${esc(tr("hz.import.none"))}</div>`);
  const { plan, warnings } = hzFromDescribe(d, hzHeads());
  const lines = [
    tr("hz.import.summary", { n: plan.changes.length, lh: hzFmt(d.layer_height), first: hzFmt(d.first_layer ?? d.layer_height) }),
    d.infill100 ? tr("hz.import.infill") : "",
  ].filter(Boolean);
  box.innerHTML =
    lines.map((l) => `<div>${esc(l)}</div>`).join("") + warnings.map((w) => `<div class="hz-warn">${esc(hzWarnText(w))}</div>`).join("");
}

$("hz-text").addEventListener("input", hzPreview);
$("hz-file").addEventListener("click", () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".txt,text/plain";
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    $("hz-text").value = await f.text();
    hzPreview();
  };
  inp.click();
});
$("hz-cancel").addEventListener("click", () => closeSheet($("hzmodal")));
$("hz-go").addEventListener("click", () => {
  const d = HZI.parsed;
  if (!d) return;
  const { plan, warnings } = hzFromDescribe(d, hzHeads());
  prRemember();
  PR.hz = { ...plan, infill100: d.infill100, warnings };
  PR.assoc = "height";
  closeSheet($("hzmodal"));
  prSave();
  prRenderInspector();
  prSchedule();
  toast(tr(warnings.length ? "hz.imported.warn" : "hz.imported", { n: plan.changes.length }));
});

/* The slice's settings the plan imposes: the file's layers, and full
   infill when the describe asks for it. */
function hzOverrides() {
  if (PR.assoc !== "height" || !PR.hz?.changes.length) return {};
  const out = {};
  const l = PR.hz.layers;
  if (l?.layer_height > 0) {
    out.layer_height = String(l.layer_height);
    out.initial_layer_print_height = String(l.first_layer || l.layer_height);
  }
  if (PR.hz.infill100) out.sparse_infill_density = "100%";
  return out;
}
