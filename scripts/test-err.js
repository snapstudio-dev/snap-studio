// node scripts/test-err.js — errors said without their addresses, and told
// apart: no answer, or an answer that is an error.
const assert = require("assert");
const { errNoUrl, errUnreachable } = require("../ui/err-logic.js");

// reqwest's address goes, the rest stays.
assert.equal(errNoUrl("error sending request for url (http://192.168.0.144:7125/printer/objects/query?webhooks): operation timed out"), "error sending request: operation timed out");
assert.equal(errNoUrl("Printer unreachable: error sending request for url (http://u1.local:7125/server/info)"), "Printer unreachable: error sending request");
assert.equal(errNoUrl("ws://10.0.0.2:7125/websocket: connection refused").includes("10.0.0.2"), false);
assert.equal(errNoUrl("IO error: Connection refused (os error 61)"), "IO error: Connection refused (os error 61)");
assert.equal(errNoUrl(null), "");
assert.equal(errNoUrl({ message: "HTTP 500" }), "HTTP 500");
// Bare addresses and .local names go too.
assert.equal(errNoUrl("tcp connect error: Connection refused (os error 111) 192.168.0.5:7125"), "tcp connect error: Connection refused (os error 111)");
assert.equal(errNoUrl("Could not resolve host u1.local"), "Could not resolve host");
assert.equal(errNoUrl("see http://x.local/y."), "see.");
// Messages without an address keep their words and typography.
assert.equal(errNoUrl("Suppression impossible : HTTP 500"), "Suppression impossible : HTTP 500", "French space before a colon");
assert.equal(errNoUrl("Invalid URL: relative URL without a base"), "Invalid URL: relative URL without a base", "the word URL alone stays");
assert.equal(errNoUrl("Klipper reports: SHUTDOWN"), "Klipper reports: SHUTDOWN");

// No answer, or an answer that is an error.
for (const e of [
  "error sending request for url (http://1.2.3.4:7125/server/info): operation timed out",
  "error sending request for url (http://u1.local:7125/): error trying to connect: dns error: failed to lookup address information",
  "IO error: Connection refused (os error 61)",
  "tcp connect error: Connection refused (os error 111)",
  "No route to host (os error 65)",
]) assert.equal(errUnreachable(e), true, e);
for (const e of ["HTTP 503", "HTTP 401", "Klipper reports: SHUTDOWN", "error decoding response body: expected value", "unknown action: x", ""]) assert.equal(errUnreachable(e), false, e);

console.log("err: ok");
