"use strict";
/* AI tab: the conversation view.

   Claude Code runs in its structured mode (src-tauri/src/chat.rs): its events
   arrive as the "ia-chat" event, already slimmed; the past comes from the
   conversation's own log (workspace/chat.jsonl) or, for older conversations,
   from Claude's transcript. This view renders both the same way.

   Adapted from claude-chat-panel's page (web/chat.js,
   https://github.com/simscorpbs/claude-chat-panel, MIT License,
   Copyright (c) 2026 simscorpbs): streamed Markdown, tool rows, permission
   cards, Stop. */

const CHAT = {
  /* Conversation shown, or null. */
  id: null,
  /* Conversations whose turn is running, shown or not. */
  busy: new Set(),
  streaming: null,
  streamText: "",
  pending: false,
  /* tool_use id → row; request_id → permission card. */
  tools: new Map(),
  perms: new Map(),
  /* Images and models (attach-logic.js) waiting to leave with the next
     message. */
  attach: [],
  /* Initial requests already sent, so a reopening does not send them twice. */
  autoSent: new Set(),
  /* Conversation id → images and models added in the creation sheet, which
     leave with its initial request. */
  firstAttach: new Map(),
  /* The turn of the conversation shown: "" | "answering" | "stopping". */
  phase: "",
};

const CHAT_MAX_IMAGES = ATTACH_MAX_IMAGES;
/* Longest side sent to Claude: beyond it, the model scales images down anyway. */
const CHAT_MAX_SIDE = 1568;
const INTERRUPTED = "[Request interrupted by user]";

const chatList = $("chat-list");

/* ------------------------------------------------------------ rendering */

marked.setOptions({ gfm: true, breaks: true });
/* Text can carry what third parties wrote (tool results, web pages):
   sanitized before it shows. */
const chatMd = (text) => DOMPurify.sanitize(marked.parse(text || ""));

const chatNearBottom = () => chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;

function chatAdd(el) {
  const stick = chatNearBottom();
  chatList.appendChild(el);
  if (stick) chatList.scrollTop = chatList.scrollHeight;
}

function chatDiv(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function chatClearEmpty() {
  chatList.querySelector(".chat-empty")?.remove();
}

function chatCopy(text, button) {
  navigator.clipboard?.writeText(text).catch(() => {});
  const before = button.textContent;
  button.textContent = tr("chat.copied");
  setTimeout(() => (button.textContent = before), 1200);
}

function chatCopyButton(cls, text) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = tr("chat.copy");
  b.onclick = (e) => {
    e.stopPropagation();
    chatCopy(text(), b);
  };
  return b;
}

/* Copy buttons on code blocks. */
function chatDecorate(el) {
  el.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".chat-copy")) return;
    const code = pre.querySelector("code");
    pre.appendChild(chatCopyButton("chat-copy", () => (code || pre).innerText));
  });
}

function chatWorking() {
  const w = chatDiv("chat-working");
  w.setAttribute("aria-label", tr("chat.working"));
  w.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  return w;
}

/* The working dots always stay last. */
function chatMoveWorkingDown() {
  const w = chatList.querySelector(".chat-working");
  if (w) {
    w.remove();
    chatAdd(w);
  }
}

/* While a turn runs, Stop stands where Send was, with its word. Stopping
   only interrupts the turn: the session stays, and the next message
   resumes it. */
function chatSetBusy(on) {
  if (CHAT.id) on ? CHAT.busy.add(CHAT.id) : CHAT.busy.delete(CHAT.id);
  $("chat-stop").classList.toggle("hidden", !on);
  $("chat-stop").disabled = false;
  $("chat-send").classList.toggle("hidden", on);
  // The terminal view has the same Stop.
  $("ia-term-stop").classList.toggle("hidden", !on);
  chatList.querySelector(".chat-working")?.remove();
  if (on) {
    chatAdd(chatWorking());
    if (CHAT.id) IA.failed.delete(CHAT.id);
  }
  CHAT.phase = on ? "answering" : "";
  iaStatusChanged();
}

/* Stop button and Esc: interrupt the turn; the button waits until it is
   done. */
function chatStop() {
  if (!CHAT.id || !CHAT.busy.has(CHAT.id) || CHAT.phase === "stopping") return;
  CHAT.phase = "stopping";
  $("chat-stop").disabled = true;
  invoke("ia_chat_stop", { id: CHAT.id }).catch((e) => {
    CHAT.phase = "answering";
    $("chat-stop").disabled = false;
    toast(String(e), true);
  });
}

/* A conversation whose mode is not ready: its history only. */
function chatSetLocked(on) {
  for (const id of ["chat-input", "chat-send", "chat-add", "chat-model"]) $(id).disabled = on;
  $("chat-input").placeholder = tr(on ? "chat.placeholder_locked" : "chat.placeholder");
}

/* An image of the conversation folder, served by the thumbnail protocol. */
const chatAttachmentUrl = (name) =>
  schemeUrl("thumb", `/ia?ia=${encodeURIComponent(CHAT.id)}&att=${encodeURIComponent(name)}`);

/* A user message: images first, then the models, then the text. `images`
   are URLs; `models` as their chips show them ({ name, parts, size_mm }). */
function chatUserBubble(text, images = [], models = []) {
  chatClearEmpty();
  const d = chatDiv("chat-msg user");
  if (images.length) {
    const row = chatDiv("chat-images");
    for (const src of images) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.onerror = () => img.remove();
      row.appendChild(img);
    }
    d.appendChild(row);
  }
  if (models.length) {
    const row = chatDiv("chat-models");
    for (const m of models) row.appendChild(chatModelChip(m));
    d.appendChild(row);
  }
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    d.appendChild(span);
  }
  chatAdd(d);
  chatMoveWorkingDown();
}

function chatAssistant(text, el) {
  chatClearEmpty();
  const d = el || chatDiv("chat-msg assistant");
  d.classList.remove("streaming");
  d.innerHTML = chatMd(text);
  chatDecorate(d);
  d.appendChild(chatCopyButton("chat-copy-msg", () => text));
  if (!el) chatAdd(d);
  chatMoveWorkingDown();
}

/* One line saying what a tool works on: the command, the file, the pattern… */
function chatToolSummary(input) {
  if (!input) return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.url
    || input.query || input.skill || input.description || input.prompt || JSON.stringify(input);
  return String(v).split("\n")[0].slice(0, 160);
}

const chatToolName = (name) =>
  String(name || "").replace(/^mcp__claude_ai_/, "").replace(/^mcp__/, "").replace(/__/g, " · ");

function chatToolRow(id, name, input) {
  chatClearEmpty();
  const d = document.createElement("details");
  d.className = "chat-tool";
  const s = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "dot";
  const n = document.createElement("span");
  n.className = "name";
  n.textContent = chatToolName(name);
  const a = document.createElement("span");
  a.className = "arg";
  a.textContent = chatToolSummary(input);
  s.append(dot, n, a);
  d.appendChild(s);
  const body = document.createElement("pre");
  body.className = "result";
  d.appendChild(body);
  CHAT.tools.set(id, d);
  chatAdd(d);
  chatMoveWorkingDown();
}

function chatToolResult(id, content, isError) {
  const d = CHAT.tools.get(id);
  if (!d) return;
  const text = typeof content === "string"
    ? content
    : (content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  d.querySelector(".result").textContent = text;
  d.classList.add("done");
  if (isError) d.classList.add("error");
}

function chatNote(text, kind = "") {
  chatClearEmpty();
  chatAdd(chatDiv("chat-note " + kind, text));
  chatMoveWorkingDown();
}

/* Claude could not sign in: say so with a way out, and open the account
   window at once. The turn ends by itself (the backend interrupts it). */
function chatAuthFailed() {
  const engine = IA.list.find((x) => x.id === CHAT.id)?.engine || "local";
  const note = chatDiv("chat-note error", tr("chat.auth_failed"));
  const btn = document.createElement("button");
  btn.className = "btn small chat-note-btn";
  btn.textContent = tr("chat.auth_fix");
  btn.addEventListener("click", () => authOpen({ engine }));
  note.appendChild(btn);
  chatClearEmpty();
  chatAdd(note);
  chatMoveWorkingDown();
  authOpen({ engine });
}

/* A permission Claude asks for. `live`: answerable now. */
function chatPermission(ev, live) {
  const card = chatDiv("chat-card");
  card.dataset.request = ev.request_id;
  chatPermissionBody(card, ev, live);
  CHAT.perms.set(ev.request_id, card);
  chatAdd(card);
  chatMoveWorkingDown();
}

/* Fills a permission card; also used to make a replayed one answerable when
   Claude is still waiting for it. Two tools get a card of their own: a
   question Claude asks (AskUserQuestion) and the plan it proposes
   (ExitPlanMode). */
function chatPermissionBody(card, ev, live) {
  if (ev.request.tool_name === "AskUserQuestion") return chatQuestionBody(card, ev, live);
  if (ev.request.tool_name === "ExitPlanMode") return chatPlanBody(card, ev, live);
  chatClearEmpty();
  card._ev = ev;
  card.innerHTML = "";
  const r = ev.request;
  card.appendChild(chatDiv("title", tr("chat.permission", { tool: chatToolName(r.display_name || r.tool_name) })));
  const what = [r.description, chatToolSummary(r.input)].filter(Boolean);
  if (what[0] === what[1]) what.pop();
  card.appendChild(chatDiv("what", what.join("\n")));
  const row = chatDiv("row");
  const pill = (label, primary, allow, always) => {
    const b = document.createElement("button");
    b.className = "btn small" + (primary ? " primary" : "");
    b.textContent = label;
    b.onclick = async () => {
      row.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await invoke("ia_chat_answer", { id: CHAT.id, requestId: ev.request_id, allow, always });
        chatPermissionDone(ev.request_id, allow, always);
      } catch (e) {
        row.querySelectorAll("button").forEach((x) => (x.disabled = false));
        toast(String(e), true);
      }
    };
    row.appendChild(b);
  };
  if (live) {
    pill(tr("chat.allow"), true, true, false);
    if (r.can_always) pill(tr("chat.always"), false, true, true);
    pill(tr("chat.deny"), false, false, false);
  } else {
    row.appendChild(chatDiv("done", tr("chat.unanswered")));
  }
  card.appendChild(row);
}

/* Sends a permission answer; `input` carries a question's answers. */
async function chatAnswer(card, ev, allow, always, input) {
  card.querySelectorAll("button").forEach((x) => (x.disabled = true));
  try {
    await invoke("ia_chat_answer", { id: CHAT.id, requestId: ev.request_id, allow, always, input: input || null });
    chatPermissionDone(ev.request_id, allow, always, input?.answers);
  } catch (e) {
    card.querySelectorAll("button").forEach((x) => (x.disabled = false));
    toast(String(e), true);
  }
}

/* Claude's multiple-choice questions: one choice per question (several when
   it allows), then Send. */
function chatQuestionBody(card, ev, live) {
  chatClearEmpty();
  card._ev = ev;
  card.innerHTML = "";
  card.appendChild(chatDiv("title", tr("chat.question")));
  const questions = ev.request.input?.questions || [];
  const picked = questions.map(() => new Set());
  const row = chatDiv("row");
  const send = document.createElement("button");
  send.className = "btn small primary";
  send.textContent = tr("chat.answer");
  send.disabled = true;
  questions.forEach((q, qi) => {
    const box = chatDiv("chat-question");
    box.appendChild(chatDiv("q", q.question));
    const opts = chatDiv("opts");
    for (const o of q.options || []) {
      const b = document.createElement("button");
      b.className = "btn small opt";
      b.textContent = o.label;
      if (o.description) {
        const s = document.createElement("small");
        s.textContent = o.description;
        b.appendChild(s);
      }
      b.disabled = !live;
      b.onclick = () => {
        if (!q.multiSelect) {
          picked[qi].clear();
          opts.querySelectorAll(".opt").forEach((x) => x.classList.remove("on"));
        }
        picked[qi].has(o.label) ? picked[qi].delete(o.label) : picked[qi].add(o.label);
        b.classList.toggle("on", picked[qi].has(o.label));
        send.disabled = picked.some((p) => !p.size);
      };
      opts.appendChild(b);
    }
    box.appendChild(opts);
    card.appendChild(box);
  });
  if (live) {
    send.onclick = () => {
      const answers = {};
      questions.forEach((q, i) => (answers[q.question] = [...picked[i]].join(", ")));
      chatAnswer(card, ev, true, false, { ...ev.request.input, answers });
    };
    row.appendChild(send);
    const skip = document.createElement("button");
    skip.className = "btn small";
    skip.textContent = tr("chat.skip_question");
    skip.onclick = () => chatAnswer(card, ev, false, false);
    row.appendChild(skip);
  } else {
    row.appendChild(chatDiv("done", tr("chat.unanswered")));
  }
  card.appendChild(row);
}

/* The plan Claude proposes in plan mode: approve it, or keep planning. */
function chatPlanBody(card, ev, live) {
  chatClearEmpty();
  card._ev = ev;
  card.innerHTML = "";
  card.appendChild(chatDiv("title", tr("chat.plan")));
  const plan = chatDiv("chat-plan chat-msg assistant");
  plan.innerHTML = chatMd(ev.request.input?.plan || "");
  card.appendChild(plan);
  const row = chatDiv("row");
  if (live) {
    const ok = document.createElement("button");
    ok.className = "btn small primary";
    ok.textContent = tr("chat.plan_approve");
    ok.onclick = () => chatAnswer(card, ev, true, false);
    const no = document.createElement("button");
    no.className = "btn small";
    no.textContent = tr("chat.plan_keep");
    no.onclick = () => chatAnswer(card, ev, false, false);
    row.append(ok, no);
  } else {
    row.appendChild(chatDiv("done", tr("chat.unanswered")));
  }
  card.appendChild(row);
}

function chatPermissionDone(requestId, allow, always, answers) {
  const card = CHAT.perms.get(requestId);
  if (!card) return;
  card.dataset.answered = "1";
  if (answers && typeof answers === "object") {
    const row = card.querySelector(".row");
    row.innerHTML = "";
    row.appendChild(chatDiv("done", tr("chat.answered", { a: Object.values(answers).join(" · ") })));
    card.querySelectorAll(".opt").forEach((b) => (b.disabled = true));
    return;
  }
  if (card._ev?.request?.tool_name === "ExitPlanMode") {
    const row = card.querySelector(".row");
    row.innerHTML = "";
    row.appendChild(chatDiv("done", tr(allow ? "chat.plan_approved" : "chat.plan_kept")));
    return;
  }
  const row = card.querySelector(".row");
  row.innerHTML = "";
  row.appendChild(chatDiv("done", tr(allow ? (always ? "chat.allowed_always" : "chat.allowed") : "chat.denied")));
}

/* A preview Claude looked at, as it was then: shown on its tool row, so the
   user sees what Claude saw. */
function chatSeen(toolId, name) {
  const row = CHAT.tools.get(toolId);
  if (!row) return;
  const img = document.createElement("img");
  img.className = "chat-seen";
  img.src = chatAttachmentUrl(name);
  img.alt = "";
  img.onerror = () => img.remove();
  row.after(img);
}

/* A new version of the object, archived while Claude worked. */
function chatVersion(n) {
  chatClearEmpty();
  const chip = document.createElement("button");
  chip.className = "chat-version";
  chip.dataset.v = n;
  chip.textContent = tr("chat.version", { n });
  chip.title = tr("ia.version.revert");
  chatAdd(chip);
  chatMoveWorkingDown();
}

/* ------------------------------------------------------------ events */

/* `live`: the event just happened; otherwise it is replayed from the past. */
function chatHandle(ev, live) {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "api_retry" && live && ev.error !== "authentication_failed") {
        chatNote(tr("chat.retry", { n: ev.attempt, max: ev.max_retries }), "muted");
      }
      break;
    case "stream_event": {
      const e = ev.event || {};
      if (e.type === "message_start") {
        CHAT.streaming = null;
        CHAT.streamText = "";
      }
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        CHAT.streamText += e.delta.text;
        if (!CHAT.streaming) {
          chatClearEmpty();
          CHAT.streaming = chatDiv("chat-msg assistant streaming");
          chatAdd(CHAT.streaming);
          chatMoveWorkingDown();
        }
        if (!CHAT.pending) {
          CHAT.pending = true;
          requestAnimationFrame(() => {
            CHAT.pending = false;
            if (!CHAT.streaming) return;
            const stick = chatNearBottom();
            CHAT.streaming.innerHTML = chatMd(CHAT.streamText);
            if (stick) chatList.scrollTop = chatList.scrollHeight;
          });
        }
      }
      break;
    }
    case "assistant":
      for (const block of ev.message?.content || []) {
        if (block.type === "text" && block.text) {
          chatAssistant(block.text, CHAT.streaming);
          CHAT.streaming = null;
          CHAT.streamText = "";
        } else if (block.type === "tool_use") {
          chatToolRow(block.id, block.name, block.input);
        }
      }
      break;
    case "user": {
      const content = ev.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
      const images = [];
      const models = [];
      let text = "";
      for (const block of blocks) {
        if (block.type === "tool_result") chatToolResult(block.tool_use_id, block.content, block.is_error);
        else if (block.type === "attachment") images.push(chatAttachmentUrl(block.name));
        else if (block.type === "model") models.push({ name: block.original || block.name, parts: block.parts, size_mm: block.size_mm });
        else if (block.type === "text" && block.text.trim() && block.text !== INTERRUPTED) text += block.text;
      }
      if (text || images.length || models.length) chatUserBubble(text, images, models);
      break;
    }
    case "control_request":
      if (ev.request?.subtype === "can_use_tool") chatPermission(ev, live);
      break;
    case "permission_answer":
      chatPermissionDone(ev.request_id, ev.allow, ev.always, ev.answers);
      break;
    case "version":
      chatVersion(ev.n);
      break;
    case "seen":
      chatSeen(ev.tool_use_id, ev.name);
      break;
    case "result":
      if (CHAT.streaming && CHAT.streamText) chatAssistant(CHAT.streamText, CHAT.streaming);
      CHAT.streaming = null;
      CHAT.streamText = "";
      if (live && ev.is_error && ev.subtype !== "error_during_execution" && CHAT.id) IA.failed.add(CHAT.id);
      if (live) chatSetBusy(false);
      if (ev.is_error && ev.subtype === "error_during_execution") chatNote(tr("chat.stopped"), "muted");
      else if (ev.is_error && ev.result) chatNote(String(ev.result), "error");
      break;
    case "exited":
      if (CHAT.busy.has(CHAT.id)) {
        chatNote(tr("chat.exited"), "muted");
        // What the process said on stderr: the reason, when it failed to start.
        if (ev.stderr) chatNote(String(ev.stderr), "muted pre");
        // A sandbox that could not start, in words (chat.rs).
        if (ev.message) chatNote(String(ev.message), "error");
      }
      chatSetBusy(false);
      break;
    case "auth_failed":
      if (live) chatAuthFailed();
      break;
  }
}

listen("ia-chat", (e) => {
  const { id, events } = e.payload;
  for (const ev of events) {
    if (id === CHAT.id && CHAT.loading === id) CHAT.early.push(ev);
    else if (id === CHAT.id) chatHandle(ev, true);
    else if (ev.type === "result" || ev.type === "exited") {
      CHAT.busy.delete(id);
      if (ev.type === "result" && ev.is_error && ev.subtype !== "error_during_execution") IA.failed.add(id);
      iaStatusChanged();
    }
  }
});

/* A version archived while the conversation is shown: its chip, live. The
   log keeps it for the next opening. */
listen("ia-mesh", (e) => {
  if (e.payload.id === CHAT.id) chatVersion(e.payload.version);
});

/* ------------------------------------------------------------ model */

/* Models a conversation may choose (chat.rs `MODELS`), with their names;
   "" is the account's default. */
const CHAT_MODELS = [
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5"],
];
const chatModelName = (id) => CHAT_MODELS.find(([m]) => id && id.startsWith(m.replace(/-\d{8}$/, "")))?.[1] || id || "";

function chatModelFill(c) {
  const sel = $("chat-model");
  sel.innerHTML = [["", tr("chat.model.default")], ...CHAT_MODELS].map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join("");
  sel.value = CHAT_MODELS.some(([m]) => m === c.model) ? c.model : "";
}

$("chat-model").addEventListener("change", (e) => {
  if (!CHAT.id) return;
  const model = e.target.value || null;
  if (CHAT.conv) CHAT.conv.model = model;
  invoke("ia_chat_model", { id: CHAT.id, model })
    .then(() => toast(tr("chat.model.changed", { model: model ? chatModelName(model) : tr("chat.model.default") })))
    .catch((err) => toast(String(err), true));
});

/* ------------------------------------------------------------ opening */

function chatReset() {
  chatList.innerHTML = "";
  CHAT.tools.clear();
  CHAT.perms.clear();
  CHAT.streaming = null;
  CHAT.streamText = "";
}

/* Shows a conversation: its past, then — for a brand new one — its initial
   request as the first message. */
async function chatOpen(c) {
  CHAT.id = c.id;
  CHAT.conv = c;
  chatReset();
  chatClearAttachments();
  chatModelFill(c);
  let past = [];
  // Live events of this conversation wait while its past is read: the log
  // is written before an event is sent, so one arriving now may already be
  // in the past; rendered twice, a tool row or a message would double.
  CHAT.loading = c.id;
  CHAT.early = [];
  try {
    past = (await invoke("ia_chat_history", { id: c.id })) || [];
  } catch {}
  if (CHAT.id !== c.id) return;
  for (const ev of past) chatHandle(ev, false);
  const seen = new Set(past.map((ev) => JSON.stringify(ev)));
  const early = CHAT.early.filter((ev) => !seen.has(JSON.stringify(ev)));
  CHAT.loading = null;
  CHAT.early = [];
  for (const ev of early) chatHandle(ev, true);
  chatList.scrollTop = chatList.scrollHeight;
  const busy = CHAT.busy.has(c.id);
  CHAT.busy.delete(c.id);
  CHAT.phase = "";
  chatSetBusy(busy);
  // Claude may still be waiting on a permission asked while the conversation
  // was not shown: its card becomes answerable again.
  const waiting = [...CHAT.perms.values()].filter((card) => !card.dataset.answered);
  if (waiting.length && (await invoke("ia_chat_running", { id: c.id }).catch(() => false)) && CHAT.id === c.id) {
    for (const card of waiting) chatPermissionBody(card, card._ev, true);
  }
  chatSetLocked(!!IA.locked);
  if (!past.length) {
    chatList.appendChild(chatDiv("chat-empty", tr(iaIsCreation(c) ? "chat.empty_create" : "chat.empty")));
    const attach = CHAT.firstAttach.get(c.id) || [];
    if ((c.prompt || attach.length) && !c.started && !CHAT.autoSent.has(c.id) && !IA.locked) {
      CHAT.autoSent.add(c.id);
      CHAT.firstAttach.delete(c.id);
      chatSend(c.prompt || "", attach);
    }
  }
  $("chat-input").focus();
}

function chatLeave() {
  const id = CHAT.id;
  CHAT.id = null;
  chatClearAttachments();
  // An idle Claude is not kept running (nor its sandbox) while the
  // conversation is not shown: the next message resumes it. One that is
  // answering goes on, and its end is still reported to the list.
  if (id && !CHAT.busy.has(id)) invoke("ia_chat_close", { id }).catch(() => {});
}

/* ------------------------------------------------------------ sending */

/* `attachments`: images and models (attach-logic.js). Models leave as the
   paths of the user's files: the app copies them into the conversation's
   folder. */
async function chatSend(text, attachments) {
  const id = CHAT.id;
  if (!id || (!text && !attachments.length)) return;
  const c = IA.list.find((x) => x.id === id);
  const images = attachments.filter((a) => a.kind !== "model");
  const models = attachments.filter((a) => a.kind === "model");
  // As the history will show them: no weight.
  chatUserBubble(text, images.map((a) => a.url), models.map(({ name, parts, size_mm }) => ({ name, parts, size_mm })));
  chatList.scrollTop = chatList.scrollHeight;
  chatSetBusy(true);
  // The first start of the sandbox builds its image: say so, it takes a while.
  if (c?.engine === "container" && !(await invoke("ia_chat_running", { id }).catch(() => true))) {
    if (CHAT.id === id) chatNote(tr("ia.sandbox_starting"), "muted");
  }
  try {
    await invoke("ia_chat_send", {
      id,
      text,
      images: images.map(({ name, media_type, data }) => ({ name, media_type, data })),
      models: models.map((m) => m.path),
    });
    if (c) c.started = true;
  } catch (e) {
    if (CHAT.id === id) {
      chatSetBusy(false);
      chatNote(String(e), "error");
    } else {
      // Left meanwhile: the card in the list must still show the failure.
      CHAT.busy.delete(id);
      IA.failed.add(id);
      iaStatusChanged();
    }
  }
}

function chatSubmit() {
  const input = $("chat-input");
  const text = input.value.trim();
  // A file still being checked would miss the message (Enter too).
  if (ATTACH_CHECKING) return;
  if (!text && !CHAT.attach.length) return;
  const attachments = CHAT.attach;
  CHAT.attach = [];
  chatRenderAttachments();
  input.value = "";
  chatGrow();
  chatSend(text, attachments);
}

/* The field grows with its text. Empty, it stays one line: measured with
   only its placeholder, while the column is still narrow or hidden, it
   came out two lines tall and the placeholder sat too high. */
function chatGrow() {
  const input = $("chat-input");
  if (!input.value) input.style.height = "";
  else {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }
  $("chat-send").disabled = ATTACH_CHECKING > 0 || (!input.value.trim() && !CHAT.attach.length);
}

/* ------------------------------------------------------------ attachments */

/* Reads an image and scales it so its longest side fits CHAT_MAX_SIDE. A
   PNG small enough stays a PNG (sketches keep their crisp lines); anything
   else becomes a JPEG. */
function chatReadImage(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, CHAT_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const keep = scale === 1 && file.type === "image/png" && file.size < 3_500_000;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      if (!keep) ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const type = keep ? "image/png" : "image/jpeg";
      const dataUrl = canvas.toDataURL(type, 0.9);
      const base = (file.name || "image").replace(/\.[^.]+$/, "");
      ok({
        name: base + (keep ? ".png" : ".jpg"),
        media_type: type,
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        url: dataUrl,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      ko(new Error(tr("chat.bad_image", { name: file.name || "?" })));
    };
    img.src = url;
  });
}

/* Reads images into `list`, up to CHAT_MAX_IMAGES: the message being
   written, or the creation sheet's (ia.js). */
/* Files being checked or read: a message or a new conversation waits for
   them (chatSubmit, iaCreate), or it would leave without them. */
let ATTACH_CHECKING = 0;
async function chatAttachWait(fn) {
  ATTACH_CHECKING++;
  chatGrow();
  try {
    return await fn();
  } finally {
    ATTACH_CHECKING--;
    chatGrow();
  }
}

/* `target()` gives the list files go to: re-read after every wait, and a
   different list (another conversation, the sheet opened again) means the
   user left, so the rest is dropped. */
function chatReadImages(files, target) {
  const list = target();
  return chatAttachWait(async () => {
    for (const f of files) {
      if (attachRoom(list, "image") <= 0) {
        toast(tr("chat.too_many", { n: CHAT_MAX_IMAGES }), true);
        break;
      }
      try {
        const img = await chatReadImage(f);
        if (target() !== list) return;
        list.push(img);
      } catch (e) {
        toast(e.message, true);
      }
    }
  });
}

/* Files given by their paths — dropped on the window, chosen in the dialog,
   pasted from a file manager — checked by the app (ia_attach.rs), then
   added to the list `target()` gives (see chatReadImages): images scaled
   like any other, models as chips. A file refused says why; none is
   skipped silently. */
function chatAttachPaths(paths, target) {
  if (!paths?.length) return Promise.resolve();
  return chatAttachWait(() => chatAttachStaged(paths, target));
}
async function chatAttachStaged(paths, target) {
  const list = target();
  let staged = [];
  try {
    staged = await invoke("ia_attach_files", { paths });
  } catch (e) {
    toast(String(e), true);
    return;
  }
  // Checking a big model takes seconds: the user may have left meanwhile.
  if (target() !== list) return;
  for (const s of staged) {
    if (s.kind === "rejected") {
      const [key, params] = attachRejectMessage(s);
      if (s.reason === "size") params.max = fmtSize(s.max);
      toast(tr(key, params), true);
    } else if (s.kind === "model") {
      if (attachRoom(list, "model") <= 0) {
        toast(tr("chat.too_many_models", { n: ATTACH_MAX_MODELS }), true);
        continue;
      }
      list.push(s);
      if (attachOddScale(s.size_mm)) toast(tr("chat.model_scale", { name: s.name, size: chatModelDims(s) }));
    } else if (attachRoom(list, "image") <= 0) {
      toast(tr("chat.too_many", { n: CHAT_MAX_IMAGES }), true);
    } else {
      const bytes = Uint8Array.from(atob(s.data), (ch) => ch.charCodeAt(0));
      try {
        const img = await chatReadImage(new File([bytes], s.name, { type: s.media_type }));
        if (target() !== list) return;
        list.push(img);
      } catch (e) {
        toast(e.message, true);
      }
    }
  }
}

/* The native dialog, for images and models: paths, as a drop gives. */
async function chatPickFiles() {
  const all = [...ATTACH_IMAGE_EXT, ...ATTACH_MODEL_EXT];
  try {
    const picked = await window.__TAURI__.dialog.open({
      multiple: true,
      filters: [
        { name: tr("chat.filter_all"), extensions: all },
        { name: tr("chat.filter_images"), extensions: ATTACH_IMAGE_EXT },
        { name: tr("chat.filter_models"), extensions: ATTACH_MODEL_EXT },
      ],
    });
    return picked == null ? [] : [].concat(picked);
  } catch (e) {
    toast(String(e), true);
    return [];
  }
}

/* A paste in a message field: images from the clipboard (a screenshot), or
   files copied in a file manager, which some systems give as paths
   (text/uri-list). A copied file without its path cannot be read here: the
   message says to drop or choose it. Plain text pastes as usual. */
function chatPaste(e, target, after) {
  const paths = pathsFromUriList(e.clipboardData?.getData("text/uri-list"));
  const files = [...(e.clipboardData?.files || [])];
  if (!paths.length && !files.length) return;
  e.preventDefault();
  if (paths.length) {
    chatAttachPaths(paths, target).then(after);
    return;
  }
  const images = files.filter((f) => f.type.startsWith("image/"));
  for (const f of files) if (!f.type.startsWith("image/")) toast(tr("chat.paste_choose", { name: f.name || "?" }), true);
  if (images.length) chatReadImages(images, target).then(after);
}

/* Width × depth × height of a model, as its chip says it. */
function chatModelDims(m) {
  const [x, y, z] = attachDims(m.size_mm);
  return tr("chat.model_dims", { x, y, z });
}

/* A model's chip: its name, parts, size (and weight while it waits to
   leave); a ✕ when `onRemove` is given. No preview: the 3D pane shows the
   result. */
function chatModelChip(m, onRemove) {
  const chip = chatDiv("chat-model-chip");
  chip.title = m.name;
  const icon = document.createElement("span");
  icon.className = "chat-model-icon";
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7zm0 2.3L18.8 8 12 11.7 5.2 8zM5 9.7l6 3.3v6.6l-6-3.3zm8 9.9V13l6-3.3v6.6z"/></svg>';
  const meta = [tr("chat.model_parts", { n: m.parts || 1 }), chatModelDims(m)];
  if (m.bytes) meta.unshift(fmtSize(m.bytes));
  const body = chatDiv("chat-model-body");
  body.append(chatDiv("chat-model-name", m.name), chatDiv("chat-model-meta", meta.join(" · ")));
  chip.append(icon, body);
  if (onRemove) {
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.title = tr("common.delete");
    x.onclick = onRemove;
    chip.appendChild(x);
  }
  return chip;
}

function chatRenderAttachments() {
  chatRenderThumbs($("chat-attach"), CHAT.attach, chatRenderAttachments);
  chatGrow();
}

/* `list`'s images and models into `box`, each with its ✕; `again` redraws. */
function chatRenderThumbs(box, list, again) {
  box.innerHTML = "";
  list.forEach((a, i) => {
    if (a.kind === "model") {
      box.appendChild(
        chatModelChip(a, () => {
          list.splice(i, 1);
          again();
        })
      );
      return;
    }
    const t = chatDiv("chat-thumb");
    const img = document.createElement("img");
    img.src = a.url;
    img.alt = a.name;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = tr("common.delete");
    x.onclick = () => {
      list.splice(i, 1);
      again();
    };
    t.append(img, x);
    box.appendChild(t);
  });
  box.classList.toggle("hidden", !list.length);
}

function chatClearAttachments() {
  CHAT.attach = [];
  chatRenderAttachments();
}

/* ------------------------------------------------------------ controls */

$("chat-input").addEventListener("input", chatGrow);
// A wider or narrower column rewraps the text: its height follows.
let chatInputW = 0;
new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width);
  if (w === chatInputW) return;
  chatInputW = w;
  if ($("chat-input").value) chatGrow();
}).observe($("chat-input"));
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!CHAT.busy.has(CHAT.id)) chatSubmit();
  } else if (e.key === "Escape" && CHAT.busy.has(CHAT.id)) {
    e.preventDefault();
    chatStop();
  }
});
$("chat-input").addEventListener("paste", (e) => chatPaste(e, () => CHAT.attach, chatRenderAttachments));
$("chat-send").addEventListener("click", chatSubmit);
$("chat-stop").addEventListener("click", chatStop);
/* Esc stops Claude from anywhere in the conversation view, not only from the
   message field — unless a sheet or menu has it. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !CHAT.id || !CHAT.busy.has(CHAT.id) || e.defaultPrevented) return;
  if ($("view-ia").classList.contains("hidden")) return;
  // Fields keep their Esc; the terminal's own hidden field does not count.
  if (document.querySelector(".modal:not(.hidden)") || (e.target.closest?.("input, select, textarea") && !e.target.closest(".xterm"))) return;
  // The preview enlarged out of its pane: Esc puts it back (viewer.js).
  const v = $("viewer");
  if (!v.classList.contains("hidden") && !v.classList.contains("docked")) return;
  e.preventDefault();
  chatStop();
});
$("chat-add").addEventListener("click", async () => {
  const paths = await chatPickFiles();
  // The conversation may have changed while the dialog was open.
  if (paths.length && CHAT.id) {
    await chatAttachPaths(paths, () => CHAT.attach);
    chatRenderAttachments();
  }
});
/* Files dropped on the window reach the conversation through app.js: with
   Tauri's drop on, the page's own drop never gets them. */

/* Links open in the browser, never in the app's window. */
chatList.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a?.href) {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: a.href }).catch((err) => toast(String(err), true));
    return;
  }
  const v = e.target.closest(".chat-version");
  if (v && CHAT.id) iaShowVersion(CHAT.id, +v.dataset.v);
});

/* A new language: the conversation is drawn again from its past. */
window.addEventListener("langchange", () => {
  const c = CHAT.id && IA.list.find((x) => x.id === CHAT.id);
  // Redrawn even while answering (notes, permission cards and labels
  // change language); only a text being streamed is left alone, it
  // would lose its partial text until the next piece.
  if (c && !CHAT.streaming) chatOpen(c);
});
