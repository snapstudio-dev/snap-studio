"use strict";
/* Welcome assistant.

   Steps: welcome (with the language), models folder, printer (network search
   or manual entry), slicing engine, AI (how to use it, then what it needs),
   the feature introductions (intros.js INTROS: Snappy, the anonymous
   count…, those not available passed), summary and "Get Started". A new
   user answers everything here: no first-launch notice follows. It opens on
   first launch — no folder nor printer known — then on demand (Settings, Help
   menu). Finished or "Skip": it never comes back on its own. */

const W = {
  open: false,
  step: 0,
  dir: null,
  added: [],
  confetti: 0,
  /* AI step: the questions ("ask"), then the checks ("result"). */
  ai: { phase: "ask", use: "yes", mode: "container" },
  /* The introductions shown, by id: applied when the assistant closes. */
  intros: new Set(),
};
/* Steps: 0 welcome, 1 models, 2 printer, 3 engine, 4 AI, then one per
   feature introduction, then ready. */
const W_AI = 4;
const W_INTRO = W_AI + 1;
const W_STEPS = W_INTRO + INTROS.length + 1;
/* The introduction a step shows, if any. */
const wIntroAt = (n) => (n >= W_INTRO && n < W_INTRO + INTROS.length ? INTROS[n - W_INTRO] : null);
const wIntroHost = (entry) => $("w-" + entry.id);
const W_KEY = "snapstudio.welcome";
const W_ORCA = "https://github.com/Snapmaker/OrcaSlicer/releases/latest";

const W_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
const W_WARN = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>';
const W_SKIP = '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>';

/* ------------------------------------------------------------ navigation */

function welcomeOpen() {
  W.open = true;
  W.step = 0;
  W.dir = null;
  W.added = [];
  W.intros.clear();
  for (const entry of INTROS) {
    wIntroHost(entry).innerHTML = "";
    delete wIntroHost(entry).dataset.entered;
  }
  $("w-folder").classList.add("hidden");
  $("w-added").classList.add("hidden");
  $("w-form").classList.add("hidden");
  $("w-manual").classList.remove("hidden");
  $("welcome").classList.remove("hidden", "closing");
  wRenderPlaces();
  wGo(0);
}

function wGo(n) {
  const from = W.step;
  // An introduction without a place now (a build that cannot send has no
  // count to ask about) is passed.
  W.step = introsLand(n, from, W_STEPS - 1, (k) => wIntroAt(k) && !wIntroAt(k).available());
  // The network search only runs on the Printer step.
  if (from === 2 && W.step !== 2) discoverStop();
  if (W.step === 2 && (from !== 2 || !DISC.view)) discoveryList($("w-disc"), wPick);
  if (W.step === 3) wEngine();
  if (W.step === W_AI && from !== W_AI) wAiEnter();
  const intro = wIntroAt(W.step);
  if (intro && from !== W.step) {
    introShow(intro, wIntroHost(intro));
    W.intros.add(intro.id);
  }
  if (W.step === W_STEPS - 1) wSummary();
  $("w-track").style.transform = `translateX(${-100 * W.step}%)`;
  document.querySelectorAll("#welcome .w-step").forEach((el, i) => {
    el.classList.toggle("on", i === W.step);
    el.inert = i !== W.step;
  });
  document.querySelectorAll("#w-dots i").forEach((d, i) => {
    d.classList.toggle("on", i === W.step);
    d.classList.toggle("hidden", !!wIntroAt(i) && !wIntroAt(i).available());
  });
  wNav();
}

/* Bottom buttons: "Skip" until the step is filled in. */
function wNav() {
  const last = W.step === W_STEPS - 1;
  $("w-back").classList.toggle("invisible", W.step === 0);
  $("w-next").classList.toggle("invisible", last);
  $("w-skip").classList.toggle("invisible", last);
  const done =
    W.step === 1 ? !!W.dir
    : W.step === 2 ? W.added.length > 0
    : W.step === 3 ? !engNeeded()
    : true;
  $("w-next").textContent = tr(done ? "common.continue" : "common.skip");
  $("w-next").classList.toggle("primary", done);
  if (W.step === W_AI) wAiNav();
}

function welcomeClose() {
  localStorage.setItem(W_KEY, JSON.stringify({ done: true, at: Date.now() }));
  // The language shown so far may only be the system's: make it a choice.
  setLanguage(LANG);
  discoverStop();
  cancelAnimationFrame(W.confetti);
  W.open = false;
  const el = $("welcome");
  el.classList.add("closing");
  setTimeout(() => el.classList.add("hidden"), 260);
  // The introductions shown: their choices apply.
  for (const entry of INTROS) if (W.intros.has(entry.id)) entry.apply(wIntroHost(entry));
}

/* "Get Started": the app opens on what was just set up. */
async function welcomeStart() {
  const dir = W.dir, printers = W.added.length;
  welcomeClose();
  if (dir) {
    switchView("files");
    await openDir(dir);
  } else if (printers) {
    switchView("printers");
  }
}

/* ------------------------------------------------------------ folder */

async function wRenderPlaces() {
  const box = $("w-places");
  box.innerHTML = "";
  const places = await invoke("quick_places").catch(() => []);
  for (const p of places) {
    const b = document.createElement("button");
    b.className = "place";
    b.textContent = p.label;
    b.title = p.path;
    b.dataset.path = p.path;
    b.onclick = () => wSetDir(p.path);
    box.appendChild(b);
  }
}

async function wSetDir(dir) {
  W.dir = dir;
  document.querySelectorAll("#w-places .place").forEach((b) => b.classList.toggle("on", b.dataset.path === dir));
  const box = $("w-folder");
  box.classList.remove("hidden");
  box.innerHTML = `${W_CHECK}<span><b>${esc(dir.split(/[\\/]/).pop() || dir)}</b><small>${esc(dir)}</small></span>`;
  wNav();
  const files = await invoke("scan_folder", { dir, recursive: false }).catch(() => null);
  if (W.dir !== dir || !files) return;
  const n = files.length;
  box.querySelector("small").textContent =
    `${dir} · ${n ? tr("welcome.models.count", { n }) : tr("welcome.models.none")}`;
}

/* ------------------------------------------------------------ printer */

function wPick(f) {
  $("w-form").classList.remove("hidden");
  $("w-manual").classList.add("hidden");
  const a = discAddr(f);
  $("w-pname").value = f.name;
  $("w-phost").value = a.host;
  $("w-pport").value = a.port;
  wProbe();
}

async function wProbe() {
  const host = $("w-phost").value.trim();
  const box = $("w-ptest");
  if (!host) {
    box.className = "pf-test err";
    box.textContent = tr("printers.form.host_missing");
    return null;
  }
  const port = Math.round(+$("w-pport").value || 7125);
  if (!(port >= 1 && port <= 65535)) {
    box.className = "pf-test err";
    box.textContent = tr("printers.form.port_invalid");
    return null;
  }
  box.className = "pf-test";
  box.textContent = tr("printers.form.testing");
  // A slow answer for a host typed before must not fill in the fields now.
  const seq = (W.probeSeq = (W.probeSeq || 0) + 1);
  let r;
  try {
    r = await invoke("printer_probe", { host, port });
  } catch (e) {
    r = { ok: false, detail: String(e) };
  }
  if (seq !== W.probeSeq) return null;
  box.className = "pf-test " + (r.ok ? "ok" : "err");
  box.textContent = r.detail;
  if (r.ok) {
    $("w-pport").value = r.port;
    if (!$("w-pname").value.trim() && r.hostname) $("w-pname").value = r.hostname;
  }
  return r;
}

async function wAdd() {
  const host = $("w-phost").value.trim();
  if (!host) return wProbe();
  const found = [...DISC.items.values()].find((f) => discAddr(f).host === host);
  const printer = {
    id: "",
    name: $("w-pname").value.trim() || host,
    host,
    port: +$("w-pport").value || 7125,
    model: found ? discModel(found) : "Snapmaker U1",
    note: "",
  };
  try {
    P.list = await invoke("printer_save", { printer });
    W.added.push(printer.name);
    await prnLoad();
    $("w-form").classList.add("hidden");
    $("w-manual").classList.remove("hidden");
    $("w-ptest").textContent = "";
    const box = $("w-added");
    box.classList.remove("hidden");
    box.innerHTML = `${W_CHECK}<span><b>${W.added.map(esc).join(", ")}</b><small>${esc(
      tr("welcome.printer.added", { n: W.added.length })
    )}</small></span>`;
    DISC.picked = null;
    discRender();
    wNav();
  } catch (e) {
    $("w-ptest").className = "pf-test err";
    $("w-ptest").textContent = tr("printers.form.save_failed", { err: e });
  }
}

/* ------------------------------------------------------------ end */

/* "Engine" step: the shared block, and onwards as soon as it is installed. */
async function wEngine() {
  await engStatus();
  engMount($("w-engine"), { onDone: wNav });
  wNav();
}

async function wSummary() {
  const ul = $("w-summary");
  const row = (ok, title, sub, extra = "") =>
    `<li class="${ok === true ? "ok" : ok === false ? "warn" : "skip"}">${ok === true ? W_CHECK : ok === false ? W_WARN : W_SKIP}
      <span><b>${title}</b><small>${sub}</small>${extra}</span></li>`;
  const folder = W.dir
    ? row(true, esc(tr("welcome.sum.folder")), esc(W.dir))
    : row(null, esc(tr("welcome.sum.folder")), esc(tr("welcome.sum.folder.later")));
  const printers = W.added.length
    ? row(true, esc(tr("welcome.sum.printers", { n: W.added.length })), W.added.map(esc).join(", "))
    : row(null, esc(tr("welcome.sum.printers", { n: 1 })), esc(tr("welcome.sum.printers.later")));
  const engine = esc(tr("engine.title"));
  ul.innerHTML = folder + printers + row(true, engine, esc(tr("welcome.sum.checking")));
  const s = await engStatus();
  let html;
  if (s?.referenced) {
    html = s.installed
      ? row(true, engine, esc(tr("welcome.sum.engine.ok", { version: s.version })))
      : row(null, engine, esc(tr("welcome.sum.engine.later")));
  } else {
    // Development build: an installed Snapmaker Orca serves as the engine.
    const slicers = await invoke("slicers_list").catch(() => []);
    html = slicers.some((x) => x.name === "Snapmaker Orca")
      ? row(true, "Snapmaker Orca", esc(tr("welcome.sum.orca.ok")))
      : row(false, esc(tr("welcome.sum.orca.missing")), esc(tr("welcome.sum.orca.needed")),
          ` <button class="w-link" id="w-orca">${esc(tr("common.download"))}</button>`);
  }
  ul.lastElementChild.outerHTML = html;
  // The AI, as chosen on its step.
  const ai = esc(tr("nav.ia"));
  const allowed = aiAllowed();
  ul.insertAdjacentHTML(
    "beforeend",
    state.aiModes === "off" || !state.aiModes
      ? row(null, ai, esc(tr("welcome.sum.ai.later")))
      : allowed.length
        ? row(true, ai, esc(tr("ais.head.ready", { modes: allowed.map((m) => tr("ais.mode." + m)).join(" · ") })))
        : row(false, ai, esc(tr("welcome.sum.ai.todo")))
  );
  // The introductions shown, as chosen on their steps.
  for (const entry of INTROS) {
    if (!W.intros.has(entry.id) || !entry.summary) continue;
    const [ok, title, sub] = entry.summary(wIntroHost(entry));
    ul.insertAdjacentHTML("beforeend", row(ok, esc(title), esc(sub)));
  }
  $("w-orca")?.addEventListener("click", () =>
    invoke("plugin:opener|open_url", { url: W_ORCA }).catch((e) => toast(String(e), true))
  );
  wConfetti();
}

/* ------------------------------------------------------------ introductions */

/* Their steps (intros.js), before the last one, and a dot per step. */
{
  const ready = $("w-track").lastElementChild;
  for (const entry of INTROS) $("w-track").insertBefore(introSection(entry, "w"), ready);
  $("w-dots").innerHTML = "<i></i>".repeat(W_STEPS);
}

/* ------------------------------------------------------------ AI */

/* The sandbox does not run on Windows: only "this computer" is offered. */
const wAiNoSandbox = () => navigator.userAgent.includes("Windows");

/* Arriving on the step: the questions, prefilled with an earlier answer. */
function wAiEnter() {
  const prev = state.aiModes;
  W.ai.phase = "ask";
  W.ai.use = prev === "off" ? "no" : "yes";
  W.ai.mode = wAiNoSandbox() ? "local" : prev && prev !== "off" ? prev : "container";
  // The sandbox it will be: the built-in one, or yolobox for whoever has it.
  $("w-ai-sandbox-sub").dataset.i18n = aiSandboxSub();
  $("w-ai-sandbox-sub").textContent = tr(aiSandboxSub());
  document.querySelectorAll('#w-ai-where .w-opt[data-mode="container"], #w-ai-where .w-opt[data-mode="both"]').forEach((el) =>
    el.classList.toggle("hidden", wAiNoSandbox())
  );
  wAiRender();
}

function wAiRender() {
  const ask = W.ai.phase === "ask";
  $("w-ai-ask").classList.toggle("hidden", !ask);
  $("w-ai-result").classList.toggle("hidden", ask);
  document.querySelectorAll('input[name="w-ai-use"]').forEach((i) => (i.checked = i.value === W.ai.use));
  document.querySelectorAll('input[name="w-ai-mode"]').forEach((i) => (i.checked = i.value === W.ai.mode));
  $("w-ai-where").classList.toggle("off", W.ai.use === "no");
  if (!ask) {
    $("w-ai-choice").textContent = tr("welcome.ai.chosen." + W.ai.mode);
    aiRenderChecks($("w-ai-checks"), W.ai.mode);
  }
  wNav();
}

/* The step's buttons: "Check" after the questions; then "Continue", or
   "Continue without AI" while no chosen mode is ready. Never a dead end. */
function wAiNav() {
  const next = $("w-next");
  if (W.ai.phase === "ask") {
    const check = W.ai.use === "yes";
    next.textContent = tr(check ? "welcome.ai.check" : "common.continue");
    next.classList.add("primary");
    return;
  }
  const ok = aiAllowed().length > 0;
  next.textContent = tr(ok || AIS.pending ? "common.continue" : "welcome.ai.without");
  next.classList.toggle("primary", ok);
}

/* "Next" on the AI step: check first, or save "not now" and go on. */
function wAiNext() {
  if (W.ai.phase === "ask") {
    if (W.ai.use === "no") {
      aiSetChoice("off");
      return wGo(W.step + 1);
    }
    aiSetChoice(W.ai.mode);
    W.ai.phase = "result";
    aiCheck(true).then(() => W.step === W_AI && wAiRender());
    wAiRender();
    return;
  }
  wGo(W.step + 1);
}

document.querySelectorAll('input[name="w-ai-use"]').forEach((i) =>
  i.addEventListener("change", () => {
    W.ai.use = i.value;
    wAiRender();
  })
);
document.querySelectorAll('input[name="w-ai-mode"]').forEach((i) =>
  i.addEventListener("change", () => {
    W.ai.mode = i.value;
    if (W.ai.use === "no") W.ai.use = "yes";
    wAiRender();
  })
);
$("w-ai-change").addEventListener("click", () => {
  W.ai.phase = "ask";
  wAiRender();
});
$("w-ai-recheck").addEventListener("click", () => {
  aiCheck(true).then(() => W.step === W_AI && wAiRender());
  wAiRender();
});
window.addEventListener("aichange", () => {
  if (W.open && W.step === W_AI && W.ai.phase === "result") wAiRender();
});

/* A burst of confetti in the colors of the U1's four heads, once. */
function wConfetti() {
  cancelAnimationFrame(W.confetti);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("w-confetti");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const colors = TOOL_COLORS.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  const parts = Array.from({ length: 110 }, () => {
    const a = Math.random() * Math.PI * 2, v = 2.5 + Math.random() * 5.5;
    return {
      x: w / 2, y: h / 2,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      s: 4 + Math.random() * 5,
      c: colors[(Math.random() * colors.length) | 0],
    };
  });
  const t0 = performance.now();
  const frame = (t) => {
    const k = (t - t0) / 1800;
    ctx.clearRect(0, 0, w, h);
    if (k >= 1) return;
    ctx.globalAlpha = 1 - k * k;
    for (const p of parts) {
      p.vy += 0.16;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    W.confetti = requestAnimationFrame(frame);
  };
  W.confetti = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------ events */

$("w-next").addEventListener("click", () => (W.step === W_AI ? wAiNext() : wGo(W.step + 1)));
$("w-back").addEventListener("click", () => {
  // From the checks, back to the questions first.
  if (W.step === W_AI && W.ai.phase === "result") {
    W.ai.phase = "ask";
    return wAiRender();
  }
  wGo(W.step - 1);
});
$("w-skip").addEventListener("click", welcomeClose);
$("w-start").addEventListener("click", welcomeStart);
$("w-pick").addEventListener("click", async () => {
  const dir = await invoke("pick_folder");
  if (dir) wSetDir(dir);
});
$("w-manual").addEventListener("click", () => {
  $("w-form").classList.remove("hidden");
  $("w-manual").classList.add("hidden");
  $("w-pname").value = "";
  $("w-phost").value = "";
  $("w-pport").value = 7125;
  $("w-ptest").textContent = "";
  DISC.picked = null;
  discRender();
  $("w-phost").focus();
});
$("w-ptry").addEventListener("click", wProbe);
$("w-padd").addEventListener("click", wAdd);
$("w-again").addEventListener("click", welcomeOpen);

/* The language can change on the first step: re-render what code wrote. */
window.addEventListener("langchange", () => {
  if (!W.open) return;
  wNav();
  wRenderPlaces().then(() => W.dir && wSetDir(W.dir));
  if (W.step === W_AI) wAiRender();
  const intro = wIntroAt(W.step);
  if (intro) intro.build(wIntroHost(intro), { notice: false });
  if (W.step === W_STEPS - 1) wSummary();
});
onMenu("welcome", welcomeOpen);

document.addEventListener("keydown", (e) => {
  if (!W.open) return;
  const typing = e.target.closest("input, textarea, select");
  if (e.key === "Enter") {
    e.preventDefault();
    if (typing && W.step === 2) wAdd();
    else if (W.step === W_STEPS - 1) welcomeStart();
    else if (!e.target.closest("button")) W.step === W_AI ? wAiNext() : wGo(W.step + 1);
  } else if (!typing && (e.key === "ArrowLeft" || (e.metaKey && e.key === "["))) {
    wGo(W.step - 1);
  } else if (!typing && e.key === "ArrowRight") {
    wGo(W.step + 1);
  }
  // The app's shortcuts do not go through the assistant.
  e.stopPropagation();
}, true);

/* First launch: nothing is set up yet. An existing user (or one carried
   over from 3MF Studio) already has a folder or a printer. */
(async () => {
  // No assistant: the first-launch notice, with what was never answered.
  if (localStorage.getItem(W_KEY)) return typeof launchNotices === "function" && launchNotices();
  const printers = await invoke("printers_list").catch(() => []);
  if (state.dir || state.recents.length || printers.length) {
    localStorage.setItem(W_KEY, JSON.stringify({ done: true, existing: true }));
    if (typeof launchNotices === "function") launchNotices();
    return;
  }
  welcomeOpen();
})();
