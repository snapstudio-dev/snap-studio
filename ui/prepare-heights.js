"use strict";
/* Prepare, "By height" mode (HueForge, step 2): the plate prints with one
   head and changes head, or pauses for a spool swap, at heights. The plan
   is `PR.hz` (prepare.js, heights-logic.js): the list above the objects
   (heights typed in layers or mm), the model tinted by height, the import
   of a HueForge describe or 3MF. The engine gets it at the slice (slice.js). */

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

/* The tallest object on the plate as it stands (mm, rotated and scaled),
   for a new change and the changes never reached. */
function hzTop() {
  let top = 0;
  for (const o of PR.objects) {
    if (bedState(o) === "out") continue;
    const sh = shape(o);
    top = Math.max(top, sh.zmax - sh.zmin);
  }
  return top;
}
/* The plan's heads the slice prints with (those of changes above the
   objects left out). */
const hzLiveHeads = () => hzPlanHeads(PR.hz, hzTop());

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

/* "By height" chosen: the mode it came from is the one to go back to as
   it was (prAssocApply), its colour choices included. */
function hzEnter() {
  if (PR.assoc !== "height") PR.hzFrom = PR.assoc;
  PR.assoc = "height";
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
  // Layers, as HueForge counts them ("At layer #5"), or mm.
  const byLayer = PRUI.hzUnit !== "mm" && hzSnap(1, lh, first).layer != null;
  const tok = (h, i) => (live ? prHeadToken(h, { slots, n, own: true, attrs: ` data-hzi="${i}"` }) : `<span class="sl-token">${vhIs(h) ? `V${vhUid(h) + 1}` : `T${h}`}</span>`);
  // The file's colour before the head it goes to, a mark when the head's
  // spool is far from it (the spool's colour known).
  const pid = typeof headsActive === "function" ? headsActive() : "";
  const want = (i) => {
    const hex = hzWant(hz, i);
    const name = hex && hz.names?.[hex];
    return hex && { hex, name: name || hex.toUpperCase(), named: !!name };
  };
  const chip = (w) =>
    `<span class="hz-col hz-want" title="${esc(tr("hz.want.title", { name: w.name }))}"><i style="--c:${esc(w.hex)}"></i>${w.named ? `<span>${esc(w.name)}</span>` : ""}</span>`;
  const far = (w, h) =>
    live && w && hzFar(w.hex, headsColorOf(pid, h))
      ? `<span class="hz-far" role="button" tabindex="0" data-help="${esc(tr("hz.far", { name: w.name }))}" aria-label="${esc(tr("hz.far", { name: w.name }))}">⚠</span>`
      : "<span></span>";
  // Each row on one grid: the heads in one column, the mark, pause and
  // delete in theirs (empty on the start), whatever the colours' width.
  const to = (w, h, i) => (w ? `${chip(w)}<span class="hz-to" aria-hidden="true">→</span>` : "") + tok(h, i);
  const start = `<div class="p-color hz-line">
      <span class="hz-z"><span class="hz-lbl">${esc(tr("hz.start"))}</span></span>
      <span class="p-toks">${to(want(-1), hz.base, -1)}</span>
      ${far(want(-1), hz.base)}<span></span><span></span>
    </div>`;
  let cur = hz.base;
  const top = hzTop();
  const rows = hz.changes
    .map((c, i) => {
      const pause = c.kind === "pause";
      // Above the objects: never reached, the slice leaves it out.
      const above = hzAbove(c.z, top) ? `<small class="hz-above">${esc(tr("hz.above", { top: hzFmt(top) }))}</small>` : "";
      if (!pause) cur = c.head;
      const layer = hzSnap(c.z, lh, first).layer;
      // The other unit under the field, where it has the row's width.
      const z = byLayer ? `<span class="hz-lbl">${esc(tr("hz.layer.at"))}</span>
          <span class="hz-zcol"><input type="number" class="hz-z-in" data-hzz="${i}" data-unit="layer" step="1" min="2" value="${layer}" aria-label="${esc(tr("hz.layer.input"))}" />
          <small>${esc(hzFmt(c.z))} mm</small></span>`
        : `<span class="hz-zcol"><span><input type="number" class="hz-z-in" data-hzz="${i}" step="${lh}" min="${first}" value="${+c.z.toFixed(3)}" aria-label="${esc(tr("hz.height"))}" /> mm</span>
          <small>${layer ? esc(tr("hz.layer", { n: layer })) : ""}</small></span>`;
      // A pause names the colour to load by hand, when the file gives it.
      const w = want(i);
      const who = pause
        ? w
          ? `<span class="hz-pause" title="${esc(tr("hz.pause.load.title", { name: w.name }))}">${esc(tr("hz.pause.load"))} ${chip(w)}</span>`
          : `<span class="hz-pause" title="${esc(tr("hz.pause.title"))}">${esc(tr("hz.pause"))}</span>`
        : to(w, c.head, i);
      const mark = pause ? "<span></span>" : far(w, c.head);
      return `<div class="p-color hz-line${above ? " hz-out" : ""}" data-hzrow="${i}">
        <span class="hz-z">${z}${above}</span>
        <span class="p-toks">${who}</span>
        ${mark}
        <button type="button" class="p-ico hz-kind${pause ? " on" : ""}" data-hzk="${i}" title="${esc(tr(pause ? "hz.kind.auto" : "hz.kind.pause"))}">${HZ_ICON.pause}</button>
        <button type="button" class="p-ico" data-hzdel="${i}" title="${esc(tr("hz.remove"))}">${HZ_ICON.del}</button>
      </div>`;
    })
    .join("");
  // One short line, where the layers come from in its ⓘ.
  const [key, tip] = PR.hz?.layers ? ["hz.layers.file", "hz.layers.file.tip"] : ["hz.layers.profile", "hz.layers.profile.tip"];
  const layers = `<small class="vp-sub">${esc(tr(key, { lh: hzFmt(lh), first: hzFmt(first) }))}</small>
        <span class="mt-info" role="button" tabindex="0" data-help="${esc(tr(tip))}" aria-label="${esc(tr(tip))}">i</span>`;
  const warns = hzWarnsHtml(hz.warnings || []);
  const unit = (u, key) => `<button type="button" class="seg-btn${(u === "layer") === byLayer ? " on" : ""}" data-hzunit="${u}">${esc(tr(key))}</button>`;
  return `<div class="p-grp p-hz">
      <div class="p-grp-head">
        <span class="k">${esc(tr("hz.title", { n: hz.changes.length }))}</span>
      </div>
      <div class="group">${start}${rows}</div>
      <div class="hz-foot">
        <button type="button" class="btn small" data-hzadd>${esc(tr("hz.add"))}</button>
        <div class="seg compact hz-unit" role="group" aria-label="${esc(tr("hz.unit"))}">${unit("layer", "hz.unit.layers")}${unit("mm", "hz.unit.mm")}</div>
      </div>
      <div class="hz-layers">${layers}</div>
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
  if (w.kind === "offline") return tr("hz.warn.offline");
  if (w.kind === "unknown") return tr("hz.warn.unknown", { name: w.name });
  if (w.kind === "ranges") return tr("hz.warn.ranges");
  if (w.kind === "same") return tr("hz.warn.same", { a: w.name || w.hex, b: w.withName || w.with });
  return "";
}

/* The warnings, the colours no head holds in one line, each with its
   swatch and its name (a describe's) or hex (a 3MF's). */
function hzWarnsHtml(warnings) {
  const out = (w) => `<div class="hz-warn">${w}</div>`;
  const col = (hex, name) => `<span class="hz-col">${hex ? `<i style="--c:${esc(hex)}"></i>` : ""}${esc(name || hex || "?")}</span>`;
  const missing = warnings.filter((w) => w.kind === "unloaded");
  const lines = warnings
    .filter((w) => w.kind !== "unloaded")
    .map((w) => {
      if (w.kind !== "same") return out(esc(hzWarnText(w)));
      // The two colours as swatches: their quotes go (a line could break
      // between a quote and its colour), the rest as translated.
      const text = esc(tr("hz.warn.same", { a: "\u0001", b: "\u0002" })).replace(/[\u00ab\u201c\u201e\u300c]\s?(\u0001|\u0002)\s?[\u00bb\u201d\u201c\u300d]/g, "$1");
      return out(text.replace("\u0001", col(w.hex, w.name)).replace("\u0002", col(w.with, w.withName)));
    });
  if (missing.length) {
    const names = missing.map((w) => col(w.hex, w.name)).join(", ");
    const [a, b] = tr("hz.warn.unloaded", { n: missing.length, names: "\u0000" }).split("\u0000");
    const help = esc(tr("hz.warn.unloaded.tip", { n: missing.length }));
    const tip = `<span class="mt-info" role="button" tabindex="0" data-help="${help}" aria-label="${help}">i</span>`;
    lines.push(out(`${esc(a)}${names}${esc(b ?? "")} ${tip}`));
  }
  return lines.join("");
}
/* A head for the start (`i` -1) or a change. */
function hzPickHead(tok, i) {
  const cur = i < 0 ? PR.hz?.base : PR.hz?.changes[i]?.head;
  prHeadPicker(tok, cur, (h) =>
    hzEdit((hz) => {
      const c = i < 0 ? null : hz.changes[i];
      if (i >= 0 && !c) return;
      // A head chosen by hand stays (hzRematch): what the import said of
      // this colour is past, not what it said of the others.
      if (c) Object.assign(c, { head: h, hand: true });
      else Object.assign(hz, { base: h, baseHand: true });
      const hex = c ? c.hex : hz.baseHex;
      if (hex && hz.warnings) hz.warnings = hzForget(hz.warnings, hex);
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
  // The head in force at the top, a pause keeping the one before it.
  const head = (hzHeadAt(hz, Infinity) + 1) % n;
  hzEdit((p) => p.changes.push({ z: snap.z, head, kind: "auto" }));
}

/* A change's height typed (or its layer, `byLayer`): snapped to a layer top. */
function hzMove(i, z, byLayer) {
  if (byLayer) {
    const { lh, first } = hzLayers();
    z = hzLayerZ(z, lh, first);
  }
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
  const u = e.target.closest("[data-hzunit]");
  if (u) {
    PRUI.hzUnit = u.dataset.hzunit === "mm" ? "mm" : "layer";
    pruiSave();
    return prRenderInspector();
  }
  const k = e.target.closest("[data-hzk]");
  if (k) {
    const i = +k.dataset.hzk;
    return hzEdit((hz) => {
      const c = hz.changes[i];
      if (!c) return;
      // Back to a head change: the head in force, to be changed. Chosen
      // by hand: a colour change of the file stays as it is put.
      if (c.kind === "pause") c.kind = "auto";
      else c.kind = "pause";
      c.hand = true;
    });
  }
  const del = e.target.closest("[data-hzdel]");
  if (del) hzEdit((hz) => hz.changes.splice(+del.dataset.hzdel, 1));
});
$("p-list").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-hzz]");
  if (inp) hzMove(+inp.dataset.hzz, parseFloat(String(inp.value).replace(",", ".")), inp.dataset.unit === "layer");
});

/* ------------------------------------------------------------ the view */

/* The shader's bands (PREP_FS): from each band's bottom, its head's spool
   colour; none outside "by height" mode. */
function hzUniforms(gl, prog) {
  const on = PR.assoc === "height" && PR.hz;
  const bands = on ? hzBands(PR.hz).slice(0, HZ_BANDS) : [];
  const z = new Float32Array(HZ_BANDS), col = new Float32Array(HZ_BANDS * 3);
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

/* ------------------------------------------------------------ import */

/* The plan as a saved 3MF keeps it (prSaveHeights): the list for Orca
   (a virtual head on its first head), each head's spool colour, the layers
   its heights are on, and the plan itself, read back as it is (hzAdoptFile). */
function hzSaved() {
  const pid = typeof headsActive === "function" ? headsActive() : "";
  const list = headsVirtual(pid);
  const extOf = (h) => (vhIs(h) ? (vhFind(list, h)?.a ?? 0) : +h) + 1;
  const changes = hzToFile(PR.hz, extOf);
  const n = Math.max(1, ...changes.map((c) => c.extruder), extOf(PR.hz.base ?? 0));
  const colors = Array.from({ length: n }, (_, i) => hdSpoolColor(pid, i) || null);
  const { lh, first } = hzLayers();
  const { warnings, ...plan } = PR.hz;
  plan.check = hcKey(changes.map((c) => ({ z: c.z, ext: c.extruder, kind: c.kind })));
  return { changes, colors, plan, layer_height: lh, first_layer: first };
}



/* A HueForge 3MF added to the plate: its list becomes the plate's, the
   mode switches to "by height", its colours go to the loaded heads. A
   plate Snap Studio saved "by height" gets its plan back as it was. Called
   before the file's objects join the plate (PR.objects is the others). `own`
   is the file's object's extruder (from 1), its start. */
async function hzAdoptFile(path, hc, heights, own = null) {
  // A plan made by hand or from a file still on the plate is kept (a second
  // copy of that file too); an emptied plate's, or one whose file is gone
  // from it, is not. Called before the file's objects join the plate.
  const others = PR.objects.slice();
  const kept = PR.hz?.changes?.length && others.length && (!PR.hz.path || others.some((o) => o.path === PR.hz.path));
  const model = await headsModel(path).catch(() => null);
  if (kept) return toast(tr("hz.kept"), true);
  const saved = hzFromSaved(heights?.plan, hc);
  if (saved) {
    PR.hz = { ...saved, path };
    hzEnter();
    prSave();
    prRenderInspector();
    prSchedule();
    return toast(tr("hz.imported", { n: saved.changes.length }));
  }
  const colours = Object.fromEntries((model?.filaments || []).map((f) => [f.index, f.color]));
  const layers = heights?.layer_height ? { layer_height: heights.layer_height, first_layer: heights.first_layer ?? heights.layer_height } : null;
  const { plan, warnings } = hzFromFile(hc, colours, layers, hzHeads(), own);
  if (heights?.ranges) warnings.push({ kind: "ranges" });
  PR.hz = { ...plan, path, settings: hzPick(heights?.settings, hzSheetKeys(hzForU1(heights?.settings))), warnings };
  hzEnter();
  prSave();
  prRenderInspector();
  prSchedule();
  if (warnings.length) toast(tr("hz.imported.warn", { n: plan.changes.length }));
  else toast(tr("hz.imported", { n: plan.changes.length }));
}

/* Imported while the printer was off: once its spools are known, each
   colour goes to its head (no undo step: the import's own result). */
function hzRematchNow() {
  if (!PR.hz?.warnings?.some((w) => w.kind === "offline")) return;
  const next = hzRematch(PR.hz, hzHeads());
  if (!next) return;
  PR.hz = next;
  prSave();
  if (window.currentView !== "prepare") return;
  prRenderInspector();
  prSchedule();
}
window.addEventListener("headschange", (e) => {
  if (e.detail?.what === "slots") hzRematchNow();
});

const HZI = { parsed: null };

/* The describe's import: no button opens it for now (a HueForge 3MF
   needs none); kept for when it comes back. */
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
    lines.map((l) => `<div>${esc(l)}</div>`).join("") + hzWarnsHtml(warnings);
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
  hzEnter();
  closeSheet($("hzmodal"));
  prSave();
  prRenderInspector();
  prSchedule();
  toast(tr(warnings.length ? "hz.imported.warn" : "hz.imported", { n: plan.changes.length }));
});

/* ------------------------------------------------------------ slice sheet */

/* The file's settings the slice sheet takes over: its quick ones and those
   of its detailed panels, not the heads' (the file's extruders are not the
   plate's heads) nor the print sequence (by object stops a "by height"
   slice). A file for another printer (`u1` false) keeps the U1 profile's
   line widths, compensations and speeds (HZ_MACHINE_KEYS). */
const HZ_QUICK_KEYS = ["layer_height", "initial_layer_print_height", "sparse_infill_density", "wall_loops", "enable_support", "brim_type"];
function hzSheetKeys(u1 = true) {
  const adv = typeof ADV_CATS === "undefined" ? [] : Object.keys(ADV_CATS).filter((c) => c !== "mm").flatMap((c) => advCatKeysAll(c));
  return [...new Set([...HZ_QUICK_KEYS, ...adv])].filter(
    (k) => (typeof ADV_FILAMENT === "undefined" || !ADV_FILAMENT.has(k)) && k !== "print_sequence" && (u1 || !HZ_MACHINE_KEYS.has(k)),
  );
}
const hzSheetOn = () => PR.assoc === "height" && PR.hz?.changes?.length > 0;

/* The sheet opened (or its machine changed) for a plate "by height": the
   file's settings become the sheet's, as if chosen there, and stay
   changeable. Its layer height picks the profile at that height; with
   none, the file's is sent (hzOverrides). What the sheet remembers for
   the machine stays the person's (hzMemo). */
async function hzSheetApply(seq = SL.machineSeq) {
  SL.hzSheet = null;
  // Another machine chosen meanwhile: its own run applies.
  const stale = () => seq !== SL.machineSeq;
  const s = hzSheetOn() ? hzPlanSettings(PR.hz) : {};
  if (!Object.keys(s).length) return hzSheetLine();
  const before = { process: $("s-process").value, simple: currentSimple(), adv: { ...SL.adv } };
  const q = hzQuick(s);
  let forced = null;
  // A profile only at the file's exact height (0.075 is not 0.08).
  if (q.layer && !q.exact) forced = s.layer_height;
  else if (q.layer && parseProcess(before.process)?.h !== q.layer) {
    const name = slProcessFor(q.layer, parseProcess(before.process)?.style);
    if (name) {
      $("s-process").value = name;
      slQuality();
      await loadDefaults(before.simple);
      if (stale()) return;
    } else forced = s.layer_height;
  }
  if (q.infill != null) setRange("s-infill", q.infill, (x) => Math.round(x) + " %");
  // Between the slider's steps (12 %): the file's own sent while the
  // slider stays where it put it (hzOverrides).
  const infill = q.infill != null && +$("s-infill").value !== q.infill ? { pct: q.infill, at: +$("s-infill").value } : null;
  if (q.walls != null) setRange("s-walls", Math.max(+$("s-walls").min, Math.min(+$("s-walls").max, q.walls)), (x) => String(Math.round(x)));
  if (q.supports != null) $("s-supports").checked = q.supports;
  if (q.brim != null) $("s-brim").checked = q.brim;
  // As if set by hand: a profile chosen next keeps them.
  for (const [k, key] of [["infill", "infill"], ["walls", "walls"], ["supports", "supports"], ["brim", "brim"]]) if (q[k] != null) (SL.touched ||= new Set()).add(key);
  await advRefreshDefaults();
  if (stale()) return;
  const adv = {};
  for (const k of hzSheetKeys()) {
    if (!(k in s) || ["layer_height", "sparse_infill_density", "wall_loops", "enable_support"].includes(k)) continue;
    if (k === "brim_type" && s[k] === "no_brim") continue;
    adv[k] = s[k];
    if (String(s[k]) === String(ADV.defaults[k])) delete SL.adv[k];
    else SL.adv[k] = s[k];
  }
  const now = currentSimple();
  const simple = Object.fromEntries(["infill", "walls", "supports", "brim"].filter((k) => q[k] != null).map((k) => [k, now[k]]));
  SL.hzSheet = { before, file: { process: $("s-process").value, simple, adv }, forced, infill, layer: forced ? +forced : q.layer, n: Object.keys(adv).length };
  advRenderRows();
  if (ADV.cat) advRenderPanel();
  slSummary();
  hzSheetLine();
}

/* A layer height: 0,08 or 0,075. */
const hzFmtLayer = (h) => fmtNum(h, { minimumFractionDigits: 2, maximumFractionDigits: 3 });

/* The sheet's line on what it took from the file, and the file's layer
   height when no profile has it. */
function hzSheetLine() {
  const el = $("s-hzfile");
  const m = SL.hzSheet;
  el.classList.toggle("hidden", !m);
  if (!m) return;
  if (m.forced && $("s-process").value === m.file.process) $("s-layer-val").textContent = `${hzFmtLayer(+m.forced)} mm`;
  const q = m.file.simple;
  const parts = [
    m.layer && `${hzFmtLayer(m.layer)} mm`,
    q.infill != null && tr("slice.sum.infill", { v: Math.round(m.infill?.pct ?? q.infill) + " %" }),
    q.walls != null && tr("slice.sum.walls", { v: q.walls }),
    q.supports && tr("slice.sum.supports"),
    q.brim && tr("slice.sum.brim"),
    m.n && tr("slice.hz.more", { n: m.n }),
  ].filter(Boolean);
  el.textContent = tr("slice.hz.file", { list: parts.join(", ") });
}

/* What the sheet cannot show exactly: the file's layer height when no
   profile has it (the profile chosen then still in place), its infill
   between the slider's steps (the slider still where it was put). */
function hzOverrides() {
  const m = SL.hzSheet;
  if (!hzSheetOn() || !m) return {};
  const out = {};
  if (m.forced && $("s-process").value === m.file.process) out.layer_height = String(m.forced);
  if (m.infill && +$("s-infill").value === m.infill.at) out.sparse_infill_density = `${m.infill.pct}%`;
  return out;
}
