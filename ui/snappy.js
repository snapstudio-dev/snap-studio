"use strict";
/* Snappy, the workshop assistant (src-tauri/src/snappy.rs), in the app;
   its conversation card is snappy-card.js.

   A nameless icon at the right end of the sidebar's separator, between
   What's new and Settings, always there; its avatar is alive
   (snappy-avatar.js). A click opens the conversation, a card floating
   beside the sidebar over the current view (its bottom level with the
   icon, a tail pointing at it) and the view stays where it is; the icon
   or a click outside the card closes it. A corner button doubles the
   card's width, or brings it back. Over a sheet, Snappy goes beside the
   sheet; over a site of Explore, a native view of ours shows the card
   (snappy-view.html), since the site's view covers the page.

   The app answers Snappy's questions about what only the page holds
   (Prepare's state, the Files view) through "snappy-ui". */

/* Snappy is on (Settings › AI › Snappy) until switched off. Its view over
   a site: what it was last told, and whether it shows. */
SNAP.enabled = true;
SNAP.viewKey = "";
SNAP.viewShown = false;

/* Snappy needs the AI and its own switch: hidden when either is off. */
const snappyAvailable = () => SNAP.enabled && (typeof aiChoice !== "function" || aiChoice() !== "off");

/* ------------------------------------------------------------ the icon */

const SNAP_AV = [snappyAvatar($("snappy-fab-av"))];
const snappyMood = (mood) => SNAP_AV.forEach((a) => a.setMood(mood));

/* Shown unless the AI is off. */
function snappyFabState() {
  $("snappy-fab").classList.toggle("hidden", !snappyAvailable());
  snappyDock();
  snappyViewSync();
}

/* The card's bottom level with the icon, wherever the sidebar puts it;
   beside a sheet, the icon level with the sheet's bottom and the card
   above it. */
function snappyPlace() {
  if (SNAP.sheet) {
    const h = SNAP.sheet.querySelector(".modal-box")?.offsetHeight || 0;
    snappyDockEl.style.height = h + "px";
    $("snappy").style.bottom = "";
    $("snappy").style.height = Math.max(240, h - 48) + "px";
    return;
  }
  $("snappy").style.height = "";
  const f = $("snappy-fab").getBoundingClientRect();
  const c = $("content").getBoundingClientRect();
  if (!f.height) return;
  $("snappy").style.bottom = Math.max(14, Math.round(c.bottom - f.bottom)) + "px";
}
window.addEventListener("resize", () => {
  if (SNAP.open) snappyPlace();
  snappyViewSync();
});

/* The icon opens the conversation, and closes it. */
$("snappy-fab").addEventListener("click", () => (SNAP.open ? snappyClose() : snappyOpen()));

/* Twice as wide, or back: kept for the next openings. */
function snappyWide(on) {
  $("snappy").classList.toggle("wide", on);
  snappyViewSoon();
  $("snappy-wide").title = tr(on ? "snappy.narrower" : "snappy.wider");
  localStorage.setItem("snapstudio.snappy.wide", on ? "1" : "");
}
snappyWide(localStorage.getItem("snapstudio.snappy.wide") === "1");
window.addEventListener("langchange", () => snappyWide($("snappy").classList.contains("wide")));

/* A click outside the drawer closes it — but not one in a sheet or a
   dialog of the app shown over it (the spool check of a send). */
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!SNAP.open || e.target.closest?.("#snappy, #snappy-fab, .modal, .menu, [role='dialog']")) return;
    snappyClose();
  },
  true
);

/* Over the slice sheet: the app behind it is dimmed and blurred, so Snappy
   goes to the sheet, above the blur. Its icon stands at the sheet's bottom left
   corner, its conversation opens as a panel above the icon, beside the
   sheet, and the sheet moves aside to make room. Back home when the sheet
   goes. */
const SNAP_HOME = { fab: $("snappy-fab").parentElement, drawer: $("snappy").parentElement };
const snappyDockEl = snappyDiv("snappy-dock");
/* The sheet grows or shrinks (an advanced panel, a message): the icon
   stays level with its bottom. */
const snappyDockFit = new ResizeObserver(() => snappyPlace());

/* Only the slice sheet (owner's decision, 2026-11-06): Snappy sets slices
   up there. Over any other sheet it stays home, under the blur. */
function snappyTopSheet() {
  const m = $("smodal");
  if (!snappyAvailable() || m.classList.contains("hidden") || m.classList.contains("closing")) return null;
  return m;
}

function snappyDock() {
  const sheet = snappyTopSheet();
  if (sheet === SNAP.sheet) return;
  SNAP.sheet?.classList.remove("with-snappy");
  SNAP.sheet = sheet;
  snappyDockFit.disconnect();
  if (sheet) {
    snappyDockEl.append($("snappy-fab"), $("snappy"));
    sheet.prepend(snappyDockEl);
    sheet.classList.add("with-snappy");
    snappyDockFit.observe(sheet.querySelector(".modal-box"));
  } else {
    // Home first: once the dock leaves the page, its content cannot be
    // found by id any more.
    SNAP_HOME.fab.appendChild($("snappy-fab"));
    SNAP_HOME.drawer.prepend($("snappy"));
    snappyDockEl.remove();
  }
  snappyPlace();
  snappyViewSync();
}

{
  const obs = new MutationObserver(snappyDock);
  for (const m of document.querySelectorAll(".modal")) obs.observe(m, { attributes: true, attributeFilter: ["class"] });
}

/* The card keeps its keys: a sheet under it must not take Enter (slice)
   or Escape (close) typed to Snappy. */
$("snappy").addEventListener("keydown", (e) => e.stopPropagation());

setInterval(snappyFabState, 1000);
snappyFabState();

/* ------------------------------------------------------------ the drawer */

function snappyOpen() {
  if (SNAP.open) return;
  SNAP.open = true;
  snappyPlace();
  const d = $("snappy");
  d.classList.remove("hidden");
  requestAnimationFrame(() => d.classList.add("in"));
  invoke("snappy_drawer", { open: true }).catch(() => {});
  if (!SNAP.loaded) snappyLoad();
  requestAnimationFrame(() => $("snappy-input").focus());
  snappyViewSoon();
}

function snappyClose() {
  if (!SNAP.open) return;
  SNAP.open = false;
  const d = $("snappy");
  d.classList.remove("in");
  setTimeout(() => {
    if (!SNAP.open) d.classList.add("hidden");
  }, 160);
  // Closed, whatever waited for a yes is refused (snappy_tools/approval.rs).
  invoke("snappy_drawer", { open: false }).catch(() => {});
  for (const id of [...SNAP.cards.keys()]) snappyCardDone(id, false);
  snappyFabState();
}

/* ------------------------------------------------------------ over a site */

/* A site of Explore is a native view over the page, which covers the card.
   While one shows, Rust lays a view of ours at the card's place
   (library.rs SNAPPY, snappy-view.html), as for the floating navigation:
   told where the card is, with the language and the context its messages
   carry, or that it is not wanted. The card here stays under the site;
   it takes over again when the site goes, with what was said meanwhile. */
function snappyViewSync() {
  const want = SNAP.open && !SNAP.sheet && typeof LIB !== "undefined" && LIB.visible;
  let rect = null;
  let setup = "";
  if (want) {
    const r = $("snappy").getBoundingClientRect();
    // Its tail, on the left, comes too.
    rect = { x: r.left - 10, y: r.top, w: r.width + 10, h: r.height };
    setup = JSON.stringify({ lang: LANG, context: snappyContext() });
  }
  const key = rect ? `${setup}|${[rect.x, rect.y, rect.w, rect.h].map(Math.round).join(",")}` : "";
  if (key === SNAP.viewKey) return;
  SNAP.viewKey = key;
  invoke("snappy_view_set", { rect, setup }).catch(() => {});
}

/* A new language: the view over a site takes it at once (its setup carries
   the language, and a new setup makes the view again). */
window.addEventListener("langchange", snappyViewSync);

/* Once the card has finished moving (opening, widening). */
function snappyViewSoon() {
  setTimeout(snappyViewSync, 240);
}

listen("snappy-view", (e) => {
  const shown = !!e.payload?.shown;
  if (SNAP.viewShown && !shown && SNAP.open) snappyLoad();
  else if (SNAP.viewShown && !shown) SNAP.loaded = false;
  SNAP.viewShown = shown;
});

/* Its buttons: the card's state is this page's. */
listen("snappy-view-action", (e) => {
  const what = e.payload?.what;
  if (what === "close") snappyClose();
  else if (what === "wide") SNAP_PAGE.wide();
  else if (what === "auth") SNAP_PAGE.auth();
});

/* What Snappy is told about the app with each message: the view, the
   printer chosen, what Prepare holds; names only (the backend filters
   again). */
function snappyContext() {
  const view = window.currentView || "files";
  const ctx = { view, language: LANG };
  const printer = typeof SL !== "undefined" ? SL.printers.find((p) => p.id === ($("s-printer")?.value || SL.memory.printer)) : null;
  if (printer) ctx.printer = printer.name;
  if (view === "prepare" && typeof PR !== "undefined") ctx.prepare_objects = PR.objects.map((o) => o.name).filter(Boolean).slice(0, 30);
  return ctx;
}

Object.assign(SNAP_PAGE, {
  context: snappyContext,
  close: snappyClose,
  wide: () => snappyWide(!$("snappy").classList.contains("wide")),
  mood: snappyMood,
  auth: () => authOpen({ engine: "local" }),
});

/* ------------------------------------------------------------ the page's side */

/* Prepare's state, as the slice sheet keeps it. */
function snappyPrepare() {
  const machine = $("s-machine").value || SL.memory.last || "";
  const sheetOpen = !$("smodal").classList.contains("hidden");
  const printer = SL.printers.find((p) => p.id === ($("s-printer").value || SL.memory.printer));
  return snappySliceSummary({
    printer: printer?.name,
    machine,
    process: $("s-process").value || rememberFor(machine).process,
    simple: sheetOpen ? currentSimple() : rememberFor(machine).simple,
    layer: sheetOpen ? $("s-layer-val").textContent : null,
    stats: SL.preview?.stats,
    objects: typeof PR !== "undefined" ? PR.objects : [],
  });
}

/* ------------------------------------------------------------ the slice sheet */

const snappySheetOpen = () => !$("smodal").classList.contains("hidden");
const snappyChoices = (id) => [...$(id).options].map((o) => ({ value: o.value, label: o.textContent }));

/* Every setting of the open sheet, as the user sees it (slice_options):
   the profiles with their choices, the quick settings, and each advanced
   setting that applies now, from the same catalog as its panels. The
   heads' pickers are left out: the plate's colors decide them. */
function snappySliceOptions() {
  if (!snappySheetOpen()) return { error: "The slice sheet is closed: open it with open_slice_sheet." };
  const profile = (id) => ({ value: $(id).value, options: snappyChoices(id) });
  const quick = {};
  for (const [k, q] of Object.entries(SNAPPY_QUICK)) {
    const el = $("s-" + k);
    quick[k] = q.bool ? { value: el.checked } : { value: +el.value, min: q.min, max: q.max, step: +el.step || 1 };
  }
  const schema = ADV.schema?.keys || {};
  const advanced = [];
  for (const cat of Object.keys(ADV_CATS)) {
    for (const k of advCatKeys(cat)) {
      if (ADV_FILAMENT.has(k) || (ADV_WHEN[k] && !ADV_WHEN[k]())) continue;
      const d = schema[k] || {};
      const options = d.type === "enum" ? advOptions(k).map(([value, label]) => ({ value, label })) : undefined;
      advanced.push({
        key: k,
        label: d.label || k,
        panel: tr(ADV_CATS[cat].title),
        level: ADV_LEVEL_KEYS.has(k) ? "advanced" : "basic",
        type: d.type || null,
        value: advVal(k) ?? null,
        profile_value: ADV.defaults[k] ?? null,
        ...(options ? { options } : {}),
        ...(d.unit || ADV_UNITS[k] ? { unit: d.unit || ADV_UNITS[k] } : {}),
        ...(d.min != null ? { min: d.min } : {}),
        ...(d.max != null ? { max: d.max } : {}),
      });
    }
  }
  return {
    printer: currentPrinter()?.name || null,
    machine: profile("s-machine"),
    process: profile("s-process"),
    bed: profile("s-bed"),
    layer_height: $("s-layer-val").textContent,
    quick,
    advanced,
  };
}

const snappySliceWords = () => ({
  machine: tr("slice.nozzle"),
  process: tr("slice.quality"),
  bed: tr("slice.plate"),
  infill: tr("slice.infill"),
  walls: tr("slice.walls"),
  speed: tr("slice.speed"),
  supports: tr("slice.supports"),
  brim: tr("slice.brim"),
  yes: tr("common.yes"),
  no: tr("common.no"),
});

/* Snappy's changes checked against the open sheet (snappy-logic.js). */
function snappySliceChecked(changes) {
  const o = snappySliceOptions();
  return o.error ? o : { ...snappySliceCheck(changes, o, snappySliceWords()), options: o };
}

/* One change, as by hand: a nozzle profile reloads its lists, a quality
   profile its quick settings; both are waited for. */
async function snappySliceApply({ key, kind, value }) {
  if (key === "machine") {
    $("s-machine").value = value;
    await onMachineChange(null);
  } else if (key === "process") {
    $("s-process").value = value;
    await slProcessChanged();
  } else if (key === "bed") document.querySelector(`#s-beds [data-bed="${CSS.escape(value)}"]`)?.click();
  else if (key === "speed") spdSetPct(value);
  else if (key === "supports") slSetSupports(value);
  else if (kind === "quick") {
    const el = $("s-" + key);
    if (el.type === "checkbox") el.checked = value;
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    slTouch("s-" + key);
    slSummary();
  } else advSet(key, value);
}

/* Where a change shows on the sheet: its control, or the button of the
   advanced panel holding it. */
function snappySliceSpot(key) {
  const at = { machine: "s-nozzles", process: "s-layer-chips", bed: "s-beds" }[key];
  if (at) return $(at);
  if (key in SNAPPY_QUICK) return $("s-" + key).closest(".sl-tile, .grow-row, .row, label") || $("s-" + key);
  const cat = Object.keys(ADV_CATS).find((c) => advCatKeysAll(c).includes(key));
  return cat ? document.querySelector(`#smodal [data-adv="${cat}"]`) : null;
}

function snappyHighlight(keys) {
  for (const el of new Set(keys.map(snappySliceSpot).filter(Boolean))) {
    el.classList.remove("snappy-hl");
    void el.offsetWidth;
    el.classList.add("snappy-hl");
    setTimeout(() => el.classList.remove("snappy-hl"), 2400);
  }
}

/* The approved changes, applied in order and shown on the sheet; the
   conversation gets a line to undo them, back to the values before. */
async function snappySliceSet({ changes }) {
  const c = snappySliceChecked(changes);
  if (c.error) return { error: c.error };
  const o = c.options;
  const before = c.changes.map((ch) => ({
    ...ch,
    value: ch.kind === "profile" ? o[ch.key].value : ch.kind === "quick" ? o.quick[ch.key].value : o.advanced.find((a) => a.key === ch.key).value,
  }));
  for (const ch of c.changes) await snappySliceApply(ch);
  snappyHighlight(c.changes.map((ch) => ch.key));
  const note = snappyDiv("snappy-note");
  const undo = document.createElement("button");
  undo.className = "btn small";
  undo.textContent = tr("snappy.undo");
  undo.onclick = async () => {
    undo.disabled = true;
    if (!snappySheetOpen()) return;
    for (const ch of before) await snappySliceApply(ch);
    snappyHighlight(before.map((ch) => ch.key));
    note.textContent = tr("snappy.undone");
  };
  note.append(undo);
  snappyAdd(note);
  return { applied: c.lines };
}

/* A view of the app, as its sidebar item shows it. */
function snappyOpenView({ view }) {
  const item = document.querySelector(`.side-item[data-view="${CSS.escape(view || "")}"]`);
  if (!item) return { error: "Unknown view: " + view };
  item.click();
  return { shown: view };
}

/* The slice sheet for Prepare's plate, loaded. */
async function snappyOpenSliceSheet() {
  if (snappySheetOpen()) return { opened: true };
  if ((window.currentView || "files") !== "prepare") snappyOpenView({ view: "prepare" });
  if (!PR.objects.length) return { error: "Prepare's plate is empty: there is nothing to slice." };
  await openSlice();
  if (!snappySheetOpen()) return { error: "The slice sheet could not open." };
  if (engNeeded()) return { error: "The slicing engine is not installed: the sheet offers to download it." };
  return { opened: true };
}

/* Slices as the sheet's button does, and waits for the end: the preview,
   or the sheet's message. */
async function snappySliceRun() {
  if (!snappySheetOpen()) return { error: "The slice sheet is closed: open it with open_slice_sheet." };
  await startSlice();
  const job = SL.job;
  if (!job) return { error: $("s-msg").textContent || "The slice did not start." };
  while (SL.job === job) await new Promise((r) => setTimeout(r, 500));
  if (SL.preview?.job !== job) return { error: $("s-msg").textContent || "The slice did not finish." };
  return { sliced: true, estimates: snappySliceSummary({ stats: SL.preview.stats }).last_slice };
}

/* The slice of Prepare sent with Snappy's choices (confirmed on its card):
   the send sheet opens with them, checks the printer, then sends as by
   hand — its spool check and progress included. */
async function snappySendSlice({ printer, queue, options }) {
  if (!SL.preview) return { error: "There is no slice to send: slice in Prepare first." };
  await openSend();
  if ($("sendmodal").classList.contains("hidden")) return { error: "The send sheet could not open." };
  if (!SL.printers.some((p) => p.id === printer)) return { error: "Unknown printer." };
  SL.sendPid = printer;
  renderSendPrinters();
  await checkSendPrinter();
  $("snd-level").checked = !!options?.bed_leveling;
  $("snd-flow").checked = !!options?.flow_calibration;
  $("snd-timelapse").checked = !!options?.timelapse;
  // "Start now" was what the user approved: a busy or silent printer is
  // said, never turned into a queue add without asking.
  if (!queue && (SL.sendMode === "queue" || $("snd-go").disabled)) {
    return { error: ($("snd-state").textContent || "The printer cannot start this print now.") + " Nothing was sent; ask the user whether to add it to the queue instead." };
  }
  const r = (await sendPrint(!!queue)) || { error: "not sent" };
  if (r.cancelled) return { error: "The user cancelled the send in the app. Nothing was sent." };
  if (r.error) return { error: "Not sent: " + r.error };
  return { sent: true, queued: !!queue };
}

/* Prepare's plate as its 3D view shows it, for Snappy's eyes: drawn now and
   read at once (the view keeps no drawing buffer). */
function snappyPlateView() {
  if (typeof PR === "undefined" || !PR.gl) return { error: "Prepare is not open." };
  const objects = PR.objects.map((o) => o.name).filter(Boolean);
  if (!objects.length) return { error: "The plate is empty." };
  prDraw();
  const url = PR.gl.canvas.toDataURL("image/png");
  return { png: url.slice(url.indexOf(",") + 1), objects };
}

listen("snappy-ui", async (e) => {
  const { id, method, args } = e.payload;
  let result;
  try {
    if (method === "send_slice") result = await snappySendSlice(args || {});
    else if (method === "slice_summary") result = snappyPrepare();
    else if (method === "plate_view") result = snappyPlateView();
    else if (method === "local_files") result = snappyLocalFiles(state.view_files);
    else if (method === "local_file") result = snappyLocalFile(state.view_files, args?.name);
    else if (method === "slice_options") result = snappySliceOptions();
    else if (method === "slice_check") {
      const c = snappySliceChecked(args?.changes);
      result = c.error ? { error: c.error } : { lines: c.lines };
    }
    else if (method === "slice_set") result = await snappySliceSet(args || {});
    else if (method === "slice_run") result = await snappySliceRun();
    else if (method === "slice_stop") {
      // As the sheet's Stop.
      if (SL.job) {
        invoke("slice_cancel", { id: SL.job });
        result = { stopped: true };
      } else result = { error: "No slice is running." };
    }
    else if (method === "open_slice_sheet") result = await snappyOpenSliceSheet();
    else if (method === "open_view") result = snappyOpenView(args || {});
    else if (SNAPPY_ACTIONS[method]) result = await SNAPPY_ACTIONS[method](args || {});
    else result = { error: "unknown request: " + method };
  } catch (err) {
    result = { error: String(err?.message || err) };
  }
  invoke("snappy_ui_reply", { id, result }).catch(() => {});
});

/* ------------------------------------------------------------ Settings › AI */

/* Snappy's model: the account's default, or one of the chat's models
   (ia-chat.js CHAT_MODELS). */
async function snappyModelFill() {
  const sel = $("set-snappy-model");
  const current = await invoke("snappy_model").catch(() => null);
  sel.innerHTML = [["", tr("chat.model.default")], ...CHAT_MODELS].map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join("");
  sel.value = CHAT_MODELS.some(([m]) => m === current) ? current : "";
}

$("set-snappy-model").addEventListener("change", (e) => {
  const model = e.target.value || null;
  invoke("snappy_set_model", { model })
    .then(() => toast(tr("chat.model.changed", { model: model ? chatModelName(model) : tr("chat.model.default") })))
    .catch((err) => toast(String(err), true));
});

snappyModelFill();
window.addEventListener("langchange", snappyModelFill);

/* Snappy's conversation in Settings › AI: how full its context is, and a
   new conversation (the current one deleted, the memory kept). */
async function snappyUsageFill() {
  const u = await invoke("snappy_usage").catch(() => null);
  if (!u) return;
  const pct = Math.round(u.percent);
  const meter = $("snappy-meter");
  meter.querySelector("i").style.width = Math.max(u.used ? 1 : 0, u.percent) + "%";
  meter.classList.toggle("mid", u.percent >= 60 && u.percent < 85);
  meter.classList.toggle("high", u.percent >= 85);
  meter.setAttribute("aria-valuenow", String(pct));
  const k = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + " M" : n >= 1000 ? Math.round(n / 1000) + " k" : String(n));
  $("snappy-meter-text").textContent = tr("settings.snappy.context_use", { pct, used: k(u.used), window: k(u.window) });
}

$("snappy-reset").addEventListener("click", async () => {
  const ok = await confirmDelete(tr("settings.snappy.reset_title"), tr("settings.snappy.reset_text"), tr("settings.snappy.reset_ok"));
  if (!ok) return;
  try {
    await invoke("snappy_reset");
    toast(tr("settings.snappy.reset_done"));
  } catch (e) {
    toast(String(e), true);
  }
  snappyUsageFill();
});

/* Kept current: after each answer, and while Settings shows it. */
listen("snappy-chat", (e) => {
  if ((e.payload.events || []).some((ev) => ev.type === "result")) snappyUsageFill();
});
setInterval(() => {
  if ($("snappy-meter").offsetParent) snappyUsageFill();
}, 5000);
snappyUsageFill();
window.addEventListener("langchange", snappyUsageFill);

/* Settings › AI › Snappy: its switch. Off, the icon and the card go, its
   Claude stops; its memory and conversation stay. */
function snappyEnabledShow(on) {
  SNAP.enabled = on;
  if (!on) snappyClose();
  snappyLock();
  snappyFabState();
}

/* Snappy needs the AI: with the AI off ("Do not use the AI"), its switch
   is locked, shown off, and says why; its own setting stays for when the
   AI comes back. */
function snappyLock() {
  const noAi = typeof aiChoice === "function" && aiChoice() === "off";
  const sw = $("set-snappy-on");
  sw.disabled = noAi;
  sw.checked = SNAP.enabled && !noAi;
  // Its other rows (model, conversation) go with it.
  $("set-snappy").classList.toggle("off", !sw.checked);
  const sub = $("set-snappy-sub");
  sub.dataset.i18n = noAi ? "snappy.intro.needs_ai" : "settings.snappy.on.sub";
  sub.textContent = tr(sub.dataset.i18n);
}
window.addEventListener("aichange", snappyLock);
/* Snappy on or off, as its switch does (Settings, the welcome assistant,
   the first-launch notice). */
function snappySetEnabled(on) {
  snappyEnabledShow(on);
  invoke("snappy_set_enabled", { on }).catch((err) => toast(String(err), true));
}
$("set-snappy-on").addEventListener("change", (e) => snappySetEnabled(e.target.checked));

/* ------------------------------------------------------------ introducing it */

/* Introduced once, by the welcome assistant or, for a user who had the app
   before Snappy, by the first-launch notice (intros.js). */
const SNAPPY_INTRO_KEY = "snapstudio.snappy.intro";
const snappyIntroduced = () => !!localStorage.getItem(SNAPPY_INTRO_KEY);
const snappyIntroDone = () => localStorage.setItem(SNAPPY_INTRO_KEY, "1");

/* Snappy introduced, as a step of the welcome assistant's (its badge,
   title, lead, what it does, and its switch): one build for the assistant
   and the first-launch notice. `kicker` puts "New" above the title. */
const SNAPPY_INTRO_ICONS = {
  ask: '<svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2m2 4v2h12V8zm0 4v2h8v-2z"/></svg>',
  act: '<svg viewBox="0 0 24 24"><path d="M7.5 5.6 10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.6 5.3a1 1 0 0 0-1.4 0L1.3 18.9a1 1 0 0 0 0 1.4l2.3 2.3a1 1 0 0 0 1.4 0l11.7-11.6a1 1 0 0 0 0-1.4zm-1.1 5.5-2.1-2.1 2.4-2.5 2.1 2.1z"/></svg>',
  asks: '<svg viewBox="0 0 24 24"><path d="M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5zm-2 16-4-4 1.4-1.4 2.6 2.6 6.6-6.6L18 9z"/></svg>',
  privacy: '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2m-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4m3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0z"/></svg>',
};

function snappyIntroBuild(host, { kicker = false, titleId = "" } = {}) {
  let badge = host.querySelector(".snappy-intro-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "w-badge snappy-intro-badge";
    badge.innerHTML = '<span class="snappy-av"></span>';
    snappyAvatar(badge.firstChild);
  }
  const prev = host.querySelector("[data-snappy-on]");
  const was = prev && { on: prev.checked, locked: prev.disabled };
  host.innerHTML = `
    ${kicker ? `<span class="snappy-kicker">${esc(tr("snappy.intro.kicker"))}</span>` : ""}
    <h1${titleId ? ` id="${titleId}"` : ""}>${esc(tr("snappy.intro.title"))}</h1>
    <p class="w-lead">${esc(tr("snappy.intro.lead"))}</p>
    <ul class="w-features">${["ask", "act", "asks", "privacy"].map((k) => `<li>${SNAPPY_INTRO_ICONS[k]}<span>${esc(tr("snappy.intro." + k))}</span></li>`).join("")}</ul>
    <label class="grow-row w-switch">
      <span class="k">${esc(tr("settings.snappy.on"))}<small data-snappy-needs class="hidden">${esc(tr("snappy.intro.needs_ai"))}</small></span>
      <input type="checkbox" class="sw" role="switch" data-snappy-on />
    </label>`;
  host.prepend(badge);
  if (was) snappyIntroSet(host, was.on, was.locked);
}

/* The switch shown: `on`, and greyed out without the AI (which it needs),
   saying so. */
function snappyIntroSet(host, on, noAi) {
  const sw = host.querySelector("[data-snappy-on]");
  sw.checked = on;
  sw.disabled = noAi;
  host.querySelector("[data-snappy-needs]").classList.toggle("hidden", !noAi);
}

invoke("snappy_enabled").then((on) => snappyEnabledShow(on !== false)).catch(() => {});

/* Settings › AI › Snappy › Memory: MEMORY.md, to read, edit or clear. Its
   limits are Snappy's (about 200 lines, 24 KB); what is saved is filtered
   as anything sent to the model. */
const SNAP_MEM_LINES = 200;
const SNAP_MEM_BYTES = 24 * 1024;

function snappyMemCount() {
  const t = $("snappymem-text").value;
  const lines = t ? t.split("\n").length : 0;
  const kb = new TextEncoder().encode(t).length;
  const over = lines > SNAP_MEM_LINES || kb > SNAP_MEM_BYTES;
  const el = $("snappymem-count");
  el.textContent = tr("settings.snappy.memory_count", { lines, max: SNAP_MEM_LINES, kb: (kb / 1024).toFixed(1), maxkb: SNAP_MEM_BYTES / 1024 });
  el.className = "pf-test" + (over ? " err" : "");
  $("snappymem-save").disabled = over;
}

async function snappyMemSub() {
  const t = await invoke("snappy_memory").catch(() => "");
  const lines = t.trim() ? t.trim().split("\n").length : 0;
  $("snappy-mem-sub").textContent = lines ? tr("settings.snappy.memory_lines", { n: lines }) : tr("settings.snappy.memory_empty");
}

$("snappy-mem-open").addEventListener("click", async () => {
  $("snappymem-text").value = await invoke("snappy_memory").catch(() => "");
  snappyMemCount();
  openSheet($("snappymem"));
});
$("snappymem-text").addEventListener("input", snappyMemCount);
$("snappymem-cancel").addEventListener("click", () => closeSheet($("snappymem")));
$("snappymem-save").addEventListener("click", async () => {
  try {
    await invoke("snappy_memory_set", { content: $("snappymem-text").value });
    closeSheet($("snappymem"));
    toast(tr("settings.snappy.memory_saved"));
  } catch (e) {
    toast(String(e), true);
  }
  snappyMemSub();
});
$("snappymem-clear").addEventListener("click", async () => {
  const ok = await confirmDelete(tr("settings.snappy.memory_clear_title"), tr("settings.snappy.memory_clear_text"), tr("settings.snappy.memory_clear"));
  if (!ok) return;
  try {
    await invoke("snappy_memory_clear");
    closeSheet($("snappymem"));
    toast(tr("settings.snappy.memory_cleared"));
  } catch (e) {
    toast(String(e), true);
  }
  snappyMemSub();
});
snappyMemSub();
window.addEventListener("langchange", snappyMemSub);
listen("snappy-chat", (e) => {
  if ((e.payload.events || []).some((ev) => ev.type === "result")) snappyMemSub();
});
