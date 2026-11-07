"use strict";
/* The 3D printer view (#34): the pure part, tested by
   scripts/test-printer3d.js. printer3d.js and printer3d/view.js draw
   what these return. */

/* Where each head's spool hangs on a U1, seen from the front: T0 and T1 on
   the left (top, bottom), T2 and T3 on the right. */
const P3D_SPOOLS = [
  { n: 0, side: "left", slot: "top" },
  { n: 1, side: "left", slot: "bottom" },
  { n: 2, side: "right", slot: "top" },
  { n: 3, side: "right", slot: "bottom" },
];

/* The view's turn (radians about the vertical axis) to show a side; a
   positive turn brings the left side forward. */
const P3D_YAW = { left: 0.95, front: 0, right: -0.95, back: Math.PI };

/* The turn that shows `side` from `yaw`, the short way round (the view
   turns freely: yaw is not bounded). */
function p3dYawTo(yaw, side) {
  const base = P3D_YAW[side] ?? 0;
  return base + 2 * Math.PI * Math.round((yaw - base) / (2 * Math.PI));
}

/* The side a turn is closest to (after a drag). */
function p3dSideAt(yaw) {
  let best = "front", gap = Infinity;
  for (const side of Object.keys(P3D_YAW)) {
    const d = Math.abs(p3dYawTo(yaw, side) - yaw);
    if (d < gap) [best, gap] = [side, d];
  }
  return best;
}

/* A zone id from a picked part's names (the model's named groups, from the
   part up): spool of head n, head n (its dock, or the carriage when it is
   the active head), bed, light. Null: nothing clickable. */
function p3dZoneOf(names, active = null) {
  for (const name of names) {
    const spool = ["spoolLeftTop", "spoolLeftBottom", "spoolRightTop", "spoolRightBottom"].indexOf(name);
    if (spool >= 0) return `spool:${spool}`;
    const dock = /^dock([0-3])$/.exec(name);
    if (dock) return `head:${dock[1]}`;
    if (name === "toolhead") return active == null ? null : `head:${active}`;
    if (name === "bed" || name === "light") return name;
  }
  return null;
}

/* What a zone id names: { kind: spool | head | bed | light, n }. */
function p3dParse(zone) {
  const m = /^(spool|head):(\d)$/.exec(zone || "");
  if (m) return { kind: m[1], n: +m[2] };
  return zone === "bed" || zone === "light" ? { kind: zone, n: null } : null;
}

/* The side the view turns to for a zone: a head's (or its spool's) is
   its spool's side; the bed, the light, nothing: the front. */
function p3dSideOf(zone) {
  const z = p3dParse(zone);
  return (z?.kind === "spool" || z?.kind === "head") && P3D_SPOOLS[z.n] ? P3D_SPOOLS[z.n].side : "front";
}

/* A nozzle's glow, 0 (cold) to 1: its way from room temperature to its
   target, or to 200 °C when it has none (cooling down). */
function p3dHeat(temp, target) {
  const room = 40;
  const top = target > room ? target : 200;
  return Math.max(0, Math.min(1, ((temp || 0) - room) / (top - room)));
}

/* The printer card's print lines from the printer's status (printers.js):
   state, job, progress 0–1, layer, elapsed and left (s), the speed factor
   (only when changed from 100 %), the part fan 0–1, the filament used (m). */
function p3dSummary(status) {
  const none = { state: "offline", job: "", progress: null, layer: null, elapsed: null, left: null, speed: null, fan: null, filament: null };
  if (!status || !status.online) return none;
  const printing = status.state === "printing" || status.state === "paused";
  const num = (v) => (printing && Number.isFinite(v) ? v : null);
  const speed = num(status.speed_factor);
  return {
    ...none,
    state: status.state || "standby",
    job: printing ? status.job || "" : "",
    progress: num(status.progress),
    layer: printing && Array.isArray(status.layer) ? status.layer : null,
    elapsed: num(status.elapsed_s),
    left: num(status.remaining_s),
    speed: speed != null && Math.round(speed * 100) !== 100 ? speed : null,
    fan: num(status.fan),
    filament: num(status.filament_mm) != null ? status.filament_mm / 1000 : null,
  };
}

/* The carriage over the bed, in the model's metres from the bed's centre
   (x right, z toward the front), from the printer's position in mm (a
   U1's bed is 270 mm, Y+ toward the back). Null: not known. */
function p3dCarriage(pos, bed = 270) {
  if (!Array.isArray(pos) || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return null;
  return { x: (pos[0] - bed / 2) / 1000, z: (bed / 2 - pos[1]) / 1000 };
}

/* The panel a zone opens: one per head (its spool, its dock or the
   carriage), the bed's, the light's. */
function p3dPanelZone(zone) {
  const z = p3dParse(zone);
  if (!z) return null;
  return z.n == null ? z.kind : `head:${z.n}`;
}

/* The next side round, as a drag to the right (dir 1) or to the left
   (dir -1) turns: front, left, back, right. */
function p3dNextSide(side, dir) {
  const order = ["front", "left", "back", "right"];
  const i = Math.max(0, order.indexOf(side));
  return order[(i + (dir > 0 ? 1 : 3)) % 4];
}

/* The printer card's head rows, from the page's status, Control's state
   (fresher, when read) and each head's spool (ctlSpool): temperature and
   target, active, the spool, and whether the head's sensor sees filament
   (null: not known). */
function p3dRows(st, cs, spools) {
  const noz = st?.nozzles || [];
  const n = Math.max(cs?.heads?.length || 0, noz.length, (st?.filaments || []).length, spools.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const h = cs?.heads?.find((x) => x.index === i), z = noz.find((x) => x.index === i);
    const sp = spools[i] || { present: false, color: null, name: "" };
    const f = (st?.filaments || []).find((x) => x.index === i);
    rows.push({
      n: i,
      temp: h ? h.temp : z ? z.current : null,
      target: h ? h.target : z ? z.target : 0,
      active: cs ? cs.active === i : !!z?.active,
      present: sp.present,
      color: sp.present ? sp.color : null,
      name: sp.name,
      inHead: h && typeof h.filament === "boolean" ? h.filament : null,
      // The spool's details: material and subtype, colour code, brand.
      detail: f && sp.present ? [[f.kind, f.sub_type].filter(Boolean).join(" "), f.color ? f.color.toUpperCase() : "", f.vendor || ""].filter(Boolean) : [],
      // Used by the print under way (a past job's list means nothing).
      used: !!(f?.used && st?.job && (st.state === "printing" || st.state === "paused")),
    });
  }
  return rows;
}

/* An easing for the view's turns (smooth start and end). */
const p3dEase = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

if (typeof module !== "undefined") module.exports = { P3D_SPOOLS, P3D_YAW, p3dYawTo, p3dSideAt, p3dPanelZone, p3dNextSide, p3dRows, p3dZoneOf, p3dParse, p3dSideOf, p3dHeat, p3dSummary, p3dCarriage, p3dEase };
