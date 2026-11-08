"use strict";
/* Virtual heads: the "Virtual heads" section of Heads and spools, the
   sheet that makes or edits one (two head cards pointing to the mix, a
   seven-notch slider), and the sheet saying, once, that a virtual head goes
   with its spools. State in heads.js, rules in virtual-logic.js. */

const VS = { pid: null, uid: null, a: 0, b: 1, notch: 4, done: null, shades: null };

/* The material a head slices with: its profile's, else its spool's. */
function vsMaterial(pid, h) {
  const list = HD.listsNow[pid] || null;
  const name = headsProfile(pid, h, list).name;
  const p = list?.find((f) => f.name === name);
  const s = headsSlots(pid).find((x) => x.index === h);
  return p?.ftype || spMaterialFromName(name || "") || (s?.present ? s.kind || "" : "");
}

/* Why a printer cannot get a new virtual head, or "". */
function vsBlocked(pid) {
  if (!vhCanAdd(headsVirtual(pid))) return tr("heads.virtual.max", { n: VH_MAX });
  if (vhLoaded(headsSlots(pid)).length < 2) return tr("heads.virtual.need_two");
  return "";
}

/* A head's words: material, color name. */
const vsWords = (pid, h) => {
  const c = hdSpoolColor(pid, h);
  return [vsMaterial(pid, h), c && colorName(c)].filter(Boolean).join(" · ");
};

/* "T0 + T2 · 2:1". */
const vsRecipe = (v) => `T${v.a} + T${v.b} · ${vhRatio(v.pct)}`;

/* A printer's virtual heads as head picker entries (swatch-logic.js),
   flagged when their two materials no longer bond. */
function vsEntries(pid) {
  const list = headsVirtual(pid);
  return swVirtual({
    list,
    colorOf: (v) => headsVirtualColor(pid, v),
    name: (v) => vhName(list, vhValue(v.uid)),
    ratio: (v) => vhRatio(v.pct),
    bonds: (v) => spBonds(vsMaterial(pid, v.a), vsMaterial(pid, v.b)),
    parts: (v) => [hdSpoolColor(pid, v.a), hdSpoolColor(pid, v.b)],
  });
}

/* ------------------------------------------------------------ section */

/* Under the head cards: one card per virtual head, then "+ Virtual head". */
function vsRenderSection(pid) {
  const list = headsVirtual(pid);
  const why = vsBlocked(pid);
  const cards = list.map((v) => {
    const h = vhValue(v.uid);
    const name = vhName(list, h);
    const mix = headsVirtualColor(pid, v);
    const [ca, cb] = [hdSpoolColor(pid, v.a), hdSpoolColor(pid, v.b)];
    // Spools changed since: two materials that no longer bond.
    const nobond = spBonds(vsMaterial(pid, v.a), vsMaterial(pid, v.b)) === false;
    return `<div class="sl-headcard vh-card-item">
      <div class="sl-spool vh-spool" style="--ca:${esc(ca || "transparent")};--cb:${esc(cb || "transparent")};--c:${esc(mix || "transparent")}"></div>
      <div class="sl-hc-top"><b>${esc(name)}</b><span>${esc(vsRecipe(v))}</span>${nobond ? `<em class="vh-warn-tag" title="${esc(tr("heads.virtual.no_bond", { ka: vsMaterial(pid, v.a), kb: vsMaterial(pid, v.b) }))}">⚠</em>` : ""}</div>
      <small class="sl-hc-sub">${esc(mix ? colorName(mix) + " " + mix.toUpperCase() : "")}</small>
      <span class="sel-row vh-acts">
        <button class="btn small" data-vedit="${v.uid}" aria-label="${esc(tr("heads.virtual.edit", { name }))}">${esc(tr("common.edit"))}</button>
        <button class="btn small danger" data-vdel="${v.uid}" aria-label="${esc(tr("heads.virtual.delete", { name }))}">${esc(tr("common.delete"))}</button>
      </span>
    </div>`;
  });
  cards.push(`<button type="button" class="vh-add" data-vadd${why ? ` disabled title="${esc(why)}"` : ""}><span aria-hidden="true">+</span>${esc(tr("heads.virtual.add"))}${why ? `<small>${esc(why)}</small>` : ""}</button>`);
  $("hv-virtual").innerHTML = cards.join("");
}

$("hv-virtual").addEventListener("click", async (e) => {
  const pid = HV.pid;
  if (e.target.closest("[data-vadd]:not([disabled])")) return vsOpen(pid);
  const ed = e.target.closest("[data-vedit]");
  if (ed) return vsOpen(pid, { uid: +ed.dataset.vedit });
  const del = e.target.closest("[data-vdel]");
  if (!del) return;
  const uid = +del.dataset.vdel;
  const list = headsVirtual(pid);
  const name = vhName(list, vhValue(uid));
  // Used on the plate: its colors will have no head.
  const n = typeof prVirtualUsers === "function" && pid === headsActive() ? prVirtualUsers([vhValue(uid)]) : 0;
  if (n && !(await confirmDelete(tr("heads.virtual.delete", { name }), tr("heads.virtual.delete_confirm", { n, name })))) return;
  headsVirtualDelete(pid, [uid]);
});

/* ------------------------------------------------------------ the sheet */

/* Opens the sheet for printer `pid`: a new virtual head, or `uid`'s.
   `done(value)`: called with the head's value once created or saved. */
function vsOpen(pid, { uid = null, done = null } = {}) {
  const loaded = vhLoaded(headsSlots(pid));
  const v = uid != null ? headsVirtual(pid).find((x) => x.uid === uid) : null;
  if (!v && (loaded.length < 2 || !vhCanAdd(headsVirtual(pid)))) return toast(vsBlocked(pid), true);
  Object.assign(VS, { pid, uid: v ? uid : null, done, shades: null });
  VS.a = v ? v.a : loaded[0];
  VS.b = v ? v.b : loaded[1];
  VS.notch = v ? vhNotch(v.pct) : 4;
  const list = headsVirtual(pid);
  VS.name = v ? vhName(list, vhValue(uid)) : `V${list.length + 1}`;
  $("vh-title").textContent = v ? tr("heads.virtual.edit", { name: VS.name }) : tr("heads.virtual.new");
  $("vh-go").textContent = tr(v ? "heads.virtual.save" : "heads.virtual.create");
  $("vh-notch").value = VS.notch;
  openSheet($("vhmodal"));
  vsShades();
  vsRender();
  requestAnimationFrame(() => {
    vsLines();
    $("vh-notch").focus();
  });
}

/* The seven notches' colors at once, from the engine's mixer: dragging is
   then instant. */
async function vsShades() {
  const [ca, cb] = [hdSpoolColor(VS.pid, VS.a), hdSpoolColor(VS.pid, VS.b)];
  const key = `${ca}|${cb}|${VS.a}|${VS.b}`;
  VS.shades = { key, colors: null };
  const lo = VS.a < VS.b;
  const shares = VH_PCTS.map((p) => (lo ? vhShare(p) : 1 - vhShare(p)));
  const colors = await invoke("mix_colors", { a: lo ? ca : cb, b: lo ? cb : ca, shares }).catch(() => null);
  if (VS.shades?.key !== key || !colors) return;
  VS.shades.colors = colors;
  vsRender();
}

/* The mix as it stands. */
const vsMix = () => ({ a: VS.a, b: VS.b, pct: vhPct(VS.notch) });
function vsColor() {
  const [ca, cb] = [hdSpoolColor(VS.pid, VS.a), hdSpoolColor(VS.pid, VS.b)];
  const c = VS.shades?.colors?.[VS.notch - 1];
  if (c) return c;
  const t = VS.a < VS.b ? vhShare(vhPct(VS.notch)) : 1 - vhShare(vhPct(VS.notch));
  return VS.a < VS.b ? vhMixLinear(ca, cb, t) : vhMixLinear(cb, ca, t);
}

/* "2 layers of T0 for 1 of T2", or "1 layer of each". */
function vsCaption() {
  const [ra, rb] = vhCadence(vhPct(VS.notch));
  if (ra === rb) return tr("heads.virtual.cadence_even");
  const [na, a, b] = ra > rb ? [ra, VS.a, VS.b] : [rb, VS.b, VS.a];
  return tr("heads.virtual.cadence", { n: na, a: "T" + a, b: "T" + b });
}

function vsRender() {
  const pid = VS.pid;
  const card = (h) => {
    const c = hdSpoolColor(pid, h);
    return `<span class="vh-dot" style="--c:${esc(c || "transparent")}"></span><span class="vh-card-t"><b>T${h}</b><small>${esc(vsWords(pid, h))}</small></span><span class="sw-caret" aria-hidden="true">▾</span>`;
  };
  $("vh-a").innerHTML = card(VS.a);
  $("vh-b").innerHTML = card(VS.b);
  $("vh-a").setAttribute("aria-label", `${tr("heads.virtual.head_a")}: T${VS.a} · ${vsWords(pid, VS.a)}`);
  $("vh-b").setAttribute("aria-label", `${tr("heads.virtual.head_b")}: T${VS.b} · ${vsWords(pid, VS.b)}`);
  const mix = vsColor();
  const [ca, cb] = [hdSpoolColor(pid, VS.a), hdSpoolColor(pid, VS.b)];
  const sw = $("vh-swatch");
  sw.style.setProperty("--c", mix || "transparent");
  sw.style.setProperty("--ca", ca || "transparent");
  sw.style.setProperty("--cb", cb || "transparent");
  $("vh-name").textContent = VS.name;
  $("vh-color").textContent = mix ? `${colorName(mix)} · ${mix.toUpperCase()}` : "";
  $("vh-la").innerHTML = `<i style="background:${esc(ca)}"></i>T${VS.a}`;
  $("vh-lb").innerHTML = `T${VS.b}<i style="background:${esc(cb)}"></i>`;
  const range = $("vh-notch");
  range.style.setProperty("--ca", ca || "var(--separator)");
  range.style.setProperty("--cb", cb || "var(--separator)");
  range.style.setProperty("--c", mix || "var(--accent)");
  const caption = vsCaption();
  $("vh-caption").textContent = caption;
  range.setAttribute("aria-valuetext", caption);
  // What stops it: materials that do not bond, the same mix twice.
  const [ka, kb] = [vsMaterial(pid, VS.a), vsMaterial(pid, VS.b)];
  const bond = spBonds(ka, kb);
  const dup = vhDuplicate(headsVirtual(pid), vsMix(), VS.uid);
  const block = bond === false ? tr("heads.virtual.no_bond", { ka, kb }) : dup ? tr("heads.virtual.same", { name: vhName(headsVirtual(pid), vhValue(dup.uid)) }) : "";
  const hint = !block && bond && spMaterialFamily(ka) === spMaterialFamily(kb) && ka.trim().toUpperCase() !== kb.trim().toUpperCase() ? tr("heads.virtual.finish", { ka, kb }) : "";
  // Far apart in light: the print darker and more striped than the swatch.
  $("vh-contrast").classList.toggle("hidden", !vhContrastWarn(ca, cb));
  $("vh-warn").textContent = block || hint;
  $("vh-warn").classList.toggle("hidden", !(block || hint));
  $("vh-warn").classList.toggle("bad", !!block);
  $("vh-go").disabled = !!block;
  vsLines();
}

/* Two lines from the cards' bottoms to the swatch, each from its head's
   color to the mix's, ending in an arrow head. */
function vsLines() {
  const svg = $("vh-lines"), stage = svg.parentElement;
  if (!stage.offsetWidth) return;
  const box = stage.getBoundingClientRect();
  const at = (el, fx, fy) => {
    const r = el.getBoundingClientRect();
    return [r.left - box.left + r.width * fx, r.top - box.top + r.height * fy];
  };
  const sw = $("vh-swatch");
  const [ca, cb] = [hdSpoolColor(VS.pid, VS.a), hdSpoolColor(VS.pid, VS.b)];
  const mix = vsColor();
  const line = (id, from, to, c0) => {
    const [x0, y0] = from, [x1, y1] = to;
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"><stop offset="0" stop-color="${esc(c0 || "currentColor")}"/><stop offset="1" stop-color="${esc(mix || "currentColor")}"/></linearGradient>
      <path d="M${x0},${y0} C${x0},${(y0 + y1) / 2 + 20} ${x1 + (x0 < x1 ? -30 : 30)},${y1} ${x1},${y1}" stroke="url(#${id})" marker-end="url(#vh-arrow)"/>`;
  };
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = `<defs><marker id="vh-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${esc(mix || "currentColor")}"/></marker></defs>
    ${line("vh-ga", at($("vh-a"), 0.5, 1), at(sw, 0.06, 0.5), ca)}${line("vh-gb", at($("vh-b"), 0.5, 1), at(sw, 0.94, 0.5), cb)}`;
}

/* A head card: the popover of the loaded heads, the other card's one off. */
function vsPickHead(side) {
  const pid = VS.pid, btn = $("vh-" + side);
  const other = side === "a" ? VS.b : VS.a;
  const loaded = new Set(vhLoaded(headsSlots(pid)));
  const entries = swHeads({ count: headsCount(pid), slots: headsSlots(pid), material: (h) => vsMaterial(pid, h) })
    .filter((e) => loaded.has(e.h))
    .map((e) => ({ ...e, disabled: e.h === other }));
  openSwatches(btn, {
    entries,
    value: String(side === "a" ? VS.a : VS.b),
    label: tr(side === "a" ? "heads.virtual.head_a" : "heads.virtual.head_b"),
    onPick: (v) => {
      VS[side] = +v;
      vsShades();
      vsRender();
      btn.focus();
    },
  });
}
$("vh-a").addEventListener("click", () => vsPickHead("a"));
$("vh-b").addEventListener("click", () => vsPickHead("b"));
$("vh-notch").addEventListener("input", () => {
  VS.notch = +$("vh-notch").value;
  vsRender();
});
addEventListener("resize", () => !$("vhmodal").classList.contains("hidden") && vsLines());

const vsClose = () => closeSheet($("vhmodal"));
$("vhmodal").addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !$("vhexplain").classList.contains("hidden")) return;
  e.preventDefault();
  vsClose();
});
$("vh-cancel").addEventListener("click", vsClose);
$("vh-close").addEventListener("click", vsClose);

/* Create (after the explanation, the first time) or save. */
function vsCommit() {
  const mix = vsMix();
  if (VS.uid != null) {
    headsVirtualSet(VS.pid, VS.uid, mix);
    vsClose();
    VS.done?.(vhValue(VS.uid));
    return;
  }
  const value = headsVirtualAdd(VS.pid, mix);
  vsClose();
  if (value != null) VS.done?.(value);
}
$("vh-go").addEventListener("click", () => {
  if ($("vh-go").disabled) return;
  if (VS.uid != null || PRUI.vhExplained) return vsCommit();
  // The first creation says what happens when a spool is unloaded.
  $("vhx-body").textContent = tr("heads.virtual.explain.body", { name: VS.name, a: "T" + VS.a, b: "T" + VS.b });
  $("vhx-noshow").checked = false;
  openSheet($("vhexplain"));
  requestAnimationFrame(() => $("vhx-ok").focus());
});
$("vhx-ok").addEventListener("click", () => {
  if ($("vhx-noshow").checked) {
    PRUI.vhExplained = true;
    pruiSave();
  }
  closeSheet($("vhexplain"));
  vsCommit();
});
// ✕ or Esc: back to the creation sheet, nothing created.
$("vhx-close").addEventListener("click", () => {
  closeSheet($("vhexplain"));
  $("vh-go").focus();
});
$("vhexplain").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  closeSheet($("vhexplain"));
  $("vh-go").focus();
});

window.addEventListener("headschange", (e) => {
  if (!$("vhmodal").classList.contains("hidden") && (!e.detail?.pid || e.detail.pid === VS.pid)) vsRender();
});
