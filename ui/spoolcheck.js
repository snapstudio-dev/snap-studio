"use strict";
/* Spool check before sending.

   Before a sliced print leaves for the printer (Send, or Start from the
   queue), each head the G-code uses is compared with the spool loaded on
   it now. Expected: the material and color recorded at slice time (the
   slice's head profiles and spool colors), otherwise the G-code's own
   `filament_type`. The G-code's `filament_colour` only counts for a print
   with no slice record: a slice made without a printer has no spool color,
   and its presets' default colors are not a choice. Heads the print does
   not use are ignored. A different material family, a clearly different
   color, or an empty head opens a sheet: each color of the model with the
   spool that will print it. The user changes those, sends, cancels, or goes
   back to Prepare to slice the plate again with the spools loaded.
   A printer that reports no spools (another Klipper) is not checked; an
   unreachable one is not sent to.

   Material: compared by family, case-insensitive. "PLA", "PLA+", "PLA Matte",
   "PLA Silk", "PLA-CF" are all PLA; "PETG" and "PET" differ, as do "PC" and
   "PCTG". Unknown material on either side (a spool without RFID nor
   material set on the printer): not compared.
   Color: CIEDE2000 distance; below SP_COLOR_TOL the spools match (a white
   and an off-white, two reds of different brands, but not a violet and a
   blue). Unknown color on either side: not compared.

   Substitution: the G-code tool is routed to the chosen head through the
   firmware's extruder map (SET_PRINT_EXTRUDER_MAP, sent before every print
   anyway). One tool per head; the G-code itself is not rewritten, so its
   temperatures stay those of the sliced material. */

const SP_COLOR_TOL = 10;
const SP_KEY = "snapstudio.spoolcheck.off";

/* Longest names first: PETG before PET, PCTG before PC, PPS before PP. */
const SP_FAMILIES = ["PETG", "PCTG", "PAHT", "PPSU", "PEBA", "BVOH", "HIPS", "PLA", "PET", "ABS", "ASA", "TPU", "TPE", "PVA", "PPS", "PEEK", "PEI", "PA", "PC", "PP", "PE"];
const SP_ALIASES = { NYLON: "PA", PA6: "PA", PA12: "PA", "PA-CF": "PA", PAHT: "PA", FLEX: "TPU" };

/* Family of a material ("PLA Matte" → "PLA"); "" when unknown. */
function spMaterialFamily(s) {
  const up = String(s || "").trim().toUpperCase();
  if (!up || up === "?") return "";
  const word = up.split(/[\s_\/+-]+/)[0];
  if (SP_ALIASES[word]) return SP_ALIASES[word];
  if (SP_ALIASES[up]) return SP_ALIASES[up];
  for (const f of SP_FAMILIES) if (word.startsWith(f) && (f !== "PE" || word === "PE")) return f;
  return word;
}

/* Material named in a filament profile ("Snapmaker PLA SnapSpeed @U1" →
   "PLA"), for profiles whose type is not known. */
function spMaterialFromName(name) {
  const words = String(name || "").replace(/@.*$/, "").toUpperCase().split(/[\s_\/()]+/);
  for (const w of words) {
    const base = w.replace(/\+$/, "");
    if (SP_ALIASES[base]) return SP_ALIASES[base];
    if (SP_FAMILIES.includes(base) || SP_FAMILIES.includes(base.split("-")[0])) return spMaterialFamily(base);
  }
  return "";
}

function spHex(hex) {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(hex || "").trim());
  return m ? "#" + m[1].toLowerCase() : "";
}
function spLab(hex) {
  const h = spHex(hex);
  if (!h) return null;
  const n = parseInt(h.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = lin(n >> 16), g = lin((n >> 8) & 255), b = lin(n & 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
/* Perceptual distance (CIEDE2000, Sharma et al. 2005); Infinity when one
   color is unknown. Unlike the plain Lab distance, it does not shrink the
   gaps between blues and violets. */
function spColorDelta(a, b) {
  const x = spLab(a), y = spLab(b);
  if (!x || !y) return Infinity;
  const [L1, a1, b1] = x, [L2, a2, b2] = y;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (bb, ap) => (bb === 0 && ap === 0 ? 0 : (Math.atan2(bb, ap) / rad + 360) % 360);
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hm += h1p + h2p < 360 ? 360 : -360;
    hm /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp, Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/* What each used G-code tool expects. `ftypeOf(profile name)` gives a
   profile's material when the caller knows its list. */
function spExpected({ tools, profile = {}, stats = {}, ftypeOf = () => "" }) {
  const list = tools?.length ? tools : [0];
  return [...new Set(list)].map((t) => {
    const prof = profile.filaments?.[t] || "";
    const material = spMaterialFamily(stats.filament_types?.[t]) || spMaterialFamily(ftypeOf(prof)) || spMaterialFromName(prof);
    const color = profile.colors?.length ? spHex(profile.colors[t]) : spHex(stats.filament_colors?.[t]);
    return { tool: t, material, color };
  });
}

/* Spool loaded on a head, as the printer reports it. */
function spLoaded(slots, head) {
  const s = (slots || []).find((x) => x.index === head);
  if (!s) return { head, state: "unknown", material: "", color: "" };
  if (!s.present) return { head, state: "empty", material: "", color: "" };
  // Loaded, material unknown (no RFID, nothing set on the printer): only
  // its color can be compared.
  const label = [s.kind, s.sub_type].filter(Boolean).join(" ");
  return { head, state: "ok", material: spMaterialFamily(s.kind), label, color: spHex(s.color), vendor: s.vendor || "" };
}

/* Reasons a loaded spool does not fit what a tool expects ([] = fits). */
function spReasons(exp, loaded) {
  if (loaded.state === "empty") return ["empty"];
  if (loaded.state === "unknown") return ["unknown"];
  const out = [];
  if (exp.material && loaded.material && exp.material !== loaded.material) out.push("material");
  if (exp.color && loaded.color && spColorDelta(exp.color, loaded.color) > SP_COLOR_TOL) out.push("color");
  return out;
}

/* Head printing each tool: its substitute, otherwise the same number. */
const spHeadOf = (tool, map = []) => (map.find(([t]) => t === tool) || [tool, tool])[1];

/* Tools whose head does not hold the expected spool, with the map applied. */
function spMismatches(expected, slots, map = []) {
  return expected
    .map((e) => {
      const loaded = spLoaded(slots, spHeadOf(e.tool, map));
      return { ...e, head: loaded.head, loaded, reasons: spReasons(e, loaded) };
    })
    .filter((m) => m.reasons.length);
}

/* Substitution from the user's picks ({ tool: head }): only real changes,
   one tool per head among the used tools, heads 0 to 3. Throws otherwise. */
function spRemap(tools, picks = {}) {
  const used = [...new Set(tools?.length ? tools : [0])];
  const map = used.filter((t) => picks[t] != null && +picks[t] !== t).map((t) => [t, +picks[t]]);
  for (const [t, h] of map) if (!Number.isInteger(h) || h < 0 || h > 3) throw new Error(`T${t}: no head ${h}`);
  const heads = used.map((t) => spHeadOf(t, map));
  const dup = heads.find((h, i) => heads.indexOf(h) !== i);
  if (dup != null) throw new Error(`two tools on head T${dup}`);
  return map;
}

/* Loaded spool that best replaces a tool's: one that fits fully (same
   material, then closest color) and no other used tool already prints from. */
function spSuggest(exp, slots, taken) {
  let best = null, bestD = Infinity;
  for (const s of slots || []) {
    if (!s.present || taken.has(s.index)) continue;
    const l = spLoaded(slots, s.index);
    if (spReasons(exp, l).length) continue;
    const d = exp.color && l.color ? spColorDelta(exp.color, l.color) : 0;
    if (d < bestD) {
      best = s.index;
      bestD = d;
    }
  }
  return best;
}

/* Spool each used tool prints with at first: its own head when the spool
   there fits; otherwise a fitting spool on a head the print does not use;
   otherwise its own head if a spool is loaded there; otherwise none (the
   user picks one). → { tool: head | null } */
function spDefaults(expected, slots) {
  const used = expected.map((e) => e.tool);
  const picks = {};
  const taken = new Set();
  for (const e of expected) {
    if (!spReasons(e, spLoaded(slots, e.tool)).length) {
      picks[e.tool] = e.tool;
      taken.add(e.tool);
    }
  }
  for (const e of expected) {
    if (e.tool in picks) continue;
    const s = spSuggest(e, slots, new Set([...taken, ...used]));
    if (s != null) {
      picks[e.tool] = s;
      taken.add(s);
      continue;
    }
    const own = (slots || []).find((x) => x.index === e.tool);
    picks[e.tool] = own?.present && !taken.has(e.tool) ? e.tool : null;
    if (picks[e.tool] != null) taken.add(e.tool);
  }
  return picks;
}

/* ------------------------------------------------------------ bonding */

/* Whether two material families bond to each other, layer on layer: what
   a prime tower shared by several heads needs (#35), and a plate under a
   material (#16). Same family: they bond; the pairs below by experience
   (Snapmaker's wiki, slicer guides); any other pair: not known, never
   warned about. */
const SP_BOND = [["ABS", "ASA"], ["PETG", "PCTG"], ["PETG", "PET"], ["PCTG", "PET"], ["TPU", "TPE"], ["PLA", "PVA"]];
const SP_NO_BOND = [
  ["PLA", "PETG"], ["PLA", "PCTG"], ["PLA", "PET"], ["PLA", "TPU"], ["PLA", "TPE"], ["PLA", "ABS"], ["PLA", "ASA"],
  ["PETG", "TPU"], ["PETG", "TPE"], ["PCTG", "TPU"], ["PCTG", "TPE"], ["PET", "TPU"], ["PET", "TPE"],
];
const spPair = (list, a, b) => list.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/* true: they bond; false: they do not; null: not known (or a material
   not known). Families or material names ("PLA Matte"). */
function spBonds(a, b) {
  const fa = spMaterialFamily(a), fb = spMaterialFamily(b);
  if (!fa || !fb) return null;
  if (fa === fb || spPair(SP_BOND, fa, fb)) return true;
  return spPair(SP_NO_BOND, fa, fb) ? false : null;
}

/* The prime tower and the plate's materials. `heads`: the heads the plate
   prints with, { n, material }; `tower`: the tower is on (and possible: not
   "by object"); `wall`: the head printing the tower's outer wall, from 0
   (null: the engine picks). Null when there is nothing to say; otherwise
   { state: "conflict" | "walled", pairs: [[n, n]] that do not bond,
   families: [{ family, heads: [n] }] in the plate's order }. */
function spTowerAdvice({ heads, tower, wall = null }) {
  if (!tower) return null;
  const used = (heads || []).filter((h) => spMaterialFamily(h.material));
  if (used.length < 2) return null;
  const pairs = [];
  for (let i = 0; i < used.length; i++)
    for (let j = i + 1; j < used.length; j++) if (spBonds(used[i].material, used[j].material) === false) pairs.push([used[i].n, used[j].n]);
  if (!pairs.length) return null;
  const families = [];
  for (const h of used) {
    const f = spMaterialFamily(h.material);
    const g = families.find((x) => x.family === f);
    if (g) g.heads.push(h.n);
    else families.push({ family: f, heads: [h.n] });
  }
  // The outer wall in one of them: the inside still mixes, said, not urged.
  return { state: wall != null && used.some((h) => h.n === wall) ? "walled" : "conflict", pairs, families };
}

if (typeof module !== "undefined") {
  module.exports = { SP_COLOR_TOL, spBonds, spTowerAdvice, spMaterialFamily, spMaterialFromName, spColorDelta, spExpected, spLoaded, spReasons, spMismatches, spRemap, spSuggest, spHeadOf, spDefaults };
}

/* ------------------------------------------------------------ the sheet */

const spEnabled = () => typeof localStorage === "undefined" || localStorage.getItem(SP_KEY) !== "1";
function spSetEnabled(on) {
  if (on) localStorage.removeItem(SP_KEY);
  else localStorage.setItem(SP_KEY, "1");
  const box = document.getElementById("set-spool-check");
  if (box) box.checked = on;
}

/* Material of a filament profile, from the lists already loaded. */
function spFtypeOf(pid) {
  const lists = [typeof HD !== "undefined" ? HD.listsNow?.[pid] : null, typeof SL !== "undefined" ? SL.lists?.filaments : null];
  return (name) => {
    for (const l of lists) {
      const p = (l || []).find((x) => x.name === name);
      if (p?.ftype) return p.ftype;
    }
    return "";
  };
}

/* The printer's spools, read now (`printer`: { id, host, port }).
   → { online, slots }: slots empty when the printer reports none, as
   another Klipper does. */
async function spReadSpools(printer) {
  try {
    const st = await invoke("printer_status", { host: printer.host, port: printer.port });
    if (!st.online) return { online: false, slots: [] };
    const slots = st.filaments || [];
    if (typeof headsSetSlots === "function") headsSetSlots(printer.id, slots);
    return { online: true, slots };
  } catch {
    return { online: false, slots: [] };
  }
}

/* Spool check of a print about to start, printer read first. Unreachable:
   an error, nothing sent. No spools reported: nothing to compare, sent as
   sliced. Otherwise `spoolCheck`, with the same answer. */
async function spCheckBeforeStart(printer, args) {
  const { online, slots } = await spReadSpools(printer);
  if (!online) throw new Error(tr("spool.unreachable", { name: printer.name || printer.host }));
  if (!slots.length) return { map: [] };
  return spoolCheck({ ...args, pid: printer.id, slots });
}

/* "red PLA" / "PLA rouge"; parts left out when unknown. */
function spDescribe(material, color, fallback) {
  const c = color ? colorName(color) : "";
  if (!material && !c) return fallback;
  if (!c) return material;
  if (!material) return c;
  return tr("spool.desc", { mat: material, color: c });
}

const spSwatch = (c) => `<i class="sp-sw${c ? "" : " none"}"${c ? ` style="--c:${esc(c)}"` : ""}></i>`;

/* Asks when the loaded spools differ from the slice's: each color of the
   model, and the loaded spool that will print it. `print`: { thumb, name,
   printer } for the header. `canEdit`: the plate can go back to
   Prepare.
   → { map: [[tool, head]…] } to send (empty: as sliced), { edit: true } to
   slice again in Prepare, or null. */
function spoolCheck({ pid, tools, profile, stats, slots, canEdit = false, print = {} }) {
  const used = [...new Set(tools?.length ? tools : [0])].sort((a, b) => a - b);
  const expected = spExpected({ tools: used, profile, stats, ftypeOf: spFtypeOf(pid) });
  if (!spMismatches(expected, slots).length || !spEnabled()) return Promise.resolve({ map: [] });

  const picks = spDefaults(expected, slots);
  // Every head of the printer, empty ones too (shown, not choosable).
  const heads = [...new Set([0, 1, 2, 3, ...(slots || []).map((x) => x.index)])].sort((a, b) => a - b);
  const what = (e) => spDescribe(e.material, e.color, "T" + e.tool);

  // Header: what is being sent.
  const thumb = $("sp-thumb");
  thumb.classList.add("hidden");
  if (print.thumb) {
    thumb.onload = () => thumb.classList.remove("hidden");
    thumb.onerror = () => thumb.classList.add("hidden");
    thumb.src = print.thumb;
  }
  $("sp-name").textContent = print.name || "";
  $("sp-info").textContent = [
    stats?.print_time_s && fmtDuration(stats.print_time_s),
    stats?.filament_g && `${stats.filament_g.toFixed(0)} g`,
    print.printer && tr("queue.on", { name: print.printer }),
  ]
    .filter(Boolean)
    .join(" · ");

  const modal = $("spmodal");
  const render = () => {
    $("sp-list").innerHTML = expected
      .map((e) => {
        const h = picks[e.tool];
        const l = h != null ? spLoaded(slots, h) : null;
        // One token per head, as in Prepare: the spool's color and number.
        // One Tab stop per row: the chosen head, or the first loaded one.
        const stop = h ?? heads.find((hd) => (slots || []).some((x) => x.index === hd && x.present));
        const toks = heads
          .map((hd) => {
            const slot = (slots || []).find((x) => x.index === hd);
            const sl = spLoaded(slots, hd);
            const label = slot?.present ? spDescribe(sl.label || sl.material, sl.color, tr("spool.loaded_unknown")) : tr("printers.empty_tag");
            // A head another color prints from: taking it swaps the two.
            const other = expected.find((o) => o.tool !== e.tool && picks[o.tool] === hd);
            const fits = slot?.present && !spReasons(e, sl).length;
            const title = `T${hd} · ${label}${other ? " — " + tr("spool.swap", { what: what(other) }) : ""}`;
            return headToken({
              h: hd, slot, on: hd === h, color: sl.color || "", empty: !slot?.present, title,
              cls: other ? " busy" : "",
              attrs: ` type="button" data-tool="${e.tool}" data-head="${hd}"${slot?.present ? "" : " disabled"} tabindex="${hd === stop ? 0 : -1}" role="radio" aria-checked="${hd === h}"`,
              after: fits ? '<em class="ok">✓</em>' : "",
            });
          })
          .join("");
        // Only another material is worth a word: the G-code keeps the
        // temperatures it was sliced with.
        const note = l && e.material && l.material && l.material !== e.material
          ? `<small class="sp-note warn">${esc(tr("spool.other_material", { got: l.material, want: e.material }))}</small>`
          : "";
        const chosen = l ? spDescribe(l.label || l.material, l.color, tr("spool.loaded_unknown")) : tr("spool.choose");
        return `<div class="sp-row">
          <span class="sp-exp">${spSwatch(e.color)}<span>${esc(what(e))}</span></span>
          <span class="sp-arrow" aria-hidden="true">→</span>
          <span class="sp-choice${h == null ? " missing" : ""}">
            <span class="sp-toks" role="radiogroup" aria-label="${esc(tr("spool.use") + " " + what(e))}">${toks}</span>
            <small class="sp-chosen">${esc(chosen)}</small>
          </span>
          ${note}
        </div>`;
      })
      .join("");
    const missing = expected.some((e) => picks[e.tool] == null);
    $("sp-go").disabled = missing;
    $("sp-go").title = missing ? tr("spool.choose_first") : "";
    $("sp-edit").disabled = !canEdit;
    $("sp-edit").title = canEdit ? tr("spool.edit_tip") : tr("spool.edit_none");
    $("sp-hint").textContent = canEdit ? "" : tr("spool.edit_none");
  };
  render();
  openSheet(modal);
  requestAnimationFrame(() => ($("sp-go").disabled ? $("sp-cancel") : $("sp-go")).focus());
  return new Promise((resolve) => {
    const done = (v) => {
      $("sp-go").onclick = $("sp-edit").onclick = $("sp-cancel").onclick = $("sp-list").onclick = $("sp-list").onkeydown = modal.onkeydown = null;
      closeSheet(modal);
      resolve(v);
    };
    const pick = (t, hd) => {
      // Already printing another color: that color takes this one's spool.
      const other = expected.find((o) => o.tool !== t && picks[o.tool] === hd);
      if (other) picks[other.tool] = picks[t] ?? null;
      picks[t] = hd;
      render();
      $("sp-list").querySelector(`.sl-token[data-tool="${t}"][data-head="${hd}"]`)?.focus();
    };
    $("sp-list").onclick = (e) => {
      const b = e.target.closest(".sl-token[data-head]");
      if (b && !b.disabled) pick(+b.dataset.tool, +b.dataset.head);
    };
    // Arrows, Home and End move between a row's heads; Enter or Space
    // takes one. Moving alone never swaps colors.
    $("sp-list").onkeydown = (e) => {
      const b = e.target.closest(".sl-token[data-head]");
      if (!b || !(e.key in SW_KEYS)) return;
      e.preventDefault();
      const row = [...b.parentElement.querySelectorAll(".sl-token")];
      const next = row[swMove(row, row.indexOf(b), e.key)];
      if (!next) return;
      for (const x of row) x.tabIndex = x === next ? 0 : -1;
      next.focus();
    };
    $("sp-go").onclick = () => {
      try {
        done({ map: spRemap(used, picks) });
      } catch (e) {
        toast(String(e.message || e), true);
      }
    };
    $("sp-edit").onclick = () => done({ edit: true });
    $("sp-cancel").onclick = () => done(null);
    modal.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      }
    };
  });
}

if (typeof document !== "undefined" && document.getElementById("set-spool-check")) {
  $("set-spool-check").checked = spEnabled();
  $("set-spool-check").addEventListener("change", (e) => spSetEnabled(e.target.checked));
}
