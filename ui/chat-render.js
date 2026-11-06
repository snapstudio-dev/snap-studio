"use strict";
/* What every conversation view draws the same way (ia-chat.js, Snappy's
   card in the app and over a site): Markdown made safe, and the working
   dots. Needs vendor/marked.js and vendor/purify.js. */

marked.setOptions({ gfm: true, breaks: true });
/* Text can carry what third parties wrote (tool results, web pages):
   sanitized before it shows. */
const chatMd = (text) => DOMPurify.sanitize(marked.parse(text || ""));

function chatWorking() {
  const w = document.createElement("div");
  w.className = "chat-working";
  w.setAttribute("aria-label", tr("chat.working"));
  w.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  return w;
}
