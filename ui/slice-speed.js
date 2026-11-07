"use strict";
/* Speed adjustment of the slice sheet: the row under Adjustments (one
   slider, a percentage of the profile) and its ⚙ panel (profile → computed
   values, each linked to the slider until typed by hand). The arithmetic is
   in speed.js. The state is remembered per machine profile, like the other
   adjustments, and only values that differ from the profile reach the
   engine. */

const SPDUI = { profile: null, caps: {}, machines: {}, flows: {} };
SL.speed = spdState();

const spdView = () => spdCompute(SL.speed, SPDUI.profile || {}, SPDUI.caps);
/* Values for the engine; none until the profile's values are known. */
const spdOverrides = () => (SPDUI.profile ? spdView().overrides : {});
const spdNChanged = () => Object.keys(spdOverrides()).length;
const spdPctText = (p) => `${p} %`;
const spdUnit = (accel) => (accel ? "mm/s²" : "mm/s");

/* Profile values (raw: lists kept), from the details read by
   advRefreshDefaults, and the machine's limits. */
async function spdSetProfile(values) {
  SPDUI.profile = values ? { ...SPD_ENGINE_DEFAULTS, ...values } : null;
  const machine = $("s-machine").value;
  if (machine && !(machine in SPDUI.machines)) {
    SPDUI.machines[machine] = await invoke("slice_details", { name: machine, machine, simple: null, overrides: {}, color: null })
      .then((d) => spdCaps(d?.values || {}))
      .catch(() => ({}));
  }
  SPDUI.caps = SPDUI.machines[machine] || {};
}

function spdLoad(saved) {
  SL.speed = spdNormalize(saved);
}

function spdRemember() {
  const machine = $("s-machine").value;
  if (machine) remember(machine, { speed: SL.speed });
}

/* For the summary: "speed 75 %", coloured, while it does something. */
function spdSummary() {
  if (!spdActive(SL.speed) || !spdNChanged()) return null;
  const n = Object.keys(SL.speed.edits).length;
  const text = SL.speed.pct !== SPD_DEFAULT || !n ? tr("slice.sum.speed", { v: spdPctText(SL.speed.pct) }) : tr("slice.sum.speed_edited", { n });
  return { text, cls: "spd " + spdTone(SL.speed.pct) };
}

function spdMarks(el) {
  el.innerHTML = SPD_MARKS.map((m) => {
    const left = ((m.v - SPD_MIN) / (SPD_MAX - SPD_MIN)) * 100;
    return `<button type="button" data-spd-pct="${m.v}" style="left:${left}%" title="${esc(spdPctText(m.v))}">${esc(tr(m.t))}</button>`;
  }).join("");
}
function spdMarksOn() {
  document.querySelectorAll("#smodal [data-spd-pct]").forEach((b) => b.classList.toggle("on", +b.dataset.spdPct === SL.speed.pct));
}

/* ------------------------------------------------------------ main row */

function spdRenderRow() {
  const st = SL.speed;
  const tone = spdTone(st.pct);
  $("s-speed").value = st.pct;
  $("s-speed").setAttribute("aria-valuetext", spdPctText(st.pct));
  $("s-speed-val").textContent = spdPctText(st.pct);
  $("s-speed-val").className = "sl-speed-val" + (tone ? " " + tone : "");
  const marks = document.querySelector('#s-speed-row [data-marks]');
  if (!marks.children.length || marks.dataset.lang !== LANG) {
    spdMarks(marks);
    marks.dataset.lang = LANG;
  }
  spdMarksOn();
  const mark = SPD_MARKS.find((m) => m.v === st.pct);
  const edited = Object.keys(st.edits).length;
  $("s-adv-sum-speed").textContent = [mark && tr(mark.t), edited && tr("slice.speed.edited", { n: edited })].filter(Boolean).join(" · ");
  const n = spdNChanged();
  const btn = document.querySelector('.sl-adv-btn[data-adv="speed"]');
  btn.classList.toggle("mod", n > 0);
  btn.classList.toggle("slow", n > 0 && tone === "slow");
  btn.querySelector(".sl-adv-n").textContent = n || "";
}

/* ------------------------------------------------------------ ⚙ panel */

function spdRowHtml(r) {
  const label = tr(r.t);
  const unit = spdUnit(r.accel);
  const link = r.linked
    ? `<span class="spd-link" title="${esc(tr("slice.speed.linked"))}" aria-label="${esc(tr("slice.speed.linked"))}">🔗</span>`
    : `<button type="button" class="spd-link" data-spd-link="${r.id}" title="${esc(tr("slice.speed.unlinked"))}" aria-label="${esc(tr("slice.speed.unlinked"))}">🔓</button>`;
  const known = r.profile != null && SPDUI.profile;
  return `<div class="grow-row adv-row spd-row${r.linked ? "" : " mod"}" data-row="${r.id}">
    <span class="k">${esc(label)}</span>
    ${link}
    <span class="spd-from" data-from="${r.id}">${known ? esc(`${fmtNum(r.profile)} →`) : "—"}</span>
    <input type="number" class="field num" min="1" step="${r.accel ? 10 : 1}" data-spd-row="${r.id}" aria-label="${esc(label)}" value="${known && r.value != null ? r.value : ""}"${known ? "" : " disabled"} />
    <span class="unit">${esc(unit)}</span>
  </div>`;
}

function spdRenderPanel() {
  const v = spdView();
  $("s-adv-title").textContent = tr("slice.speed");
  const opt = (k, t) => `<div class="grow-row adv-row"><span class="k">${esc(tr(t))}</span>
    <input type="checkbox" class="sw" role="switch" data-spd-opt="${k}"${SL.speed[k] ? " checked" : ""} /></div>`;
  $("s-adv-body").innerHTML = `
    <div class="sl-card spd-global">
      <div class="spd-global-head"><span id="spd-global-label">${esc(tr("slice.speed.global"))}</span><b id="spd-global-val"></b></div>
      <input type="range" min="${SPD_MIN}" max="${SPD_MAX}" step="${SPD_STEP}" data-spd="pct" aria-labelledby="spd-global-label" value="${SL.speed.pct}" />
      <div class="sl-speed-marks" data-marks="panel"></div>
    </div>
    <div class="set-section">${esc(tr("slice.speed.g.values"))}</div>
    <div class="group">${v.rows.map(spdRowHtml).join("")}</div>
    <div id="spd-cap" class="sl-adv-note info hidden"></div>
    <div id="spd-flow" class="sl-adv-note info">${esc(tr("slice.speed.flow"))}</div>
    <div class="set-section">${esc(tr("slice.speed.g.also"))}</div>
    <div class="group">${opt("first", "slice.speed.opt.first")}${opt("travel", "slice.speed.opt.travel")}</div>`;
  spdMarks(document.querySelector('#s-adv-body [data-marks="panel"]'));
  steppersIn($("s-adv-body"));
  // Slicing: locked, as the rest of the sheet.
  if ($("s-go").classList.contains("hidden")) {
    $("s-adv-body").querySelectorAll("input, button").forEach((el) => (el.disabled = true));
  }
  spdUpdatePanel(v);
  spdFlowNote();
}

/* The global slider moved: values in place (the slider being dragged
   stays), structure untouched. */
function spdUpdatePanel(v = spdView()) {
  if (ADV.cat !== "speed") return;
  const st = SL.speed;
  const tone = spdTone(st.pct);
  const val = $("spd-global-val");
  val.textContent = spdPctText(st.pct);
  val.className = tone;
  const range = document.querySelector('#s-adv-body [data-spd="pct"]');
  if (+range.value !== st.pct) range.value = st.pct;
  range.setAttribute("aria-valuetext", spdPctText(st.pct));
  for (const r of v.rows) {
    const input = document.querySelector(`#s-adv-body [data-spd-row="${r.id}"]`);
    if (input && document.activeElement !== input && SPDUI.profile && r.value != null) input.value = r.value;
  }
  spdMarksOn();
  $("s-adv-reset").classList.toggle("hidden", !spdActive(st) && !st.first && !st.travel);
  const cap = $("spd-cap");
  const above = st.pct > SPD_DEFAULT && (SPDUI.caps.speed || SPDUI.caps.accel);
  cap.classList.toggle("hidden", !above);
  if (above) {
    cap.textContent = tr("slice.speed.caps", {
      speed: SPDUI.caps.speed ? `${fmtNum(SPDUI.caps.speed)} mm/s` : "—",
      accel: SPDUI.caps.accel ? `${fmtNum(SPDUI.caps.accel)} mm/s²` : "—",
    });
  }
}

/* The engine keeps each filament under its maximum volumetric speed; the
   panel says which, for the heads the model uses. */
async function spdFlowNote() {
  const machine = $("s-machine").value;
  const used = typeof slUsedSet === "function" ? slUsedSet() : new Set();
  const names = [...new Set([...document.querySelectorAll("#s-heads select")].filter((_, i) => !used.size || used.has(i)).map((s) => s.value).filter(Boolean))];
  // Heads changed again while the profiles were read: that call's list wins.
  const seq = (SPDUI.flowSeq = (SPDUI.flowSeq || 0) + 1);
  const got = await Promise.all(
    names.map(async (name) => {
      if (!(name in SPDUI.flows)) {
        SPDUI.flows[name] = await invoke("slice_details", { name, machine, simple: null, overrides: {}, color: null })
          .then((d) => spdNum(d?.values?.filament_max_volumetric_speed))
          .catch(() => null);
      }
      return SPDUI.flows[name] > 0 ? `${name.replace(/\s*@.*$/, "")} ${fmtNum(SPDUI.flows[name])} mm³/s` : null;
    })
  );
  const el = $("spd-flow");
  if (!el || ADV.cat !== "speed" || seq !== SPDUI.flowSeq) return;
  const list = got.filter(Boolean);
  el.textContent = list.length ? tr("slice.speed.flow_list", { list: list.join(" · ") }) : tr("slice.speed.flow");
}

/* ------------------------------------------------------------ changes */

function spdChanged({ panel = "update" } = {}) {
  spdRemember();
  spdRenderRow();
  if (ADV.cat === "speed") panel === "render" ? spdRenderPanel() : spdUpdatePanel();
  slSummary();
}

function spdSetPct(p) {
  const pct = spdNormalize({ pct: p }).pct;
  if (pct === SL.speed.pct) return;
  SL.speed = { ...SL.speed, pct };
  spdChanged();
}

function spdResetAll() {
  SL.speed = spdReset();
  spdChanged({ panel: "render" });
}

$("s-speed").addEventListener("input", (e) => spdSetPct(+e.target.value));
$("smodal").addEventListener("click", (e) => {
  const m = e.target.closest("[data-spd-pct]");
  if (m && !m.disabled) spdSetPct(+m.dataset.spdPct);
  const l = e.target.closest("[data-spd-link]");
  if (l) {
    SL.speed = spdLink(SL.speed, l.dataset.spdLink);
    spdChanged({ panel: "render" });
  }
});
$("s-adv-body").addEventListener("input", (e) => {
  if (e.target.matches('[data-spd="pct"]')) spdSetPct(+e.target.value);
});
$("s-adv-body").addEventListener("change", (e) => {
  const row = e.target.closest("[data-spd-row]");
  if (row) {
    SL.speed = spdEdit(SL.speed, row.dataset.spdRow, row.value, SPDUI.profile || {}, SPDUI.caps);
    spdChanged({ panel: "render" });
    requestAnimationFrame(() => document.querySelector(`#s-adv-body [data-spd-row="${row.dataset.spdRow}"]`)?.focus());
    return;
  }
  const opt = e.target.closest("[data-spd-opt]");
  if (opt) {
    SL.speed = { ...SL.speed, [opt.dataset.spdOpt]: opt.checked };
    spdChanged({ panel: "render" });
    requestAnimationFrame(() => document.querySelector(`#s-adv-body [data-spd-opt="${opt.dataset.spdOpt}"]`)?.focus());
  }
});
window.addEventListener("langchange", () => {
  if ($("smodal").classList.contains("hidden")) return;
  spdRenderRow();
});
