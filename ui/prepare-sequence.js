"use strict";
/* Sequential printing shares the slice sheet's process setting. Geometry
   is checked in bed coordinates, after each object's resting transform. */
const prSeqOn = () => String(prTowerSetting("print_sequence") || "by layer") === "by object";
const prSeqBlocked = () => sqBlocked({ assoc: PR.assoc, virtual: prTowerVirtualUsed() });
let prSeqCache = null;
let prSeqStatus = undefined;
function prSeqUpdate() {
  const r = prSeqCheck();
  if (r !== prSeqStatus) { prSeqStatus = r; prStatus(); }
}
function prSeqCheck() {
  if (!prSeqOn()) return null;
  const items = plSliced(PR.objects, bedState).map((o) => {
    const sh = shape(o);
    return { id: o.id, foot: footprint(o), height: sh.zmax - sh.zmin };
  });
  const clearance = sqClearance(prTowerRawSetting), blocked = prSeqBlocked();
  const key = JSON.stringify([items, clearance, blocked]);
  if (prSeqCache?.key !== key) prSeqCache = { key, result: { ...sqCheck(items, clearance), items, blocked } };
  return prSeqCache.result;
}
const prSeqBad = (r) => new Set(r ? [...r.close.flat(), ...r.tall.map((x) => x.id)] : []);
function prSeqText(r) {
  if (r.blocked) return tr(`prepare.seq.off.${r.blocked}`);
  const name = (id) => PR.objects.find((o) => o.id === id)?.name || "";
  if (r.close.length) return tr("prepare.seq.close", { a: name(r.close[0][0]), b: name(r.close[0][1]), gap: fmtDec(r.gap, 1) });
  if (r.tall.length) {
    const t = r.tall[0], o = r.items.find((x) => x.id === t.id);
    return tr("prepare.seq.tall", { name: name(t.id), h: fmtDec(o.height, 1), limit: fmtDec(t.limit, 1) });
  }
  return "";
}
function prSeqRender(r) {
  const off = prSeqBlocked();
  for (const b of document.querySelectorAll("#p-seq [data-sequence]")) {
    const on = (b.dataset.sequence === "by object") === prSeqOn();
    b.disabled = b.dataset.sequence === "by object" && !!off;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  $("p-seq-why").textContent = tr(off ? `prepare.seq.off.${off}` : "prepare.seq.sub");
  const bad = prSeqBad(r);
  for (const row of document.querySelectorAll("#p-list .p-on .p-obj")) {
    row.querySelector(".p-seq-number")?.classList.toggle("bad", bad.has(+row.dataset.id));
  }
  const msg = $("p-seq-message"), text = r ? prSeqText(r) : "";
  msg.classList.toggle("hidden", !text);
  const repair = !r?.blocked && !r?.close.length && r?.tall.find((x) => x.why !== "height");
  const messageKey = JSON.stringify([text, repair?.id, tr("prepare.seq.make_last")]);
  if (msg.dataset.sequence === messageKey) return;
  msg.dataset.sequence = messageKey;
  msg.replaceChildren();
  if (text) {
    const p = document.createElement("div");
    p.textContent = text;
    msg.append(p);
    const t = !r.blocked && !r.close.length && r.tall.find((x) => x.why !== "height");
    if (t) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn small";
      b.textContent = tr("prepare.seq.make_last");
      b.onclick = () => prSeqMove([t.id], null);
      msg.append(b);
    }
  }
}
function prSeqBadge(id, r = prSeqCheck()) {
  return r?.order[id] ? `<span class="p-seq-number${prSeqBad(r).has(id) ? " bad" : ""}">${r.order[id]}</span>` : "";
}
function prSeqMove(ids, before) {
  const order = sqMove(PR.objects.map((o) => o.id), ids, before);
  if (order.every((id, i) => id === PR.objects[i].id)) return;
  prRemember();
  const objects = new Map(PR.objects.map((o) => [o.id, o]));
  PR.objects = order.map((id) => objects.get(id));
  prSave();
  prRenderInspector();
  prSchedule();
}
function prSeqDropTarget(over, e) {
  if (!prSeqOn() || !over?.closest("#p-list .p-on")) return null;
  const rows = [...document.querySelectorAll("#p-list .p-on .p-obj")];
  const row = rows.find((el) => e.clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
  return { before: row ? +row.dataset.id : null };
}
function prSeqDropClear() {
  document.querySelectorAll(".p-seq-insert, .p-seq-end, .p-seq-drag").forEach((el) => el.classList.remove("p-seq-insert", "p-seq-end", "p-seq-drag"));
}
function prSeqDropHover(over, e) {
  prSeqDropClear();
  const t = prSeqDropTarget(over, e);
  if (!t) return;
  const rows = [...document.querySelectorAll("#p-list .p-on .p-obj")];
  const row = t.before == null ? rows.at(-1) : rows.find((el) => +el.dataset.id === t.before);
  row?.classList.add(t.before == null ? "p-seq-end" : "p-seq-insert");
  for (const el of rows) if (PR.rowDrag?.ids?.includes(+el.dataset.id)) el.classList.add("p-seq-drag");
}
function prSeqDraw(gl, vp, r) {
  const labels = $("p-seq-labels");
  labels.replaceChildren();
  if (!r) return;
  const bad = prSeqBad(r), accent = accentRgb(), danger = prTok("--danger", [1, .23, .19]);
  gl.depthMask(false);
  for (const o of r.items) {
    const col = bad.has(o.id) ? danger : accent;
    const tall = r.tall.find((x) => x.id === o.id);
    if (tall?.why === "rod") {
      const box = sqBox(o.foot), lines = [];
      for (const y of [box.y0, box.y1]) for (let x = 0; x < PR.bed.w; x += 8) {
        lines.push(x, y, .4, Math.min(x + 4, PR.bed.w), y, .4);
      }
      drawSolid(gl, vp, lines, [...prTok("--warning", [1, .58, 0]), .8], gl.LINES);
    }
    const zone = sqGrow(o.foot, r.gap / 2);
    const pts = zone.flatMap(([x, y]) => [x, y, .3]);
    drawSolid(gl, vp, pts, [...col, .18], gl.TRIANGLE_FAN);
    const edges = [];
    zone.forEach((p, i) => {
      const q = zone[(i + 1) % zone.length], length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const n = Math.max(1, Math.ceil(length / 4));
      for (let j = 0; j < n; j++) {
        if (!bad.has(o.id) && j % 2) continue;
        for (const t of [j / n, (j + 1) / n]) edges.push(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, .35);
      }
    });
    drawSolid(gl, vp, edges, [...col, .85], gl.LINES);
    const b = sqBox(o.foot), canvas = gl.canvas;
    const q = plProject(vp, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, o.height + 2]);
    if (!q) continue;
    const label = document.createElement("span");
    label.className = "p-seq-number" + (bad.has(o.id) ? " bad" : "");
    const t = r.tall.find((x) => x.id === o.id);
    label.textContent = r.order[o.id] + (t ? ` · ${fmtDec(o.height, 1)} mm > ${fmtDec(t.limit, 1)} mm` : "");
    const canvasRect = canvas.getBoundingClientRect(), labelRect = labels.getBoundingClientRect();
    label.style.left = canvasRect.left - labelRect.left + (q[0] + 1) / 2 * canvas.clientWidth + "px";
    label.style.top = canvasRect.top - labelRect.top + (1 - q[1]) / 2 * canvas.clientHeight + "px";
    labels.append(label);
  }
  gl.depthMask(true);
}
$("p-seq").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sequence]");
  if (!b || b.disabled) return;
  const value = b.dataset.sequence;
  if ($("s-machine")?.value) advSet("print_sequence", value);
  else {
    const machine = prTowerProfileName()?.machine;
    if (!machine) return;
    SL.memory[machine] = { ...rememberFor(machine), adv: { ...(rememberFor(machine).adv || {}), print_sequence: value } };
    localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
  }
  prTowerChanged();
});
addEventListener("pointercancel", () => { PR.rowDrag = null; prDropEnd(); prSeqDropClear(); });
