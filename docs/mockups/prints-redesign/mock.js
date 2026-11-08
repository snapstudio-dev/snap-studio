"use strict";
/* Prints redesign mockup: sample data and the proposals (C chosen).
   Everything below is static sample data (two Snapmaker U1, "now" is
   Monday 16:20). Each field maps to the job store (jobs.rs), the live
   printer status (printers.rs) or is marked as new data in the plan. */

const Q = new URLSearchParams(location.search);
const S = { p: Q.get("p") || "c", v: Q.get("v") || "running", theme: Q.get("theme") || "light" };
if (Q.has("shot")) document.documentElement.classList.add("shot");

/* ------------------------------------------------------------ data */
const C = {
  noir: "#2B2B2D", gris: "#9AA0A6", orange: "#FF7A1A", blanc: "#F2F2EF",
  bleu: "#1E6FD9", pbl: "#EDEDEA", pnoir: "#26282B", vert: "#3FAE5A", rouge: "#D93A3A", jaune: "#F5C400",
};
const HEADS = {
  atelier: [["PLA Noir mat", C.noir], ["PLA Gris", C.gris], ["PLA Orange", C.orange], ["PLA Blanc", C.blanc]],
  bureau: [["PETG Bleu", C.bleu], ["PETG Blanc", C.pbl], ["PETG Noir", C.pnoir], null],
};
const PRN = { atelier: "U1 Atelier", bureau: "U1 Bureau" };

const I = {
  printer: '<svg viewBox="0 0 24 24"><path d="M7 3h10v4H7zm-2 6h14a2 2 0 0 1 2 2v5h-4v-3H7v3H3v-5a2 2 0 0 1 2-2m2 6h10v6H7z"/></svg>',
  spool: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6m0-4a7 7 0 0 1 6.9 6h-3a4 4 0 0 0-7.8 0h-3A7 7 0 0 1 12 5"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M21.7 6.3a5.5 5.5 0 0 1-7.4 6.7L6.7 20.6a2 2 0 0 1-2.8-2.8L11.5 10.2a5.5 5.5 0 0 1 6.7-7.4l-3.4 3.4.7 2.8 2.8.7z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5h11v11h-11z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3m0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7"/></svg>',
  cube: '<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5 8.2v7.6l7 3.9 7-3.9V8.2z"/></svg>',
  film: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zm2 2v2h2V6zm10 0v2h2V6zM6 10v4h12v-4zm0 6v2h2v-2zm10 0v2h2v-2z"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><path d="M3 15h18v3H3zm2-7h14l2 5H3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  grip: "⋮⋮",
};

/* Thumbnails: little drawings standing in for the G-code thumbnails. */
const shade = (c, k) => `color-mix(in srgb, ${c} ${100 - k}%, black)`;
function thumb(kind, cols, size = "s36") {
  const [a, b = a, c = b, d = c] = cols;
  const s = {
    helmet: `<ellipse cx="32" cy="54" rx="20" ry="5" style="fill:${shade(a, 25)}"/><rect x="12" y="47" width="40" height="7" rx="3" style="fill:${a}"/>
      <rect x="28" y="22" width="8" height="27" style="fill:${b}"/><rect x="28" y="22" width="3" height="27" style="fill:${shade(b, 15)}"/>
      <path d="M12 26a20 15 0 0 1 40 0z" style="fill:${c}"/><path d="M12 26h40v3H12z" style="fill:${d}"/>`,
    boat: `<path d="M8 40h48l-6 12H16z" style="fill:${a}"/><path d="M8 40h48l-2 4H10z" style="fill:${shade(a, -40)};opacity:.5"/>
      <rect x="22" y="26" width="20" height="14" rx="2" style="fill:${shade(a, 12)}"/><rect x="26" y="30" width="5" height="5" rx="1" style="fill:${shade(a, 45)}"/><rect x="34" y="30" width="5" height="5" rx="1" style="fill:${shade(a, 45)}"/>
      <rect x="35" y="16" width="5" height="10" style="fill:${shade(a, 25)}"/>`,
    box: `<path d="M32 14 54 24 32 34 10 24z" style="fill:${shade(a, -30)}"/><path d="M10 24l22 10v18L10 42z" style="fill:${a}"/><path d="M54 24 32 34v18l22-10z" style="fill:${shade(a, 22)}"/>`,
    vase: `<path d="M24 10h16c0 6-6 8-6 14 0 6 12 10 12 20 0 7-5 10-14 10s-14-3-14-10c0-10 12-14 12-20 0-6-6-8-6-14z" style="fill:${a}"/>
      <path d="M24 10h16c0 6-6 8-6 14 0 6 12 10 12 20 0 7-5 10-14 10" style="fill:${shade(a, 18)}"/>
      <path d="M22 26h20M19 36h26M19 46h26" style="stroke:${shade(a, 30)};stroke-width:.8;opacity:.6"/>`,
    key: `<rect x="12" y="18" width="40" height="28" rx="8" style="fill:${a}"/><circle cx="20" cy="26" r="3.5" style="fill:var(--thumb-hole, #e9e9ed)"/>
      <path d="M30 38c2 2 10 2 12-1s-2-5-6-6-7-3-5-6 9-2 11 0" style="fill:none;stroke:${b};stroke-width:3.5;stroke-linecap:round"/>`,
    tray: `<path d="M32 18 56 28 32 38 8 28z" style="fill:${shade(a, -25)}"/><path d="M8 28l24 10v12L8 40z" style="fill:${a}"/><path d="M56 28 32 38v12l24-10z" style="fill:${shade(a, 20)}"/>
      <path d="M20 23l24 10M26 20.5 14 31.5M38 25.5l-12 11" style="stroke:${shade(a, 35)};stroke-width:1.6"/>`,
    clip: `<g style="fill:none;stroke:${a};stroke-width:5;stroke-linecap:round"><path d="M14 22a7 7 0 1 0 8 0"/><path d="M30 22a7 7 0 1 0 8 0"/><path d="M46 22a7 7 0 1 0 8 0"/><path d="M14 42a7 7 0 1 0 8 0"/><path d="M30 42a7 7 0 1 0 8 0"/><path d="M46 42a7 7 0 1 0 8 0"/></g>`,
    owl: `<ellipse cx="32" cy="38" rx="16" ry="18" style="fill:${a}"/><path d="M18 22l6 6M46 22l-6 6" style="stroke:${a};stroke-width:5"/>
      <circle cx="26" cy="32" r="6" style="fill:${b}"/><circle cx="38" cy="32" r="6" style="fill:${b}"/><circle cx="26" cy="32" r="2.5" style="fill:${shade(a, 50)}"/><circle cx="38" cy="32" r="2.5" style="fill:${shade(a, 50)}"/>
      <path d="M30 38l2 4 2-4z" style="fill:${c}"/>`,
    gear: `<path d="M29 8h6l1 6 5 2 5-4 4 4-4 5 2 5 6 1v6l-6 1-2 5 4 5-4 4-5-4-5 2-1 6h-6l-1-6-5-2-5 4-4-4 4-5-2-5-6-1v-6l6-1 2-5-4-5 4-4 5 4 5-2z" style="fill:${a}"/><circle cx="32" cy="32" r="8" style="fill:var(--thumb-hole, #e9e9ed)"/>`,
    plate: `<path d="M10 40 32 28l22 12-22 12z" style="fill:${shade(a, -30)}"/><rect x="24" y="22" width="16" height="14" style="fill:${a}"/>`,
  }[kind];
  return `<span class="th ${size}"><svg viewBox="0 0 64 64">${s}</svg></span>`;
}

const J = {
  casque: { name: "Support casque", kind: "helmet", cols: [C.noir, C.gris, C.orange, C.blanc], prn: "atelier" },
  benchy: { name: "Benchy", kind: "boat", cols: [C.bleu], prn: "bureau" },
  cles: { name: "Porte-clés logo", kind: "key", cols: [C.blanc, C.orange], prn: "atelier", t: "42 min", start: "18:20", tools: [3, 2] },
  orga: { name: "Organiseur de tiroir", kind: "tray", cols: [C.pnoir], prn: "bureau", t: "3 h 05", start: "~17:45", tools: [2] },
  vase: { name: "Vase spirale", kind: "vase", cols: [C.orange], prn: "atelier", t: "1 h 48", start: "~19:05", tools: [2] },
  clip: { name: "Clip câble ×12", kind: "clip", cols: [C.pnoir], prn: "bureau", t: "38 min", start: "~20:53", tools: [2] },
  boite: { name: "Boîte de rangement", kind: "box", cols: [C.gris], prn: "atelier" },
  chouette: { name: "Figurine chouette", kind: "owl", cols: [C.bleu, C.pbl, C.jaune], prn: "bureau" },
};
const QUEUE = [J.cles, J.orga, J.vase, J.clip];
const HIST = [
  { ...J.boite, when: "Aujourd'hui", at: "11:42", dur: "2 h 32", g: "86,4 g", st: "complete", day: "today", cols: [C.gris] },
  { ...J.chouette, when: "Aujourd'hui", at: "09:05", dur: "55 min", g: "21,8 g", st: "cancelled", day: "today", why: "Décollement" },
  { name: "Support casque (v1)", kind: "helmet", cols: [C.noir, C.gris, C.orange, C.blanc], prn: "atelier", when: "Hier", at: "21:14", dur: "5 h 02", g: "151,2 g", st: "complete", day: "yday" },
  { name: "Engrenage test", kind: "gear", cols: [C.rouge], prn: "bureau", when: "Hier", at: "15:37", dur: "1 h 12", g: "18,0 g", st: "error", day: "yday", why: "Buse bouchée" },
  { name: "Benchy", kind: "boat", cols: [C.vert], prn: "atelier", when: "Hier", at: "10:06", dur: "1 h 26", g: "14,9 g", st: "complete", day: "yday" },
  { name: "Plaque de test ABL", kind: "plate", cols: [C.blanc], prn: "bureau", when: "Sam. 24", at: "18:40", dur: "24 min", g: "6,2 g", st: "complete", day: "sat" },
  { name: "Pot à crayons", kind: "vase", cols: [C.vert], prn: "atelier", when: "Sam. 24", at: "16:02", dur: "2 h 10", g: "64,1 g", st: "complete", day: "sat" },
];
const ST = { printing: "En impression", paused: "En pause", queued: "En attente", complete: "Terminée", cancelled: "Annulée", error: "Erreur" };
const badge = (s, label) => `<span class="pj-badge ${s}">${label || ST[s]}</span>`;
const heads = (prn, on, use) =>
  HEADS[prn].map((h, i) => (h ? `<span class="hd${i === on ? " on" : ""}${use && !use.includes(i) ? " off" : ""}" style="--c:${h[1]}" title="${h[0]}"><i></i>T${i}</span>` : "")).join("");
const dots = (cols) => `<span class="dots">${cols.map((c) => `<i style="--c:${c}"></i>`).join("")}</span>`;
const sideRing = (p) => {
  const r = 6, c = 2 * Math.PI * r;
  return `<svg class="pj-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${r}" class="track"/><circle cx="8" cy="8" r="${r}" class="bar" stroke-dasharray="${(p * c).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
};
function ring(p, size, stroke, inner) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<div class="mkring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}"><circle class="t" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
    <circle class="b" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${(p * c).toFixed(1)} ${c.toFixed(1)}"/></svg><div class="c">${inner}</div></div>`;
}

/* Camera frame: a drawn U1 chamber with the part being printed. */
let camN = 0;
function cam({ part = "helmet", cols = J.casque.cols, h = 0.62, paused = false, tags = true, done = false, play = false, extra = "" } = {}) {
  const id = "cg" + camN++;
  const top = 128 - Math.round(70 * h);
  const [a, b, c2, d] = [cols[0], cols[1] || cols[0], cols[2] || cols[0], cols[3] || cols[0]];
  let obj = "";
  if (part === "helmet") {
    obj = `<clipPath id="${id}c"><rect x="0" y="${top}" width="320" height="200"/></clipPath><g clip-path="url(#${id}c)">
      <ellipse cx="160" cy="128" rx="44" ry="9" fill="${shade(a, 20)}"/><rect x="116" y="116" width="88" height="12" rx="4" fill="${a}"/>
      <rect x="152" y="70" width="16" height="48" fill="${b}"/><rect x="152" y="70" width="5" height="48" fill="${shade(b, 20)}"/>
      <path d="M118 74a42 30 0 0 1 84 0z" fill="${c2}"/><rect x="118" y="72" width="84" height="5" fill="${d}"/></g>`;
  } else if (part === "boat") {
    obj = `<clipPath id="${id}c"><rect x="0" y="${top}" width="320" height="200"/></clipPath><g clip-path="url(#${id}c)">
      <path d="M118 106h84l-10 22h-64z" fill="${a}"/><rect x="138" y="82" width="40" height="24" rx="3" fill="${shade(a, 12)}"/><rect x="164" y="64" width="9" height="18" fill="${shade(a, 25)}"/></g>`;
  } else if (part === "box") {
    obj = `<path d="M160 70 206 88 160 106 114 88z" fill="${shade(a, -25)}"/><path d="M114 88l46 18v26l-46-18z" fill="${a}"/><path d="M206 88 160 106v26l46-18z" fill="${shade(a, 22)}"/>`;
  }
  const nozzleY = top - 4;
  const head = done ? "" : `<g><rect x="40" y="${nozzleY - 30}" width="240" height="5" fill="#3a3f47"/><rect x="${part === "boat" ? 150 : 166}" y="${nozzleY - 34}" width="34" height="28" rx="4" fill="#d9dce1"/>
      <rect x="${part === "boat" ? 150 : 166}" y="${nozzleY - 34}" width="34" height="6" rx="3" fill="#ff7a1a"/><path d="M${part === "boat" ? 163 : 179} ${nozzleY - 6}h8l-4 6z" fill="#8a8f98"/></g>`;
  return `<div class="cam">
    <svg class="scene" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
      <defs><radialGradient id="${id}g" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="#3b414b"/><stop offset=".65" stop-color="#1b1f25"/><stop offset="1" stop-color="#0c0e11"/></radialGradient>
      <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f36"/><stop offset="1" stop-color="#4a505a"/></linearGradient>
      <radialGradient id="${id}v" cx="50%" cy="50%" r="70%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient></defs>
      <rect width="320" height="180" fill="url(#${id}g)"/>
      <path d="M0 40 60 52M320 40 260 52" stroke="#2c3138" stroke-width="2"/>
      <path d="M36 168 74 104h172l38 64z" fill="url(#${id}b)"/>
      <path d="M74 104h172M60 128h200M48 148h224" stroke="#5a616c" stroke-width=".6" opacity=".6"/>
      ${obj}${head}
      <rect width="320" height="180" fill="url(#${id}v)"/>
    </svg>
    ${tags ? (paused ? `<span class="cam-tag pause"><i></i>EN PAUSE</span>` : done ? "" : `<span class="cam-tag"><i></i>EN DIRECT</span>`) : ""}
    ${play ? `<span class="cam-play">${I.play}</span>` : ""}${extra}
  </div>`;
}

/* ------------------------------------------------------------ chrome */
function renderSide() {
  $("side-prints").innerHTML =
    `<button class="side-item"><span class="glyph" style="color:var(--accent)">${sideRing(0.62)}</span><span class="lbl">Support casque</span><span class="count">62 %</span></button>
     <button class="side-item"><span class="glyph" style="color:var(--warning)">${sideRing(0.43)}</span><span class="lbl">Benchy</span><span class="count">pause</span></button>` +
    QUEUE.map((q, i) => `<button class="side-item"><span class="glyph pj-num">${i + 1}</span><span class="lbl">${q.name}</span></button>`).join("");
  $("side-printers").innerHTML = ["atelier", "bureau"].map((k) =>
    `<button class="side-item"><span class="glyph" style="color:#34C759">${I.printer}</span><span class="lbl">${PRN[k]}</span><span class="led busy"></span></button>
     <div class="side-group side-sub">
       <button class="side-item"><span class="glyph" style="color:#34C759">${I.spool}</span><span class="lbl">Têtes et bobines</span></button>
       <button class="side-item"><span class="glyph" style="color:#8E8E93">${I.wrench}</span><span class="lbl">Entretien</span></button>
       <button class="side-item"><span class="glyph" style="color:#1E8CFF">${I.folder}</span><span class="lbl">Fichiers</span><span class="count">${k === "atelier" ? 14 : 9}</span></button>
     </div>`).join("");
}
function $(id) { return document.getElementById(id); }
function toolbar({ back = false, title, sub = "", right = "", tabs = "" }) {
  $("toolbar").innerHTML = `
    ${back ? `<div class="tb-actions tb-lead on"><button class="tb-btn">${I.back}</button></div>` : ""}
    <div class="tb-title"><h1>${title}</h1><span id="tb-sub">${sub}</span></div>
    ${tabs ? `<div class="tb-actions on">${tabs}</div>` : ""}
    <div class="tb-spacer"></div>
    <div class="tb-actions on">${right}<span class="mk-tag">Maquette · données d'exemple</span></div>`;
}
const seg = (items, on, cls = "") => `<div class="seg ${cls}">${items.map((t, i) => `<button class="seg-btn${i === on ? " on" : ""}">${t}</button>`).join("")}</div>`;

/* shared detail blocks */
const FIL = [[0, "PLA Noir mat", 62.4, "20,9 m"], [1, "PLA Gris", 38.1, "12,8 m"], [2, "PLA Orange", 21.7, "7,3 m"], [3, "PLA Blanc", 26.4, "8,9 m"]];
function filRows(temps = true) {
  return FIL.map(([t, n, g, m]) => `<div class="fil" style="--c:${HEADS.atelier[t][1]}"><i></i><b>T${t}</b>
    <div class="nm"><span>${n}</span><div class="bar"><i style="width:${(g / 62.4) * 100}%"></i></div></div>
    <em>${String(g).replace(".", ",")} g<br><span class="muted" style="font-size:11px">${m}</span></em>
    <span class="t">${temps ? (t === 2 ? "<b style='color:var(--text)'>220 °C</b><br>active" : "170 °C<br>en attente") : ""}</span></div>`).join("") +
    `<div class="fil-tot"><span class="muted">Total · coût estimé</span><b class="num">148,6 g · 3,12 €</b></div>`;
}
const FEAT = [["Paroi externe", 31, "#ff9500"], ["Remplissage", 24, "#af52de"], ["Paroi interne", 18, "#ffcc00"], ["Supports", 9, "#30b0c7"], ["Tour d'amorçage", 8, "#8e8e93"], ["Dessus et dessous", 6, "#ff2d55"], ["Déplacements", 4, "#5856d6"]];
function features() {
  return `<div class="stack">${FEAT.map(([, p, c]) => `<i style="width:${p}%;background:${c}"></i>`).join("")}</div>
    <div class="legend">${FEAT.map(([n, p, c]) => `<div><i style="background:${c}"></i>${n}<em>${p} %</em></div>`).join("")}</div>`;
}
function chronoRun() {
  return `<div class="chrono">
    <div class="done"><time>12:40</time><span>Découpée <small>· 0.20mm Standard</small></span></div>
    <div class="done"><time>12:41</time><span>Ajoutée à la file</span></div>
    <div class="done"><time>13:08</time><span>Lancée <small>· nivellement, timelapse</small></span></div>
    <div class="done"><time>13:19</time><span>Première couche terminée</span></div>
    <div class="now"><time>16:20</time><span><b>Couche 187 / 302</b> <small>· T2 active</small></span></div>
    <div><time class="fut">18:18</time><span class="fut">Fin estimée, puis timelapse</span></div>
  </div>`;
}
function layerBars(n = 96, at = 0.62) {
  // Time per layer, from layer_end_s: short raft layers, long middle (the dome), short top.
  let html = "";
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const h = 22 + 50 * Math.exp(-((x - 0.18) ** 2) / 0.006) * 0.6 + 38 * (x > 0.62 ? Math.max(0, 1 - (x - 0.62) * 2.6) : x * 0.9) + 8 * Math.sin(i * 1.7) ** 2;
    const cls = x < at - 1 / n ? "d" : x < at ? "c" : "";
    html += `<i class="${cls}" style="height:${Math.min(100, h)}%"></i>`;
  }
  return `<div class="layers">${html}</div>`;
}

/* ====================================================== A: dashboard */
function liveTile(k) {
  const run = k === "atelier";
  return `<div class="card pa-tile">
    ${run ? cam() : cam({ part: "boat", cols: J.benchy.cols, h: 0.43, paused: true })}
    <div class="info">
      <div class="pa-prn">${I.printer}${PRN[k]}<span class="led busy"></span><span class="grow"></span>
        <button class="tb-btn" title="${run ? "Pause" : "Reprendre"}">${run ? I.pause : I.play}</button><button class="tb-btn danger" title="Annuler l'impression">${I.stop}</button></div>
      <div class="row">${run ? thumb("helmet", J.casque.cols, "s28") : thumb("boat", J.benchy.cols, "s28")}<span class="pa-name ell grow">${run ? "Support casque" : "Benchy"}</span>${badge(run ? "printing" : "paused")}</div>
      <div class="pa-prog"><div class="progress"><i style="width:${run ? 62 : 43}%;${run ? "" : "background:var(--warning)"}"></i></div><b>${run ? 62 : 43} %</b></div>
      <div class="pa-meta">${run ? "Couche <b>187 / 302</b> · reste <b>1 h 58</b> · fin vers <b>18:18</b>" : "Couche <b>88 / 205</b> · en pause depuis <b>49 min</b>"}</div>
      <div class="pa-heads">${run ? heads("atelier", 2) : heads("bureau", 0, [0])}</div>
      <div class="chips" style="margin-top:auto">${run
        ? `<span class="chip">Buse <b>220 °C</b></span><span class="chip">Plateau <b>60 °C</b></span><span class="chip">Caisson <b>34 °C</b></span>`
        : `<span class="chip">Buse <b>140 °C</b></span><span class="chip">Plateau <b>80 °C</b></span><span class="chip">Reste <b>1 h 22</b></span>`}</div>
    </div></div>`;
}
function statsStrip() {
  const spark = (v) => `<span class="spark">${v.map((h) => `<i style="height:${h}%"></i>`).join("")}</span>`;
  return `<div class="pa-stats">
      <div class="card pa-stat"><div class="row"><small>Temps d'impression</small>${spark([40, 65, 30, 80, 55, 90, 70])}</div><b>38 h 20</b><span class="sub">25 impressions sur 7 jours</span></div>
      <div class="card pa-stat"><small>Filament utilisé</small><b>2,41 kg</b>
        <div class="stack" style="height:7px"><i style="width:58%;background:${C.noir}"></i><i style="width:13%;background:${C.orange}"></i><i style="width:14%;background:${C.bleu}"></i><i style="width:15%;background:${C.gris}"></i></div>
        <span class="sub">PLA 1,72 kg · PETG 0,69 kg</span></div>
      <div class="card pa-stat"><small>Coût estimé</small><b>51,30 €</b><span class="sub">D'après le prix au kilo des profils filament</span></div>
      <div class="card pa-stat"><div class="row"><div class="grow" style="display:flex;flex-direction:column;gap:4px"><small>Taux de réussite</small><b>92 %</b></div>${ring(0.92, 46, 5, "")}</div><span class="sub">23 terminées · 1 annulée · 1 erreur</span></div>
    </div>`;
}
function queueRows() {
  return QUEUE.map((q, i) => `<div class="pa-q"><span class="grip">${I.grip}</span><span class="n">${i + 1}</span>${thumb(q.kind, q.cols)}
            <span class="t" style="min-width:0"><b class="ell">${q.name}</b><small>${PRN[q.prn]} · ${q.t} · ${dots(q.cols)}</small></span>
            <span class="w">début ${q.start}<small>${i === 0 ? "après Support casque" : i === 1 ? "à la reprise de Benchy" : "plateau à vider avant"}</small></span></div>`).join("");
}
function renderAOverview() {
  toolbar({ title: "Impressions", sub: "2 en cours · 4 en attente", right: seg(["7 jours", "30 jours", "Tout"], 0) });
  $("view").innerHTML = `<div class="mk-scroll"><div class="pa">
    ${statsStrip()}
    <div>
      <div class="sec"><span class="vp-section">En cours</span><small>2 imprimantes sur 2 occupées</small></div>
      <div class="pa-live">${liveTile("atelier")}${liveTile("bureau")}</div>
    </div>
    <div class="pa-bottom">
      <div class="card">
        <div class="card-head"><h3>File d'attente</h3><small>4 · 6 h 13 au total</small><span class="link">Glisser pour réordonner</span></div>
        <div class="pa-list">
          ${QUEUE.map((q, i) => `<div class="pa-q"><span class="grip">${I.grip}</span><span class="n">${i + 1}</span>${thumb(q.kind, q.cols)}
            <span class="t" style="min-width:0"><b class="ell">${q.name}</b><small>${PRN[q.prn]} · ${q.t} · ${dots(q.cols)}</small></span>
            <span class="w">début ${q.start}<small>${i === 0 ? "après Support casque" : i === 1 ? "à la reprise de Benchy" : "plateau à vider avant"}</small></span></div>`).join("")}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Historique</h3>${seg(["Toutes", "Terminées", "Problèmes"], 0, "compact")}</div>
        <div class="pa-h head"><span></span><span>Impression</span><span>Imprimante</span><span>Durée</span><span>Filament</span><span class="r">État</span></div>
        ${HIST.slice(0, 6).map((h) => `<div class="pa-h">${thumb(h.kind, h.cols)}<span style="min-width:0"><b class="ell" style="display:block">${h.name}</b><span class="sub">${h.when} · ${h.at}</span></span>
          <span>${PRN[h.prn]}</span><span class="num">${h.dur}</span><span class="row num">${dots(h.cols)} ${h.g}</span><span class="r">${badge(h.st)}</span></div>`).join("")}
      </div>
    </div>
  </div></div>`;
}
function renderADetail() {
  toolbar({ back: true, title: "Support casque", sub: "En impression · U1 Atelier", right: `<button class="tb-btn labeled">${I.printer}<span>Voir l'imprimante</span></button>` });
  $("view").innerHTML = `<div class="mk-scroll"><div class="pa-d">
    <div class="pa-d-hero">
      ${cam({ extra: `<span class="cam-tag r">${I.full.replace("<svg", '<svg style="width:12px;height:12px;fill:#fff"')}</span><span class="cam-tag b">Couche 187 / 302</span>` })}
      <div class="card pa-d-side">
        <div class="kick">${badge("printing")}<span>U1 Atelier · lancée à 13:08</span></div>
        <div class="pa-d-ring">${ring(0.62, 132, 11, "<b>62 %</b><span>reste 1 h 58</span>")}
          <div class="facts" style="flex:1"><div><small>Fin vers</small><b>18:18</b></div><div><small>Écoulé</small><b>3 h 12</b></div><div><small>Couche</small><b>187 / 302</b></div><div><small>Vitesse</small><b>100 %</b></div></div></div>
        <div class="temps"><div>Buse T2<b>220 / 220 °C</b></div><div>Plateau<b>60 / 60 °C</b></div><div>Caisson<b>34 °C</b></div></div>
        <div class="btns"><button class="btn">${I.pause.replace("<svg", '<svg style="width:13px;height:13px"')}Pause</button><button class="btn danger">Annuler l'impression</button><span class="grow"></span><button class="btn">Voir les trajectoires</button></div>
      </div>
    </div>
    <div class="pa-d-grid">
      <div class="card panel"><h3>Têtes et filament<small>par tête, d'après la découpe</small></h3>${filRows()}</div>
      <div class="card panel"><h3>Temps par type<small>4 h 58 estimées</small></h3>${features()}
        <div class="pa-d-chips" style="margin-top:12px"><span class="chip">0.20mm Standard</span><span class="chip">PEI texturée</span><span class="chip">Nivellement</span><span class="chip">Timelapse</span></div></div>
      <div class="card panel"><h3>Déroulé</h3>${chronoRun()}</div>
    </div>
  </div></div>`;
}

/* ====================================================== B: agenda */
let T0 = 8 * 60, SPAN = 16 * 60;
const pos = (a, b) => `left:${((a - T0) / SPAN) * 100}%;width:${((b - a) / SPAN) * 100}%`;
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
function blk(cls, a, b, inner, extra = "") {
  return `<div class="pb-blk ${cls}" style="${pos(hm(a), hm(b))}">${extra}${inner}</div>`;
}
function lanes(sel) {
  const now = hm("16:20");
  const nowX = ((now - T0) / SPAN) * 100;
  const clear = (t) => `<span class="pb-clear" style="left:${((hm(t) - T0) / SPAN) * 100}%">${I.bed}vider</span>`;
  const axis = (SPAN > 12 * 60 ? [8, 10, 12, 14, 18, 20, 22] : [12, 14, 18, 20]).map((h) => `<span style="left:${((h * 60 - T0) / SPAN) * 100}%">${String(h % 24).padStart(2, "0")}:00</span>`).join("");
  const lane = (k, sub, blocks) => `<div class="pb-lane"><div class="pb-lh"><span class="nm">${I.printer}${PRN[k]}<span class="led busy"></span></span>
      <small>${sub}</small><span class="row" style="gap:8px">${heads(k)}</span></div>
      <div class="pb-track" style="--cols:${SPAN / 60}">${blocks}<div class="pb-now" style="left:${nowX}%"></div></div></div>`;
  return `<div class="card pb-tl">
    <div class="pb-axis"><div class="day">Lundi 26 octobre</div><div>${axis}<span class="pb-nowlbl" style="left:${nowX}%">16:20</span></div></div>
    ${lane("atelier", "Libre vers 20:53",
      blk("done", "09:10", "11:42", `<span class="thc">${thumb("box", [C.gris], "s28")}<span style="min-width:0"><b>Boîte de rangement</b><small>09:10 – 11:42</small></span></span>`) +
      blk(`run${sel ? " sel" : ""}`, "13:08", "18:18", `<span class="thc">${thumb("helmet", J.casque.cols, "s28")}<span style="min-width:0"><b>Support casque · 62 %</b><small>13:08 – 18:18 · couche 187 / 302</small></span></span>`, `<span class="fill" style="width:62%"></span>`) +
      clear("18:19") +
      blk("q ico", "18:20", "19:02", thumb("key", J.cles.cols, "s28")) +
      blk("q", "19:05", "20:53", `<b>Vase spirale</b><small>~19:05 · 1 h 48</small>`) +
      `<span class="pb-free" style="left:${((hm("20:53") - T0) / SPAN) * 100}%">libre</span>`)}
    ${lane("bureau", "En pause depuis 49 min",
      blk("bad ico", "08:10", "09:05", thumb("owl", J.chouette.cols, "s28")) +
      blk("run", "14:30", "17:42", `<span class="thc">${thumb("boat", J.benchy.cols, "s28")}<span style="min-width:0"><b>Benchy · en pause</b><small>14:30 – ~17:42 si reprise</small></span></span>`,
        `<span class="fill" style="width:${(61 / 192) * 100}%"></span><span class="hatch" style="left:${(61 / 192) * 100}%;width:${(49 / 192) * 100}%"></span>`) +
      blk("q", "17:45", "20:50", `<b>Organiseur de tiroir</b><small>~17:45 · 3 h 05</small>`) +
      blk("q ico", "20:53", "21:31", thumb("clip", J.clip.cols, "s28")) +
      `<span class="pb-free" style="left:${((hm("21:31") - T0) / SPAN) * 100}%">libre</span>`)}
  </div>`;
}
function bToolbar() {
  toolbar({ title: "Impressions", sub: "2 en cours · 4 en attente", tabs: seg(["Jour", "3 jours", "Semaine"], 0),
    right: `<div class="tb-group"><button class="tb-btn">${I.back}</button><button class="tb-btn labeled"><span>Maintenant</span></button><button class="tb-btn">${I.fwd}</button></div>` });
}
function renderBOverview() {
  T0 = 8 * 60; SPAN = 16 * 60;
  bToolbar();
  const day = (d, sub, a, b, s1, s2) => `<div class="pb-day"><div class="d"><b>${d}</b><small>${sub}</small></div>
    <div class="pb-mini"><div>${a}</div><div>${b}</div></div><div class="s">${s1}<small>${s2}</small></div></div>`;
  const m = (cls, a, b) => `<i class="${cls}" style="${pos(hm(a), hm(b))}"></i>`;
  $("view").innerHTML = `<div class="pb-wrap"><div class="pb-main">
    ${lanes(false)}
    <div class="pb-lower">
      <div class="card">
        <div class="card-head"><h3>Jours précédents</h3><small>une ligne par imprimante, de 08:00 à minuit</small><span class="link">Rechercher dans l'historique</span></div>
        ${day("Dimanche 25", "3 impressions", m("ok", "10:06", "11:32") + m("ok", "16:12", "21:14"), m("ko", "14:25", "15:37"), "7 h 40", "2 terminées · 1 erreur")}
        ${day("Samedi 24", "2 impressions", m("ok", "13:52", "16:02"), m("ok", "18:16", "18:40"), "2 h 34", "2 terminées")}
        ${day("Vendredi 23", "4 impressions", m("ok", "08:30", "12:10") + m("ok", "19:00", "22:45"), m("ok", "09:15", "10:02") + m("ok", "17:20", "20:05"), "10 h 52", "4 terminées")}
        ${day("Jeudi 22", "2 impressions", m("ok", "20:10", "23:55"), m("ko", "11:00", "11:35"), "4 h 20", "1 terminée · 1 annulée")}
        ${day("Mercredi 21", "3 impressions", m("ok", "09:40", "13:20"), m("ok", "10:05", "11:50") + m("ok", "18:30", "22:10"), "9 h 05", "3 terminées")}
        ${day("Mardi 20", "1 impression", m("ok", "14:00", "19:45"), "", "5 h 45", "1 terminée")}
      </div>
      <div class="card panel">
        <h3>Aujourd'hui<small>depuis 08:00</small></h3>
        <div class="pb-occ">
          <div class="l"><span>U1 Atelier</span><div class="progress"><i style="width:68%"></i></div><b class="num">68 %</b></div>
          <div class="l"><span>U1 Bureau</span><div class="progress"><i style="width:36%"></i></div><b class="num">36 %</b></div>
        </div>
        <div class="facts" style="margin-top:12px"><div><small>Temps d'impression</small><b>6 h 40</b></div><div><small>Filament</small><b>176,4 g</b></div><div><small>Terminées</small><b>1</b></div><div><small>Annulées / erreurs</small><b>1</b></div></div>
        <p class="muted" style="font-size:12px;margin:12px 0 0">Les deux imprimantes seront libres vers <b style="color:var(--text)">21:31</b> si la file part sans attendre. Le plateau est à vider entre deux impressions.</p>
      </div>
    </div>
  </div></div>`;
}
function renderBDetail() {
  T0 = 11 * 60; SPAN = 11 * 60;
  bToolbar();
  $("view").innerHTML = `<div class="pb-wrap"><div class="pb-main">
    ${lanes(true)}
    <div class="card">
      <div class="card-head"><h3>Jours précédents</h3><small>une ligne par imprimante</small></div>
      <div class="pb-day"><div class="d"><b>Dimanche 25</b><small>3 impressions</small></div><div class="pb-mini"><div><i class="ok" style="${pos(hm("10:06"), hm("11:32"))}"></i><i class="ok" style="${pos(hm("16:12"), hm("21:14"))}"></i></div><div><i class="ko" style="${pos(hm("14:25"), hm("15:37"))}"></i></div></div><div class="s">7 h 40<small>2 terminées · 1 erreur</small></div></div>
      <div class="pb-day"><div class="d"><b>Samedi 24</b><small>2 impressions</small></div><div class="pb-mini"><div><i class="ok" style="${pos(hm("13:52"), hm("16:02"))}"></i></div><div><i class="ok" style="${pos(hm("18:16"), hm("18:40"))}"></i></div></div><div class="s">2 h 34<small>2 terminées</small></div></div>
    </div>
  </div>
  <aside class="pb-insp">
    <div class="hd0">${thumb("helmet", J.casque.cols, "s40")}<div><b>Support casque</b><span class="kick">${badge("printing")} U1 Atelier</span></div><span class="x">✕</span></div>
    <div class="body">
      ${cam({ extra: `<span class="cam-tag b">Couche 187 / 302</span>` })}
      <div class="pa-prog"><div class="progress"><i style="width:62%"></i></div><b>62 %</b></div>
      <div class="facts"><div><small>Fin vers</small><b>18:18</b></div><div><small>Reste</small><b>1 h 58</b></div><div><small>Écoulé</small><b>3 h 12</b></div><div><small>Estimation découpe</small><b>4 h 58</b></div></div>
      ${seg(["Suivi", "Découpe", "Déroulé"], 0, "")}
      <div class="group">
        ${FIL.map(([t, n, g]) => `<div class="grow-row"><span class="hd${t === 2 ? " on" : ""}" style="--c:${HEADS.atelier[t][1]}"><i></i>T${t}</span><span class="k">${n}</span><span class="v">${String(g).replace(".", ",")} g · ${t === 2 ? "220 °C" : "170 °C"}</span></div>`).join("")}
        <div class="grow-row"><span class="k">Plateau · caisson</span><span class="v">60 °C · 34 °C</span></div>
      </div>
      <div class="pa-d-chips"><span class="chip">0.20mm Standard</span><span class="chip">PEI texturée</span><span class="chip">Nivellement</span><span class="chip">Timelapse</span></div>
      <div class="muted" style="font-size:12px">Ensuite sur U1 Atelier : <b style="color:var(--text)">Porte-clés logo</b> à 18:20, après avoir vidé le plateau.</div>
    </div>
    <div class="foot"><button class="btn">Pause</button><button class="btn danger">Annuler</button><button class="btn">${I.more}</button></div>
  </aside></div>`;
}

/* ====================================================== C: master–detail (chosen)
   No stats strip on this page: period stats move to the printer page
   (new tabs) and a Statistics page, in a follow-up. The sidebar keeps its
   Prints submenu as today: running prints with progress, then the queue. */
function cList(sel) {
  const r = (o, s, inner, meta) => `<div class="pc-r${s ? " sel" : ""}">${thumb(o.kind, o.cols, "s40")}<div class="t">${inner}</div><div class="m">${meta}</div></div>`;
  return `<div class="pc-list">
    <div class="pc-tools">
      <div class="pc-search">${I.search}<span>Rechercher une impression, un fichier…</span><kbd>⌘F</kbd></div>
      ${seg(["Tout", "Actives <em>6</em>", "Terminées", "Échecs <em>2</em>"], 0)}
      <div class="pc-chips"><span class="chip">${I.printer}U1 Atelier</span><span class="chip">${I.printer}U1 Bureau</span><span class="chip"><i class="d" style="--c:${C.orange}"></i>PLA</span><span class="chip"><i class="d" style="--c:${C.bleu}"></i>PETG</span></div>
    </div>
    <div class="pc-scroll">
      <div class="pc-g">En cours<span>2</span></div>
      ${r(J.casque, sel === "run", `<b>Support casque</b><small>U1 Atelier · fin vers 18:18</small><span class="mini"><i style="width:62%"></i></span>`, `<span>62 %</span>`)}
      ${r(J.benchy, false, `<b>Benchy</b><small>U1 Bureau · en pause</small><span class="mini p"><i style="width:43%"></i></span>`, `<span>43 %</span>`)}
      <div class="pc-g">File d'attente<span>6 h 13</span></div>
      ${QUEUE.map((q, i) => r(q, false, `<b><span class="qn">${i + 1}.</span>${q.name}</b><small>${PRN[q.prn]} · ${q.t}</small>`, `<span>${q.start.replace("~", "")}</span>`)).join("")}
      <div class="pc-g">Aujourd'hui<span>108,2 g</span></div>
      ${HIST.filter((h) => h.day === "today").map((h, i) => r(h, sel === "done" && i === 0, `<b>${h.name}</b><small>${PRN[h.prn]} · ${h.at} · ${h.dur}</small>`, badge(h.st))).join("")}
      <div class="pc-g">Hier<span>184,1 g</span></div>
      ${HIST.filter((h) => h.day === "yday").map((h) => r(h, false, `<b>${h.name}</b><small>${PRN[h.prn]} · ${h.at} · ${h.dur}</small>`, badge(h.st))).join("")}
      <div class="pc-g">Samedi 24 octobre<span>70,3 g</span></div>
      ${HIST.filter((h) => h.day === "sat").map((h) => r(h, false, `<b>${h.name}</b><small>${PRN[h.prn]} · ${h.at} · ${h.dur}</small>`, badge(h.st))).join("")}
    </div>
  </div>`;
}
function renderCOverview() {
  toolbar({ title: "Impressions", sub: "2 en cours · 4 en attente", right: `<button class="tb-btn labeled">${I.plus}<span>Ajouter à la file</span></button>` });
  $("view").innerHTML = `<div class="pc">${cList("run")}
    <div class="pc-det">
      <div class="pc-hd">${thumb("helmet", J.casque.cols, "s56")}<div><h2>Support casque</h2><div class="kick">${badge("printing")}<span>U1 Atelier · lancée à 13:08 · support-casque.3mf</span></div></div>
        <div class="btns"><button class="btn">Pause</button><button class="btn danger">Annuler</button><button class="btn icon">${I.more}</button></div></div>
      <div class="pc-top">
        ${cam({ extra: `<span class="cam-tag r">${I.full.replace("<svg", '<svg style="width:12px;height:12px;fill:#fff"')}</span>` })}
        <div class="card pc-big">
          <div class="pct">62 %<small>couche 187 / 302</small></div>
          <div class="progress" style="height:7px"><i style="width:62%"></i></div>
          <div class="pc-kv">
            <div><span>Reste</span><b>1 h 58</b></div><div><span>Fin vers</span><b>18:18</b></div><div><span>Écoulé</span><b>3 h 12</b></div>
            <div><span>Buse T2 · plateau</span><b>220 · 60 °C</b></div><div><span>Vitesse</span><b>100 %</b></div>
          </div>
        </div>
      </div>
      <div class="card panel"><h3>Temps par couche<small>la couche en cours en bleu foncé · d'après la découpe</small></h3>${layerBars()}
        <div class="layers-ax"><span>1</span><span>Dôme · couches 110 – 190</span><span>302</span></div></div>
      <div class="pc-two">
        <div class="card panel"><h3>Têtes et filament</h3>${filRows()}</div>
        <div class="card panel"><h3>Déroulé</h3>${chronoRun()}</div>
      </div>
    </div></div>`;
}
function renderCDetail() {
  toolbar({ title: "Impressions", sub: "2 en cours · 4 en attente", right: `<button class="tb-btn labeled">${I.plus}<span>Ajouter à la file</span></button>` });
  $("view").innerHTML = `<div class="pc">${cList("done")}
    <div class="pc-det">
      <div class="pc-hd">${thumb("box", [C.gris], "s56")}<div><h2>Boîte de rangement</h2><div class="kick">${badge("complete")}<span>U1 Atelier · aujourd'hui, 09:10 – 11:42</span></div></div>
        <div class="btns"><button class="btn primary">${I.redo.replace("<svg", '<svg style="width:13px;height:13px"')}Réimprimer</button><button class="btn">Ouvrir dans Préparer</button><button class="btn icon">${I.more}</button></div></div>
      <div class="pc-top">
        ${cam({ part: "box", cols: [C.gris], done: true, play: true, tags: false, extra: `<span class="cam-tag">${I.film.replace("<svg", '<svg style="width:11px;height:11px;fill:#fff"')} TIMELAPSE</span><div class="cam-scrub"><span>0:00</span><div class="bar"><i style="width:0%"></i></div><span>0:24</span></div>` })}
        <div class="card pc-big outcome">
          <h3 style="margin:0;font-size:13px">Bilan<span class="newdata">nouveau</span></h3>
          ${seg([`${I.check}Réussie`, `${I.x}Ratée`], 0).replace('seg-btn on"', 'seg-btn on ok"')}
          <div class="note">Couvercle un peu serré, prévoir 0,2 mm de jeu.</div>
          <div class="delta"><div><small>Durée réelle</small><b>2 h 32</b></div><div><small>Estimée</small><b>2 h 24</b> <span class="up">+6 %</span></div></div>
          <div class="muted" style="font-size:12px">Timelapse enregistré sur U1 Atelier · 24 s</div>
        </div>
      </div>
      <div class="pc-two">
        <div class="card panel"><h3>Filament<small>1 tête</small></h3>
          <div class="fil" style="--c:${C.gris}"><i></i><b>T1</b><div class="nm"><span>PLA Gris</span><div class="bar"><i style="width:100%"></i></div></div><em>86,4 g<br><span class="muted" style="font-size:11px">29,0 m</span></em><span class="t"></span></div>
          <div class="fil-tot"><span class="muted">Coût estimé</span><b class="num">1,81 €</b></div>
          <div class="pa-d-chips" style="margin-top:12px"><span class="chip">0.20mm Standard</span><span class="chip">PEI texturée</span><span class="chip">15 % remplissage</span><span class="chip">Nivellement</span><span class="chip">Timelapse</span></div>
        </div>
        <div class="card panel"><h3>Déroulé</h3><div class="chrono">
          <div class="done"><time>08:52</time><span>Découpée <small>· 2 h 24 estimées</small></span></div>
          <div class="done"><time>09:10</time><span>Lancée <small>· nivellement, timelapse</small></span></div>
          <div class="wn"><time>10:02</time><span>Mise en pause <small>· 6 min</small><span class="newdata">nouveau</span></span></div>
          <div class="done"><time>10:08</time><span>Reprise</span></div>
          <div class="done"><time>11:42</time><span>Terminée <small>· 86,4 g</small></span></div>
        </div></div>
      </div>
      <div class="card panel"><h3>Temps par type<small>d'après la découpe</small></h3>${features()}</div>
    </div></div>`;
}


/* ====================================================== D: A + C (superseded by C) */
function renderDOverview() {
  toolbar({ title: "Impressions", sub: "2 en cours · 4 en attente", right: seg(["7 j", "30 j", "Tout"], 0) });
  const grp = (label, tot, rows) => `<div class="pd-g">${label}<span>${tot}</span></div>` + rows.map((h) => `<div class="pd-h">${thumb(h.kind, h.cols, "s36")}
      <span class="t"><b class="ell">${h.name}</b><small>${h.at}${h.why ? ` · ${h.why}` : ""}</small></span>
      <span class="muted ell">${PRN[h.prn]}</span><span class="num">${h.dur}</span><span class="row num" style="gap:6px">${dots(h.cols)}${h.g}</span><span class="r">${badge(h.st)}</span></div>`).join("");
  $("view").innerHTML = `<div class="mk-scroll"><div class="pa">
    ${statsStrip()}
    <div>
      <div class="sec"><span class="vp-section">En cours</span><small>2 imprimantes sur 2 occupées · cliquez une carte pour la fiche</small></div>
      <div class="pa-live">${liveTile("atelier")}${liveTile("bureau")}</div>
    </div>
    <div class="pd-bottom">
      <div class="pd-left">
      <div class="card">
        <div class="card-head"><h3>File d'attente</h3><small>4 · 6 h 13</small><span class="link">Glisser pour réordonner</span></div>
        <div class="pa-list">${queueRows()}</div>
      </div>
      <div class="card panel">
        <h3>Aujourd'hui<small>depuis 08:00</small></h3>
        <div class="pb-occ">
          <div class="l"><span>U1 Atelier</span><div class="progress"><i style="width:68%"></i></div><b class="num">68 %</b></div>
          <div class="l"><span>U1 Bureau</span><div class="progress"><i style="width:36%"></i></div><b class="num">36 %</b></div>
        </div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">6 h 40 d'impression · 176,4 g. Les deux imprimantes seront libres vers <b style="color:var(--text)">21:31</b> si la file part sans attendre.</p>
      </div>
      </div>
      <div class="card pd-hist">
        <div class="card-head"><h3>Historique</h3><small>25 sur 7 jours</small>
          <div class="pc-search pd-search">${I.search}<span>Rechercher…</span><kbd>⌘F</kbd></div></div>
        <div class="pd-tools">${seg(["Toutes", "Terminées", "Échecs <em>2</em>"], 0)}
          <span class="chip">${I.printer}U1 Atelier</span><span class="chip">${I.printer}U1 Bureau</span><span class="chip"><i class="d" style="--c:${C.orange}"></i>PLA</span><span class="chip"><i class="d" style="--c:${C.bleu}"></i>PETG</span></div>
        ${grp("Aujourd'hui", "108,2 g", HIST.filter((h) => h.day === "today"))}
        ${grp("Hier", "184,1 g", HIST.filter((h) => h.day === "yday"))}
        ${grp("Samedi 24 octobre", "70,3 g", HIST.filter((h) => h.day === "sat"))}
      </div>
    </div>
  </div></div>`;
}
function dToolbar() {
  toolbar({ back: true, title: "Impressions", sub: "Tableau de bord · 2 en cours · 4 en attente", right: `<button class="tb-btn labeled">${I.plus}<span>Ajouter à la file</span></button>` });
}
function renderDRunning() { renderCOverview(); dToolbar(); }
function renderDFinished() { renderCDetail(); dToolbar(); }

/* ------------------------------------------------------------ switcher */
function render() {
  document.documentElement.dataset.scheme = S.theme;
  renderSide();
  const R = {
    a: { overview: renderAOverview, detail: renderADetail },
    b: { overview: renderBOverview, detail: renderBDetail },
    c: { running: renderCOverview, finished: renderCDetail, overview: renderCOverview, detail: renderCDetail },
    d: { overview: renderDOverview, detail: renderDRunning, finished: renderDFinished },
  }[S.p];
  (R[S.v] || R[Object.keys(R)[0]])();
  const sw = (key, items) => `<div class="seg">${items.map(([v, t]) => `<button class="seg-btn${S[key] === v ? " on" : ""}" data-k="${key}" data-v="${v}">${t}</button>`).join("")}</div>`;
  $("switch").innerHTML = `<b>Proposition</b>${sw("p", [["c", "C · Liste et fiche (retenue)"], ["a", "A · Tableau de bord"], ["b", "B · Agenda"], ["d", "D · A + C (abandonnée)"]])}${sw("v", S.p === "c" ? [["running", "Fiche en cours"], ["finished", "Fiche terminée"]] : [["overview", "Vue d'ensemble"], ["detail", "Fiche"], ...(S.p === "d" ? [["finished", "Fiche terminée"]] : [])])}${sw("theme", [["light", "Clair"], ["dark", "Sombre"]])}`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  S[b.dataset.k] = b.dataset.v;
  if (b.dataset.k === "p") S.v = S.p === "c" ? "running" : "overview";
  history.replaceState(null, "", `?p=${S.p}&v=${S.v}&theme=${S.theme}`);
  render();
});
render();
