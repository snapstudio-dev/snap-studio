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
    <button id="snappy-new" class="snappy-x" type="button" data-i18n-title="snappy.new">
      <svg viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 0 6.9 8.2h-2.1A5 5 0 1 1 12 7c1.4 0 2.6.6 3.5 1.5L13 11h7V4l-2.6 2.6A7 7 0 0 0 12 5z"/></svg>
    </button>
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
  <div id="snappy-attach" class="snappy-attach hidden"></div>
  <div class="snappy-foot">
    <button id="snappy-add" class="snappy-x snappy-add" type="button" data-i18n-title="snappy.attach">
      <svg viewBox="0 0 24 24"><path d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5H9v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10z"/></svg>
    </button>
    <input id="snappy-file" type="file" multiple hidden />
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

/* A new conversation, after a confirmation: the current one is deleted,
   Snappy keeps only its memory (as in Settings › AI › Snappy). */
$("snappy-new").addEventListener("click", async () => {
  const ok = await window.__TAURI__.dialog.ask(tr("settings.snappy.reset_text"), {
    title: tr("settings.snappy.reset_title"),
    kind: "warning",
    okLabel: tr("settings.snappy.reset_ok"),
    cancelLabel: tr("common.cancel"),
  });
  if (!ok) return;
  invoke("snappy_reset").catch((e) => snappyAdd(snappyDiv("snappy-note error", String(e))));
});
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
  if (!snapList.children.length) snapList.appendChild(snappyWords(snappyDiv("snappy-empty"), "snappy.empty"));
  snappySetBusy(await invoke("snappy_busy").catch(() => false));
  snapList.scrollTop = snapList.scrollHeight;
  // Cards and questions still waiting (a view drawn again, over a site).
  for (const w of (await invoke("snappy_waiting").catch(() => [])) || []) {
    if (SNAP.cards.has(w.id)) continue;
    if (w.kind === "approval") snappyApprovalCard(w);
    else if (w.kind === "question") snappyQuestionCard(w);
  }
}

/* ------------------------------------------------------------ rendering */

function snappyDiv(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

/* The card's own words (not the conversation's): bound to their key, so a
   language change reaches them while they show (applyI18n on langchange). */
function snappyWords(el, key, attr = "") {
  el.dataset["i18n" + attr] = key;
  if (attr === "Placeholder") el.placeholder = tr(key);
  else el.textContent = tr(key);
  return el;
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
    case "user": {
      const d = snappyDiv("snappy-msg user");
      if (item.images?.length || item.urls?.length) {
        const row = snappyDiv("snappy-images");
        for (const src of item.urls || []) row.appendChild(snappyImg(src));
        for (const name of item.images || []) {
          const img = snappyImg("");
          invoke("snappy_attachment", { name }).then((u) => (img.src = u)).catch(() => img.remove());
          row.appendChild(img);
        }
        d.appendChild(row);
      }
      if (item.text) d.appendChild(document.createTextNode(item.text));
      snappyAdd(d);
      break;
    }
    case "note":
      snappyAdd(snappyDiv("snappy-note", tr(item.key)));
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

function snappyImg(src) {
  const img = document.createElement("img");
  img.alt = "";
  if (src) img.src = src;
  img.onerror = () => img.remove();
  return img;
}

/* ------------------------------------------------------------ attachments */

/* Images waiting to leave with the next message: { name, media_type, data, url }. */
SNAP.attach = [];
const SNAP_MAX_IMAGES = 4;
/* Longest side sent: the model scales larger images down anyway. */
const SNAP_MAX_SIDE = 1568;

/* An image file read and scaled, as a JPEG. */
function snappyReadImage(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, SNAP_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL("image/jpeg", 0.88);
      ok({ name: (file.name || "image").replace(/\.[^.]+$/, "") + ".jpg", media_type: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), url: dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      ko(new Error(tr("chat.bad_image", { name: file.name || "?" })));
    };
    img.src = url;
  });
}

async function snappyAddFiles(files) {
  for (const f of [...files].filter((f) => f.type.startsWith("image/"))) {
    if (SNAP.attach.length >= SNAP_MAX_IMAGES) {
      snappyAdd(snappyDiv("snappy-note error", tr("chat.too_many", { n: SNAP_MAX_IMAGES })));
      break;
    }
    try {
      SNAP.attach.push(await snappyReadImage(f));
    } catch (e) {
      snappyAdd(snappyDiv("snappy-note error", e.message));
    }
  }
  snappyAttachShow();
}

function snappyAttachShow() {
  const box = $("snappy-attach");
  box.innerHTML = "";
  SNAP.attach.forEach((a, i) => {
    const t = snappyDiv("snappy-thumb");
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.title = tr("common.delete");
    x.onclick = () => {
      SNAP.attach.splice(i, 1);
      snappyAttachShow();
    };
    t.append(snappyImg(a.url), x);
    box.appendChild(t);
  });
  box.classList.toggle("hidden", !SNAP.attach.length);
  snappyGrow();
}

// Images only (written so, a slash and a star would read as a comment).
$("snappy-file").accept = "image/" + "*";
$("snappy-add").addEventListener("click", () => $("snappy-file").click());
$("snappy-file").addEventListener("change", (e) => {
  snappyAddFiles(e.target.files);
  e.target.value = "";
});
$("snappy-input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  snappyAddFiles(files);
});
$("snappy").addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith("image/"))) e.preventDefault();
});
$("snappy").addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  snappyAddFiles(files);
});

async function snappySubmit() {
  const input = $("snappy-input");
  const text = input.value.trim();
  const images = SNAP.attach;
  if ((!text && !images.length) || SNAP.busy) return;
  input.value = "";
  SNAP.attach = [];
  snappyAttachShow();
  snappyShow({ kind: "user", text, urls: images.map((a) => a.url) }, true);
  snappySetBusy(true);
  try {
    await invoke("snappy_send", { text, context: SNAP_PAGE.context(), images: images.map(({ name, media_type, data }) => ({ name, media_type, data })) });
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
  $("snappy-send").disabled = !input.value.trim() && !SNAP.attach?.length;
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

listen("snappy-approval", (e) => snappyApprovalCard(e.payload));

function snappyApprovalCard({ id, text }) {
  if (SNAP.cards.has(id)) return;
  const card = snappyDiv("snappy-card");
  card.append(snappyWords(snappyDiv("title"), "snappy.approve.title"), snappyDiv("what", text));
  const row = snappyDiv("row");
  const yes = document.createElement("button");
  yes.className = "btn small primary";
  snappyWords(yes, "snappy.approve.allow");
  yes.onclick = () => snappyAnswer(id, true);
  const no = document.createElement("button");
  no.className = "btn small";
  snappyWords(no, "snappy.approve.refuse");
  no.onclick = () => snappyAnswer(id, false);
  row.append(yes, no);
  card.appendChild(row);
  SNAP.cards.set(id, card);
  $("snappy-cards").appendChild(card);
}

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
listen("snappy-question", (e) => snappyQuestionCard(e.payload));

function snappyQuestionCard({ id, question, options }) {
  if (SNAP.cards.has(id)) return;
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
  snappyWords(input, "snappy.question.other", "Placeholder");
  input.addEventListener("keydown", (k) => {
    if (k.key === "Enter" && input.value.trim()) reply(input.value.trim());
  });
  const skip = document.createElement("button");
  skip.className = "btn small";
  snappyWords(skip, "snappy.question.skip");
  skip.onclick = () => reply(null);
  free.append(input, skip);
  card.append(row, free);
  SNAP.cards.set(id, card);
  $("snappy-cards").appendChild(card);
  (options?.length ? row.firstElementChild : input)?.focus();
}

function snappyQuestionDone(id, answer) {
  const card = SNAP.cards.get(id);
  if (!card) return;
  SNAP.cards.delete(id);
  card.remove();
  snappyAdd(snappyDiv("snappy-note", answer ? tr("snappy.answered", { what: answer }) : tr("snappy.unanswered")));
}

listen("snappy-question-done", (e) => snappyQuestionDone(e.payload.id, e.payload.answer));
