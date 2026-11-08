"use strict";
/* Plate and materials, in the interface (rules: plate-rules.js).

   - plateAsk: the sheet that says a material does not suit the plate
     (Continue / Cancel) or needs glue (the tip, with a simple drawing of
     plate, glue and part). Used when slicing in Prepare and when a head's
     material is declared in Control.
   - Spools seen on the printers: a new spool on a head (RFID, or declared
     on the printer's screen) is checked once against the printer's plate,
     and a notice goes in that head's card in Control (nothing to cancel).
     The same spool read again says nothing more.
   - "Don't show again" per kind, re-enabled in Settings › Prepare. */

const PLT = {
  /* pid → { head → spool key } of the spools already seen (kept). */
  seen: (() => {
    try {
      return JSON.parse(localStorage.getItem("snapstudio.plate.seen") || "{}") || {};
    } catch {
      return {};
    }
  })(),
  /* pid → { head → issue }: the notices shown in Control's head cards. */
  notes: {},
  /* "pid:head" → when a material was declared from Control: its spool,
     read back a moment later, was already checked there. */
  declared: new Map(),
};

/* The pattern of each plate's tile (style.css .sl-bed-tex): the slice
   sheet's plate choice and Control's. */
const PLATE_TEX = { "Textured PEI Plate": "textured", "High Temp Plate": "smooth", "Graphic Effect Plate": "graphic" };

const pltSaveSeen = () => localStorage.setItem("snapstudio.plate.seen", JSON.stringify(PLT.seen));

/* A plate's name in the interface: the machine's label when known. */
function plateLabel(value, pid) {
  const lists = [typeof headsPlates === "function" && pid ? headsPlates(pid) : [], typeof SL !== "undefined" ? SL.lists?.bed_types || [] : []];
  for (const l of lists) {
    const p = l.find((x) => x.value === value);
    if (p) return p.label;
  }
  return value || "";
}

/* Plate, glue, part: the tip's drawing. */
function plateDiagram() {
  return `<svg class="pl-diagram" viewBox="0 0 220 92" role="img" aria-label="${esc(tr("plate.diag.label"))}">
    <rect x="70" y="14" width="80" height="38" rx="4" class="pl-d-part"/>
    <rect x="52" y="54" width="116" height="7" rx="2" class="pl-d-glue"/>
    <rect x="16" y="62" width="188" height="14" rx="3" class="pl-d-plate"/>
    <text x="110" y="37" class="pl-d-t">${esc(tr("plate.diag.part"))}</text>
    <text x="176" y="58" class="pl-d-t side">${esc(tr("plate.diag.glue"))}</text>
    <text x="110" y="89" class="pl-d-t">${esc(tr("plate.diag.plate"))}</text>
  </svg>`;
}

/* One issue in words: "PETG on Smooth PEI: needs glue" and why. */
function plateIssueHtml(i, plate, pid) {
  const vals = { mat: i.family, plate: plateLabel(plate, pid) };
  const head = tr(i.level === "warn" ? "plate.warn" : "plate.glue", vals);
  return `<div class="pl-row ${i.level}"><span class="pl-ic" aria-hidden="true">${i.level === "warn" ? "!" : "✓"}</span>
    <span><b>${esc(head)}</b><small>${esc(tr(`plate.why.${i.reason}`))}</small></span></div>`;
}

/* Asks before going on with materials on a plate: the warnings (Continue
   / Cancel) and the glue tip (its drawing, OK). The kinds hidden are left
   out; nothing to say: true at once. → true to go on, false to cancel. */
function plateAsk({ plate, families, pid = null, title = null }) {
  const issues = plateIssues(families, plate).filter((i) => !plateHidden(i.level === "warn" ? "pair" : "glue"));
  if (!issues.length) return Promise.resolve(true);
  const warn = issues.some((i) => i.level === "warn"), glue = issues.some((i) => i.level === "glue");
  $("pl-title").textContent = title || tr(warn ? "plate.title.warn" : "plate.title.glue");
  $("pl-list").innerHTML = issues.map((i) => plateIssueHtml(i, plate, pid)).join("");
  $("pl-tip").classList.toggle("hidden", !glue);
  $("pl-tip-art").innerHTML = glue ? plateDiagram() : "";
  // One box per kind shown.
  $("pl-hide-pair").closest("label").classList.toggle("hidden", !warn);
  $("pl-hide-glue").closest("label").classList.toggle("hidden", !glue);
  $("pl-hide-pair").checked = $("pl-hide-glue").checked = false;
  $("pl-cancel").classList.toggle("hidden", !warn);
  $("pl-go").textContent = tr(warn ? "plate.continue" : "plate.ok");
  const modal = $("plmodal");
  openSheet(modal);
  requestAnimationFrame(() => $(warn ? "pl-cancel" : "pl-go").focus());
  return new Promise((resolve) => {
    const done = (go) => {
      if (go) {
        if ($("pl-hide-pair").checked) plateSetHidden("pair", true);
        if ($("pl-hide-glue").checked) plateSetHidden("glue", true);
        plateSettingsPaint();
      }
      $("pl-go").onclick = $("pl-cancel").onclick = modal.onkeydown = null;
      closeSheet(modal);
      resolve(go);
    };
    $("pl-go").onclick = () => done(true);
    $("pl-cancel").onclick = () => done(false);
    modal.onkeydown = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      done(!warn);
    };
  });
}

/* ------------------------------------------------------------ spools seen */

/* Notices for a printer's heads: each spool against its plate. `fresh`:
   only the spools not seen yet (a printer read for the first time: its
   spools are taken as they are, without a word). */
function pltCheckSpools(pid, { fresh = true } = {}) {
  const slots = typeof headsSlots === "function" ? headsSlots(pid) : [];
  // No heads reported (yet): nothing seen, the first real read is still
  // the one whose spools are taken as they are.
  if (!slots.length) return;
  const plate = headsPlate(pid);
  const first = !PLT.seen[pid];
  const seen = (PLT.seen[pid] ||= {});
  const notes = (PLT.notes[pid] ||= {});
  let changed = false;
  for (const s of slots) {
    const key = plateSpoolKey(s);
    const isNew = key !== (seen[s.index] || "");
    if (isNew) {
      seen[s.index] = key;
      changed = true;
    }
    if (!fresh || (isNew && !first)) {
      // Declared from Control a moment ago: checked there already.
      const at = PLT.declared.get(`${pid}:${s.index}`);
      const declared = fresh && at && Date.now() - at < 120000;
      if (declared) PLT.declared.delete(`${pid}:${s.index}`);
      const issue = key && !declared ? plateIssues([spMaterialFamily(s.kind)], plate)[0] : null;
      const shown = issue && !plateHidden(issue.level === "warn" ? "pair" : "glue") ? issue : null;
      if (JSON.stringify(notes[s.index] || null) !== JSON.stringify(shown)) changed = true;
      if (shown) notes[s.index] = shown;
      else delete notes[s.index];
    }
  }
  if (changed) {
    pltSaveSeen();
    if (typeof ctlEmit === "function") ctlEmit(pid);
  }
}

window.addEventListener("headschange", (e) => {
  const { pid, what } = e.detail || {};
  if (!pid) return;
  if (what === "slots") pltCheckSpools(pid);
  // Another plate: every spool loaded, against it.
  if (what === "plate") pltCheckSpools(pid, { fresh: false });
});

/* The notice in a head's card, if any: "PETG on Smooth PEI: needs glue". */
function plateNote(pid, head) {
  return PLT.notes[pid]?.[head] || null;
}
function plateNoteDismiss(pid, head) {
  if (PLT.notes[pid]) delete PLT.notes[pid][head];
  if (typeof ctlEmit === "function") ctlEmit(pid);
}

/* A head's material declared from Control: asked first against the
   printer's plate (Continue / Cancel); its spool is not asked about again
   when the printer reports it. */
async function plateCheckDeclared(pid, head, material) {
  const ok = await plateAsk({ plate: headsPlate(pid), families: [spMaterialFamily(material)], pid });
  if (ok) PLT.declared.set(`${pid}:${head}`, Date.now());
  return ok;
}

/* ------------------------------------------------------------ settings */

/* Settings › Prepare: one switch per kind of message, on = shown. */
function plateSettingsPaint() {
  for (const k of PLATE_KINDS) {
    const box = document.getElementById(`set-plate-${k}`);
    if (box) box.checked = !plateHidden(k);
  }
}
for (const k of PLATE_KINDS) {
  document.getElementById(`set-plate-${k}`)?.addEventListener("change", (e) => plateSetHidden(k, !e.target.checked));
}
plateSettingsPaint();
