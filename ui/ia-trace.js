"use strict";
/* Terminal tab of a conversation: what the chat's Claude does, as a
   terminal shows it.

   No second Claude: the tab reads the same session as the chat — its past
   from the conversation's log, then the events as they come — and writes
   them as terminal text: the messages, each tool called with what it was
   given, the start of its result, the permissions asked, the end of each
   turn. Read only; the conversation is written to from the chat, and Stop
   interrupts the same answer. */

const TRACE_C = { dim: "\x1b[90m", user: "\x1b[1;36m", tool: "\x1b[33m", bold: "\x1b[1m", ok: "\x1b[32m", err: "\x1b[31m", ask: "\x1b[35m", off: "\x1b[0m" };
/* Lines of a tool result shown; the rest is counted. */
const TRACE_RESULT_LINES = 8;

/* Text for the terminal: line ends as xterm wants them, and no control
   or escape character of the text's own (a tool result may carry a file's
   ANSI colours, a page's escape sequences: the terminal would obey them). */
const traceNl = (s) =>
  String(s)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\r?\n/g, "\r\n");

/* What a tool was given, in one line: the command, the file, otherwise
   its input as compact JSON. */
function traceToolSummary(name, input) {
  const i = input || {};
  const one = i.command || i.file_path || i.path || i.pattern || i.url || i.description;
  const s = typeof one === "string" ? one : JSON.stringify(i);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 159) + "…" : flat;
}

/* Text of a tool result: a string, or text blocks. */
function traceResultText(content) {
  if (typeof content === "string") return content;
  return (content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

/* One event of the chat session as terminal text ("" when it shows
   nothing). `st` keeps what streaming already wrote; `t` translates. */
function traceEvent(ev, st, t) {
  const C = TRACE_C;
  switch (ev.type) {
    case "stream_event": {
      const e = ev.event || {};
      if (e.type === "message_start") st.streamed = false;
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        const head = st.streamed ? "" : "\r\n";
        st.streamed = true;
        return head + traceNl(e.delta.text);
      }
      return "";
    }
    case "assistant": {
      let out = "";
      for (const b of ev.message?.content || []) {
        if (b.type === "text" && b.text) {
          // Already written while it streamed: only the line ends.
          out += st.streamed ? "\r\n" : "\r\n" + traceNl(b.text) + "\r\n";
          st.streamed = false;
        } else if (b.type === "tool_use") {
          out += `${C.tool}● ${C.bold}${b.name}${C.off}${C.dim}(${traceToolSummary(b.name, b.input)})${C.off}\r\n`;
        }
      }
      return out;
    }
    case "user": {
      const content = ev.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
      let out = "", text = "", images = 0, models = 0;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const lines = traceResultText(b.content).split(/\r?\n/).filter((l, k, all) => l.trim() || k < all.length - 1);
          const shown = lines.slice(0, TRACE_RESULT_LINES);
          const color = b.is_error ? C.err : C.dim;
          out += shown.map((l, k) => `${color}${k ? "    " : "  ⎿ "}${l}${C.off}\r\n`).join("") || `${color}  ⎿ ${C.off}\r\n`;
          if (lines.length > shown.length) out += `${C.dim}    ${t("trace.more", { n: lines.length - shown.length })}${C.off}\r\n`;
        } else if (b.type === "attachment" || b.type === "image") images++;
        else if (b.type === "model") models++;
        else if (b.type === "text" && b.text.trim() && !b.text.startsWith("[Request interrupted")) text += b.text;
      }
      // A message of models only (STL/3MF, no text) is still a message.
      if (text || images || models) {
        const pics = images ? ` ${C.dim}${t("trace.images", { n: images })}${C.off}` : "";
        const mods = models ? ` ${C.dim}${t("trace.models", { n: models })}${C.off}` : "";
        out = `\r\n${C.user}❯${C.off} ${C.bold}${traceNl(text)}${C.off}${pics}${mods}\r\n` + out;
      }
      return out;
    }
    case "control_request":
      if (ev.request?.subtype !== "can_use_tool") return "";
      return `${C.ask}? ${t("trace.permission", { tool: ev.request.tool_name || "" })}${C.off} ${C.dim}${traceToolSummary(ev.request.tool_name, ev.request.input)}${C.off}\r\n`;
    case "permission_answer":
      return `${C.dim}  → ${t(ev.allow ? "trace.allowed" : "trace.denied")}${C.off}\r\n`;
    case "version":
      return `${C.ok}✓ ${t("trace.version", { n: ev.n })}${C.off}\r\n`;
    case "result":
      st.streamed = false;
      if (ev.is_error && ev.subtype === "error_during_execution") return `${C.tool}■ ${t("trace.stopped")}${C.off}\r\n`;
      if (ev.is_error) return `${C.err}✗ ${traceNl(ev.result || t("trace.failed"))}${C.off}\r\n`;
      return `${C.dim}— ${typeof ev.duration_ms === "number" ? t("trace.done_in", { s: Math.round(ev.duration_ms / 1000) }) : t("trace.done")}${C.off}\r\n`;
    case "exited":
      return `${C.dim}${t("trace.exited")}${ev.code != null ? ` (${t("trace.code", { code: ev.code })})` : ""}${C.off}\r\n`;
    case "auth_failed":
      return `${C.err}${t("trace.auth")}${C.off}\r\n`;
    case "system":
      return ev.subtype === "api_retry" ? `${C.tool}${t("trace.retry", { n: ev.attempt, max: ev.max_retries })}${C.off}\r\n` : "";
    default:
      return "";
  }
}

if (typeof module !== "undefined") module.exports = { traceEvent, traceToolSummary, traceResultText };

/* ------------------------------------------------------------ the view */

if (typeof document !== "undefined") {
  /* Shows the conversation's session in its terminal: its past, then
     what comes. Events that arrive while the past is read are dropped:
     the past holds them already, or will on the next opening. */
  window.iaTraceOpen = async function iaTraceOpen(c) {
    const id = c.id;
    const t = iaTerm(id);
    const host = $("ia-term");
    host.innerHTML = "";
    host.appendChild(t.el);
    if (!t.opened) {
      t.term.open(t.el);
      t.opened = true;
    }
    requestAnimationFrame(() => iaFit(id));
    t.ready = false;
    t.st = {};
    t.term.reset();
    let past = [];
    try {
      past = (await invoke("ia_chat_history", { id })) || [];
    } catch {}
    if (IA.open !== id) return;
    t.term.write(past.map((ev) => traceEvent(ev, t.st, tr)).join(""));
    t.ready = true;
  };

  listen("ia-chat", (e) => {
    const { id, events } = e.payload;
    const t = IA.terms.get(id);
    if (!t || !t.ready) return;
    t.term.write(events.map((ev) => traceEvent(ev, t.st, tr)).join(""));
  });
}
