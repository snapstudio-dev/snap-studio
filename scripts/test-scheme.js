// node scripts/test-scheme.js — protocol URLs on Windows and macOS/Linux.
const assert = require("assert");
// Node 21+ has a `navigator` of its own, which a plain assignment leaves in
// place: defined instead, so the user agent is the one the test sets.
const setAgent = (userAgent) => Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true, writable: true });
setAgent("");
const { schemeUrl, schemeBases, thumbSrc } = require("../ui/scheme.js");

assert.equal(schemeUrl("thumb", "/t?x=1", false), "thumb://localhost/t?x=1");
assert.equal(schemeUrl("thumb", "/t?x=1", true), "http://thumb.localhost/t?x=1");
assert.deepEqual(schemeBases("mesh", true), ["http://mesh.localhost", "mesh://localhost"]);
assert.deepEqual(schemeBases("mesh", false), ["mesh://localhost", "http://mesh.localhost"]);

// Windows paths survive the query: drive letter, backslashes, spaces, UNC, \\?\.
for (const p of ["C:\\Users\\Ana\\Mes modèles\\pièce #1.3mf", "\\\\NAS\\prints\\a&b.3mf", "\\\\?\\C:\\long\\x.3mf", "/Users/a/b.3mf"]) {
  const u = new URL(thumbSrc(p, 320, 2, 12).replace(/^thumb:\/\/localhost/, "http://x"));
  assert.equal(u.searchParams.get("p"), p);
  assert.equal(u.searchParams.get("s"), "320");
  assert.equal(u.searchParams.get("v"), "12");
}
setAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129");
delete require.cache[require.resolve("../ui/scheme.js")];
assert.ok(require("../ui/scheme.js").thumbSrc("C:\\a.3mf", 46).startsWith("http://thumb.localhost/t?p=C%3A%5Ca.3mf"));

// fetchScheme: the server's message survives the other form's network error.
(async () => {
  const { fetchScheme } = require("../ui/scheme.js");
  const t = (k, v) => `${k}:${v?.status ?? ""}`;
  const resp = (status, xerr) => ({ ok: status === 200, status, headers: { get: () => xerr || null }, arrayBuffer: async () => "BUF" });
  const winFetch = async (u) => { if (u.startsWith("http://")) return resp(500, "model too dense"); throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchScheme("mesh", "/b", { windows: true, fetchFn: winFetch, t }), /model too dense/);
  // 404 on the first form, network error on the second: the 404 message stays.
  const nf = async (u) => { if (u.startsWith("http://")) return resp(404, "file not found"); throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchScheme("mesh", "/b", { windows: true, fetchFn: nf, t }), /file not found/);
  // macOS: first form fails at the network level, second answers.
  const mac = async (u) => { if (u.startsWith("mesh://")) return resp(200); throw new TypeError("x"); };
  assert.equal(await fetchScheme("mesh", "/b", { windows: false, fetchFn: mac, t }), "BUF");
  // No X-Error header: translated status message.
  await assert.rejects(fetchScheme("mesh", "/b", { windows: false, fetchFn: async () => resp(500), t }), /err.http_status:500/);
  // Nothing served at all.
  await assert.rejects(fetchScheme("mesh", "/b", { windows: false, fetchFn: async () => { throw new TypeError("net"); }, t }), /net/);

  // Platform form from Tauri's convertFileSrc wins over the user agent.
  global.navigator = { userAgent: "Macintosh" };
  global.window = { __TAURI__: { core: { convertFileSrc: (p, s) => `http://${s}.localhost/${p}` } } };
  delete require.cache[require.resolve("../ui/scheme.js")];
  assert.equal(require("../ui/scheme.js").schemeWindows(), true);
  global.window = { __TAURI__: { core: { convertFileSrc: (p, s) => `${s}://localhost/${p}` } } };
  global.navigator = { userAgent: "Windows NT 10.0" };
  delete require.cache[require.resolve("../ui/scheme.js")];
  assert.equal(require("../ui/scheme.js").schemeWindows(), false);
  console.log("scheme.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
