/* Address of one of the app's own protocols (thumb, cam, mesh, gcode).

   Tauri serves a custom protocol as `<scheme>://localhost/…` on macOS and
   Linux, but WebView2 (Windows) cannot: there it is `http://<scheme>.localhost/…`.
   A hard-coded `thumb://` URL is never loaded on Windows, and an <img> has
   no fallback: the thumbnail stays a gray placeholder. */
/* Which form: Tauri knows (`convertFileSrc("", scheme)` gives the platform's
   base); the user agent is the fallback when it is not there (tests). */
function schemeWindows() {
  try {
    const base = window.__TAURI__?.core?.convertFileSrc?.("", "thumb");
    if (typeof base === "string" && /^(https?:\/\/thumb\.localhost|thumb:\/\/localhost)/.test(base)) return base.startsWith("http");
  } catch {}
  return /Windows/i.test((typeof navigator !== "undefined" && navigator.userAgent) || "");
}
const IS_WINDOWS = schemeWindows();

function schemeUrl(scheme, rest, windows = IS_WINDOWS) {
  return (windows ? `http://${scheme}.localhost` : `${scheme}://localhost`) + rest;
}

/* Both forms, the platform's first: for fetch() callers that try in turn. */
function schemeBases(scheme, windows = IS_WINDOWS) {
  const a = `${scheme}://localhost`, b = `http://${scheme}.localhost`;
  return windows ? [b, a] : [a, b];
}

/* Binary answer of one of the app's protocols, trying both forms. A network
   error (form not served on this platform) never overwrites a real server
   answer; a non-404 answer ends the loop with the server's message. */
async function fetchScheme(scheme, rest, { windows = IS_WINDOWS, fetchFn = fetch, t = (k, v) => (typeof tr === "function" ? tr(k, v) : `${k} ${v?.status ?? ""}`) } = {}) {
  let last = null;
  for (const base of schemeBases(scheme, windows)) {
    let r;
    try {
      r = await fetchFn(base + rest);
    } catch (e) {
      last ||= e;
      continue;
    }
    if (r.ok) return await r.arrayBuffer();
    last = new Error(r.headers.get("X-Error") || t("err.http_status", { status: r.status }));
    if (r.status !== 404) throw last;
  }
  throw last || new Error(t("err.protocol_unavailable"));
}

/* Thumbnail of a file: `path` is sent as is (encoded), backslashes,
   drive letters and UNC paths included — the backend decodes it. */
function thumbSrc(path, size, kind = 0, version) {
  return schemeUrl("thumb", `/t?p=${encodeURIComponent(path)}&s=${size}&k=${kind}${version != null ? `&v=${version}` : ""}`);
}

if (typeof module !== "undefined") module.exports = { schemeUrl, schemeBases, thumbSrc, fetchScheme, schemeWindows };
