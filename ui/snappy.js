"use strict";
/* Snappy, the workshop assistant (src-tauri/src/snappy.rs).

   A nameless icon at the bottom-left of the content, beside the sidebar,
   shown while the content is hovered; a click fades it out and opens the
   conversation's drawer over the current view, which stays where it is.
   Closing the drawer brings the icon back on hover.

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

$("content").addEventListener("mouseenter", () => {
  $("snappy-fab").classList.toggle("hidden", SNAP.open || !snappyAvailable());
});

$("snappy-fab").addEventListener("click", snappyOpen);

/* ------------------------------------------------------------ the drawer */

function snappyOpen() {
  if (SNAP.open) return;
  SNAP.open = true;
  const fab = $("snappy-fab");
  fab.classList.add("leaving");
  setTimeout(() => {
    fab.classList.add("hidden");
    fab.classList.remove("leaving");
  }, 160);
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
  // Back on hover; the pointer may already be over the content.
  if ($("content").matches(":hover") && snappyAvailable()) $("snappy-fab").classList.remove("hidden");
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
      if (live) snappySetBusy(false);
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
  const asQueue = !!queue || SL.sendMode === "queue";
  if (!asQueue && $("snd-go").disabled) return { error: $("snd-state").textContent || "The printer cannot start this print." };
  sendPrint(asQueue);
  return { started: true, queued: asQueue, note: asQueue && !queue ? "The printer is busy or silent: the print was added to its queue." : undefined };
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
