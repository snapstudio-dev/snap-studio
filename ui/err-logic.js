"use strict";
/* Errors said to the user (printer page, Control, the printer's files).
   Pure, for scripts/test-err.js. Loaded before the views that use it.

   reqwest and the websocket put the address they tried in their message
   ("error sending request for url (http://…/server/info)"): it only
   belongs in the console. And a printer that does not answer is said as
   such, while one that answers with an error (Klipper shut down, HTTP 503)
   says that error: they call for different things. */

/* An address: a URL (scheme://…, without the punctuation that may follow
   it), an IPv4 with or without its port, a .local host name. */
const ERR_URL = /(?:https?|wss?):\/\/[^\s)'"]*[^\s)'".,:;!?]/gi;
const ERR_IP = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const ERR_LOCAL = /\b[\w-]+(?:\.[\w-]+)*\.local(?::\d{1,5})?\b/gi;

/* The error without its addresses. Only what held an address goes, with
   the space before it: the rest keeps its wording and typography (a French
   "impossible : HTTP 500" keeps its space). */
function errNoUrl(err) {
  return String(err?.message ?? err ?? "")
    // reqwest's "for url (http://…)", whole.
    .replace(/\s*(?:for\s+url\s*)?\(\s*(?:https?|wss?):\/\/[^)]*\)/gi, "")
    .replace(new RegExp(String.raw`\s*` + ERR_URL.source, "gi"), "")
    .replace(new RegExp(String.raw`\s*` + ERR_IP.source, "g"), "")
    .replace(new RegExp(String.raw`\s*` + ERR_LOCAL.source, "gi"), "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/* Whether the error says the printer could not be reached (no answer at
   all), rather than an answer that is an error. */
const ERR_UNREACHABLE = /error sending request|error trying to connect|tcp connect|connection (?:refused|reset|closed|aborted)|timed out|timeout|dns error|failed to lookup|could not resolve|no route to host|network is unreachable|host is down|os error (?:51|60|61|64|65|101|110|111|113)\b|broken pipe|websocket.*(?:closed|failed)/i;
const errUnreachable = (err) => ERR_UNREACHABLE.test(String(err?.message ?? err ?? ""));

if (typeof module !== "undefined") module.exports = { errNoUrl, errUnreachable };
