"use strict";
/* Snappy's conversation card: its markup, the conversation drawn from its
   log and its live events, the approval cards, the input. Shared by the
   app (snappy.js: the card beside the sidebar or beside a sheet) and by the
   view laid over a site (snappy-view.js), whose page holds nothing else.
   What differs between the two goes through SNAP_PAGE: what a message
   carries, closing, widening, the avatar's mood, signing in.

   One conversation, kept by the app: its past from the log, its events as
   the "snappy-chat" event. Actions that change the workshop come as cards
   at the bottom: only an explicit yes lets them through, and closing the
   card refuses them. */

const SNAP = {
  open: false,
  busy: false,
  loaded: false,
  /* tool_use id → its row. */
  tools: new Map(),
  /* approval id → its card. */
  cards: new Map(),
};

/* Set by the page. `context()`: what Snappy is told about the app with each
   message. */
const SNAP_PAGE = {
  context: () => ({}),
  close() {},
  wide() {},
  mood() {},
  auth() {},
};

/* The card's markup, under `host` (a section.snappy-drawer). */
function snappyCardBuild(host) {
  host.innerHTML = `
  <div class="snappy-corner">
    <button id="snappy-wide" class="snappy-x" type="button" data-i18n-title="snappy.wider">
      <svg class="widen" viewBox="0 0 24 24"><path d="M3 12l4-4v3h4v2H7v3zm18 0-4 4v-3h-4v-2h4V8z"/></svg>
      <svg class="narrow" viewBox="0 0 24 24"><path d="M11 12l-4 4v-3H3v-2h4V8zm2 0 4-4v3h4v2h-4v3z"/></svg>
    </button>
    <button id="snappy-close" class="snappy-x" type="button" data-i18n-title="common.close">
      <svg viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>
    </button>
  </div>
  <div id="snappy-list" class="snappy-list"></div>
  <div id="snappy-cards" class="snappy-cards"></div>
  <div class="snappy-foot">
    <textarea id="snappy-input" rows="1" data-i18n-placeholder="snappy.placeholder"></textarea>
    <button id="snappy-send" class="snappy-send" type="button" data-i18n-title="chat.send" disabled>
      <svg viewBox="0 0 24 24"><path d="M12 4 5 11l1.4 1.4L11 7.8V20h2V7.8l4.6 4.6L19 11z"/></svg>
    </button>
    <button id="snappy-stop" class="snappy-send stop hidden" type="button" data-i18n-title="snappy.stop">
      <svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>
    </button>
  </div>`;
  applyI18n(host);
}

snappyCardBuild($("snappy"));
window.addEventListener("langchange", () => applyI18n($("snappy")));

const snapList = $("snappy-list");

$("snappy-close").addEventListener("click", () => SNAP_PAGE.close());
$("snappy-wide").addEventListener("click", () => SNAP_PAGE.wide());

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
        if (item.stopped || item.error) SNAP_PAGE.mood("idle");
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
        b.onclick = () => SNAP_PAGE.auth();
        note.appendChild(b);
        snappyAdd(note);
      }
      break;
  }
}

function snappySetBusy(on) {
  // Thinking while it answers; a happy hop when an answer lands.
  if (on) SNAP_PAGE.mood("thinking");
  else if (SNAP.busy) SNAP_PAGE.mood("happy");
  else SNAP_PAGE.mood("idle");
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

/* A new conversation: the card starts empty. */
listen("snappy-reset", () => {
  SNAP.loaded = false;
  SNAP.tools.clear();
  snapList.innerHTML = "";
  for (const id of [...SNAP.cards.keys()]) snappyCardDone(id, false);
  snappySetBusy(false);
  SNAP_PAGE.mood("idle");
  if (SNAP.open) snappyLoad();
});

/* ------------------------------------------------------------ sending */

async function snappySubmit() {
  const input = $("snappy-input");
  const text = input.value.trim();
  if (!text || SNAP.busy) return;
  input.value = "";
  snappyShow({ kind: "user", text }, true);
  snappySetBusy(true);
  try {
    await invoke("snappy_send", { text, context: SNAP_PAGE.context() });
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

const snappyStop = () => invoke("snappy_stop").catch((e) => snappyAdd(snappyDiv("snappy-note error", String(e))));

$("snappy-input").addEventListener("input", snappyGrow);
$("snappy-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    snappySubmit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (SNAP.busy) snappyStop();
    else SNAP_PAGE.close();
  }
});
$("snappy-send").addEventListener("click", snappySubmit);
$("snappy-stop").addEventListener("click", snappyStop);

/* Links open in the browser, never in the app's window. */
snapList.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a?.href) return;
  e.preventDefault();
  invoke("plugin:opener|open_url", { url: a.href }).catch((err) => snappyAdd(snappyDiv("snappy-note error", String(err))));
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
  if (card.classList.contains("question")) return snappyQuestionDone(id, null);
  SNAP.cards.delete(id);
  card.remove();
  snappyAdd(snappyDiv("snappy-note", tr(yes ? "snappy.approved" : "snappy.refused", { what: card.querySelector(".what")?.textContent || "" })));
}

listen("snappy-approval-done", (e) => snappyCardDone(e.payload.id, e.payload.approved));

/* ------------------------------------------------------------ questions */

/* Snappy asks (its ask_user tool): the question with its answers as
   buttons, a field for another answer, and Skip. The answer goes back to
   Snappy; it stays as a line of the conversation. */
listen("snappy-question", (e) => {
  const { id, question, options } = e.payload;
  const card = snappyDiv("snappy-card question");
  card.append(snappyDiv("what", question));
  const reply = (answer) => {
    invoke("snappy_reply", { id, answer }).catch(() => {});
    snappyQuestionDone(id, answer);
  };
  const row = snappyDiv("row wrap");
  for (const o of options || []) {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = o;
    b.onclick = () => reply(o);
    row.appendChild(b);
  }
  const free = snappyDiv("row");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = tr("snappy.question.other");
  input.addEventListener("keydown", (k) => {
    if (k.key === "Enter" && input.value.trim()) reply(input.value.trim());
  });
  const skip = document.createElement("button");
  skip.className = "btn small";
  skip.textContent = tr("snappy.question.skip");
  skip.onclick = () => reply(null);
  free.append(input, skip);
  card.append(row, free);
  SNAP.cards.set(id, card);
  $("snappy-cards").appendChild(card);
  (options?.length ? row.firstElementChild : input)?.focus();
});

function snappyQuestionDone(id, answer) {
  const card = SNAP.cards.get(id);
  if (!card) return;
  SNAP.cards.delete(id);
  card.remove();
  snappyAdd(snappyDiv("snappy-note", answer ? tr("snappy.answered", { what: answer }) : tr("snappy.unanswered")));
}

listen("snappy-question-done", (e) => snappyQuestionDone(e.payload.id, e.payload.answer));
