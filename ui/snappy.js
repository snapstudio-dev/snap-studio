"use strict";
/* Snappy, the workshop assistant (src-tauri/src/snappy.rs).

   A nameless icon at the bottom-left of the content, beside the sidebar,
   always there — faded while something else sits at its place, whole
   again under the pointer (and while the conversation is open); its avatar
   is alive (snappy-avatar.js). A click opens the conversation, a card
   floating above it over the current view, which stays where it is; the
   icon or a click outside the card closes it. A corner button doubles the
   card's width, or brings it back.

   One conversation, kept by the app: its past from the log, its events as
   the "snappy-chat" event. Actions that cannot be undone come as cards at
   the bottom of the drawer: only an explicit yes lets them through, and
   closing the drawer refuses them. The app answers Snappy's questions
   about what only the page holds (Prepare's state, the Files view) through
   "snappy-ui". */

const SNAP = {
  open: false,
  busy: false,
  loaded: false,
  /* tool_use id → its row. */
  tools: new Map(),
  /* approval id → its card. */
  cards: new Map(),
};

const snapList = $("snappy-list");

/* Snappy needs the AI: hidden when the AI is off in Settings. */
const snappyAvailable = () => typeof aiChoice !== "function" || aiChoice() !== "off";

/* ------------------------------------------------------------ the icon */

const SNAP_AV = [snappyAvatar($("snappy-fab-av"))];
const snappyMood = (mood) => SNAP_AV.forEach((a) => a.setMood(mood));

/* Whether something else sits at the icon's place: over it (a sheet, a
   menu), or under it — anything smaller than half the content (a list, a
   card, a button); the view's own background (a page, the 3D view) does
   not count. */
function snappyCovered(fab) {
  const r = fab.getBoundingClientRect();
  if (!r.width) return false;
  const c = $("content").getBoundingClientRect();
  const big = c.width * c.height * 0.5;
  for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
    const list = document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    const at = list.findIndex((el) => fab.contains(el));
    if (at !== 0) return true;
    for (const el of list.slice(1)) {
      if (fab.contains(el)) continue;
      if (el === document.body || el === document.documentElement) break;
      if (getComputedStyle(el).opacity === "0") continue;
      const b = el.getBoundingClientRect();
      if (b.width * b.height < big) return true;
    }
  }
  return false;
}

/* Shown unless the AI is off; faded when covered, never while its
   conversation is open (the card sits above it, it speaks). */
function snappyFabState() {
  const fab = $("snappy-fab");
  const hide = !snappyAvailable();
  fab.classList.toggle("hidden", hide);
  if (!hide) fab.classList.toggle("dim", !SNAP.open && snappyCovered(fab));
}
setInterval(snappyFabState, 500);
window.addEventListener("resize", snappyFabState);
snappyFabState();

/* The icon opens the conversation, and closes it. */
$("snappy-fab").addEventListener("click", () => (SNAP.open ? snappyClose() : snappyOpen()));

/* Twice as wide, or back: kept for the next openings. */
function snappyWide(on) {
  $("snappy").classList.toggle("wide", on);
  $("snappy-wide").title = tr(on ? "snappy.narrower" : "snappy.wider");
  localStorage.setItem("snapstudio.snappy.wide", on ? "1" : "");
}
$("snappy-wide").addEventListener("click", () => snappyWide(!$("snappy").classList.contains("wide")));
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

/* ------------------------------------------------------------ the drawer */

function snappyOpen() {
  if (SNAP.open) return;
  SNAP.open = true;
  $("snappy-fab").classList.remove("dim");
  const d = $("snappy");
  d.classList.remove("hidden");
  requestAnimationFrame(() => d.classList.add("in"));
  invoke("snappy_drawer", { open: true }).catch(() => {});
  if (!SNAP.loaded) snappyLoad();
  requestAnimationFrame(() => $("snappy-input").focus());
}

function snappyClose() {
  if (!SNAP.open) return;
  SNAP.open = false;
  const d = $("snappy");
  d.classList.remove("in");
  setTimeout(() => {
    if (!SNAP.open) d.classList.add("hidden");
  }, 160);
  // Closed, whatever waited for a yes is refused (snappy_tools.rs).
  invoke("snappy_drawer", { open: false }).catch(() => {});
  for (const id of [...SNAP.cards.keys()]) snappyCardDone(id, false);
  snappyFabState();
}

$("snappy-close").addEventListener("click", snappyClose);

async function snappyLoad() {
  SNAP.loaded = true;
  let past = [];
  try {
    past = (await invoke("snappy_history")) || [];
  } catch {}
  snapList.innerHTML = "";
  SNAP.tools.clear();
  for (const ev of past) for (const item of snappyItems(ev)) snappyShow(item, false);
  if (!snapList.children.length) snapList.appendChild(snappyDiv("snappy-empty", tr("snappy.empty")));
  snappySetBusy(await invoke("snappy_busy").catch(() => false));
  snapList.scrollTop = snapList.scrollHeight;
}

/* ------------------------------------------------------------ rendering */

function snappyDiv(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function snappyAdd(el) {
  snapList.querySelector(".snappy-empty")?.remove();
  const stick = snapList.scrollHeight - snapList.scrollTop - snapList.clientHeight < 80;
  snapList.appendChild(el);
  // The working dots stay last.
  const w = snapList.querySelector(".chat-working");
  if (w && w !== el) snapList.appendChild(w);
  if (stick) snapList.scrollTop = snapList.scrollHeight;
}

/* A tool's label: its own words when the catalog has them. */
function snappyToolLabel(name) {
  const key = "snappy.tool." + name;
  const t = tr(key);
  return t === key ? name : t;
}

/* One item of the conversation (snappy-logic.js). `live`: it just happened. */
function snappyShow(item, live) {
  switch (item.kind) {
    case "user":
      snappyAdd(snappyDiv("snappy-msg user", item.text));
      break;
    case "assistant": {
      const d = snappyDiv("snappy-msg assistant");
      d.innerHTML = chatMd(item.text);
      snappyAdd(d);
      break;
    }
    case "tool": {
      const row = snappyDiv("snappy-tool");
      row.append(snappyDiv("dot"), snappyDiv("name", snappyToolLabel(item.name)));
      SNAP.tools.set(item.id, row);
      snappyAdd(row);
      break;
    }
    case "tool_done": {
      const row = SNAP.tools.get(item.id);
      if (row) row.classList.add(item.error ? "error" : "done");
      break;
    }
    case "end":
      if (item.stopped) snappyAdd(snappyDiv("snappy-note", tr("snappy.stopped")));
      else if (item.error) snappyAdd(snappyDiv("snappy-note error", item.error));
      if (live) {
        snappySetBusy(false);
        // No hop for an answer that did not come.
        if (item.stopped || item.error) snappyMood("idle");
      }
      break;
    case "exited":
      if (live) snappySetBusy(false);
      break;
    case "auth":
      if (live) {
        const note = snappyDiv("snappy-note error", tr("chat.auth_failed"));
        const b = document.createElement("button");
        b.className = "btn small";
        b.textContent = tr("chat.auth_fix");
        b.onclick = () => authOpen({ engine: "local" });
        note.appendChild(b);
        snappyAdd(note);
      }
      break;
  }
}

function snappySetBusy(on) {
  // Thinking while it answers; a happy hop when an answer lands.
  if (on) snappyMood("thinking");
  else if (SNAP.busy) snappyMood("happy");
  else snappyMood("idle");
  SNAP.busy = !!on;
  $("snappy-send").classList.toggle("hidden", SNAP.busy);
  $("snappy-stop").classList.toggle("hidden", !SNAP.busy);
  snapList.querySelector(".chat-working")?.remove();
  if (SNAP.busy) snappyAdd(chatWorking());
  snappyGrow();
}

listen("snappy-chat", (e) => {
  if (!SNAP.loaded) return;
  for (const ev of e.payload.events || []) for (const item of snappyItems(ev)) snappyShow(item, true);
});

/* ------------------------------------------------------------ sending */

/* What Snappy is told about the app with each message: the view, the
   printer chosen, what Prepare holds — names only (the backend filters
   again). */
function snappyContext() {
  const view = window.currentView || "files";
  const ctx = { view, language: LANG };
  const printer = typeof SL !== "undefined" ? SL.printers.find((p) => p.id === ($("s-printer")?.value || SL.memory.printer)) : null;
  if (printer) ctx.printer = printer.name;
  if (view === "prepare" && typeof PR !== "undefined") ctx.prepare_objects = PR.objects.map((o) => o.name).filter(Boolean).slice(0, 30);
  return ctx;
}

async function snappySubmit() {
  const input = $("snappy-input");
  const text = input.value.trim();
  if (!text || SNAP.busy) return;
  input.value = "";
  snappyShow({ kind: "user", text }, true);
  snappySetBusy(true);
  try {
    await invoke("snappy_send", { text, context: snappyContext() });
  } catch (e) {
    snappySetBusy(false);
    snappyAdd(snappyDiv("snappy-note error", String(e)));
  }
}

function snappyGrow() {
  const input = $("snappy-input");
  if (!input.value) input.style.height = "";
  else {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  $("snappy-send").disabled = !input.value.trim();
}

$("snappy-input").addEventListener("input", snappyGrow);
$("snappy-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    snappySubmit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (SNAP.busy) invoke("snappy_stop").catch(() => {});
    else snappyClose();
  }
});
$("snappy-send").addEventListener("click", snappySubmit);
$("snappy-stop").addEventListener("click", () => invoke("snappy_stop").catch((e) => toast(String(e), true)));

/* Links open in the browser, never in the app's window. */
snapList.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a?.href) return;
  e.preventDefault();
  invoke("plugin:opener|open_url", { url: a.href }).catch((err) => toast(String(err), true));
});

/* ------------------------------------------------------------ approvals */

listen("snappy-approval", (e) => {
  const { id, text } = e.payload;
  const card = snappyDiv("snappy-card");
  card.append(snappyDiv("title", tr("snappy.approve.title")), snappyDiv("what", text));
  const row = snappyDiv("row");
  const yes = document.createElement("button");
  yes.className = "btn small primary";
  yes.textContent = tr("snappy.approve.allow");
  yes.onclick = () => snappyAnswer(id, true);
  const no = document.createElement("button");
  no.className = "btn small";
  no.textContent = tr("snappy.approve.refuse");
  no.onclick = () => snappyAnswer(id, false);
  row.append(yes, no);
  card.appendChild(row);
  SNAP.cards.set(id, card);
  $("snappy-cards").appendChild(card);
});

function snappyAnswer(id, yes) {
  invoke("snappy_approve", { id, yes }).catch(() => {});
  snappyCardDone(id, yes);
}

/* A card answered, refused or expired: it leaves, its outcome stays as a
   line of the conversation. */
function snappyCardDone(id, yes) {
  const card = SNAP.cards.get(id);
  if (!card) return;
  SNAP.cards.delete(id);
  card.remove();
  snappyAdd(snappyDiv("snappy-note", tr(yes ? "snappy.approved" : "snappy.refused", { what: card.querySelector(".what")?.textContent || "" })));
}

listen("snappy-approval-done", (e) => snappyCardDone(e.payload.id, e.payload.approved));

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

/* A quick setting for the next slices, as if changed by hand on the sheet. */
function snappyApply({ setting, value }) {
  if (setting === "supports") {
    slSetSupports(!!value);
    return { applied: true, setting, value: !!value };
  }
  const machine = $("s-machine").value || SL.memory.last;
  if (!machine) return { error: "Prepare has no printer preset yet: open the slice sheet once." };
  remember(machine, { simple: snappySimpleWith(rememberFor(machine).simple, setting, value) });
  slTouch("s-" + setting);
  if (!$("smodal").classList.contains("hidden")) {
    const el = $("s-" + setting);
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { applied: true, setting, value };
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

listen("snappy-ui", async (e) => {
  const { id, method, args } = e.payload;
  let result;
  try {
    if (method === "send_slice") result = await snappySendSlice(args || {});
    else if (method === "slice_summary") result = snappyPrepare();
    else if (method === "local_files") result = snappyLocalFiles(state.view_files);
    else if (method === "local_file") result = snappyLocalFile(state.view_files, args?.name);
    else if (method === "apply_setting") result = snappyApply(args || {});
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

/* A new conversation: the card starts empty. */
listen("snappy-reset", () => {
  SNAP.loaded = false;
  SNAP.tools.clear();
  snapList.innerHTML = "";
  for (const id of [...SNAP.cards.keys()]) snappyCardDone(id, false);
  snappySetBusy(false);
  snappyMood("idle");
  if (SNAP.open) snappyLoad();
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
