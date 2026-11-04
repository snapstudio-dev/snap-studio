// node scripts/test-whatsnew.js — the What's new card: seen per version, the page's address.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { WN_PAGE, wnMinor, wnUnseen, wnHighlights, wnUrl, wnShownAddress, wnMessage } = require("../ui/whatsnew-logic.js");

assert.equal(wnMinor("0.14.1"), "0.14");
assert.equal(wnMinor("0.14.0"), "0.14");
assert.equal(wnMinor("v1.2.3"), "1.2");
assert.equal(wnMinor("0.15.0-beta.1"), "0.15");
assert.equal(wnMinor("0.14"), "0.14");
assert.equal(wnMinor(""), null);
assert.equal(wnMinor("—"), null);
assert.equal(wnMinor(null), null);

const entry = { version: "0.14", highlights: [{ id: "explore", en: "Explore", fr: "Explorer" }, { id: "icon", en: "New icon" }] };
// Never opened: the card.
assert.equal(wnUnseen("0.14.0", entry, null), true);
// Opened: the line, and a patch release keeps it so.
assert.equal(wnUnseen("0.14.0", entry, "0.14"), false);
assert.equal(wnUnseen("0.14.1", entry, "0.14"), false);
// The next version with a page shows the card again.
assert.equal(wnUnseen("0.15.0", { ...entry, version: "0.15" }, "0.14"), true);
// A version without a page of its own (or an unknown one): the line.
assert.equal(wnUnseen("0.15.0", entry, "0.14"), false);
assert.equal(wnUnseen("0.15.0", null, null), false);
assert.equal(wnUnseen("", entry, null), false);

assert.deepEqual(wnHighlights(entry, "fr"), ["Explorer", "New icon"]);
assert.deepEqual(wnHighlights(entry, "en"), ["Explore", "New icon"]);
assert.deepEqual(wnHighlights(null, "en"), []);

assert.equal(wnUrl("fr", "0.14.1"), `${WN_PAGE}?embed=1&lang=fr#v0.14`);
assert.equal(wnUrl("de", "0.14.1"), `${WN_PAGE}?embed=1&lang=en#v0.14`);
assert.equal(wnUrl("en", "0.14.1", false), `${WN_PAGE}?lang=en#v0.14`);
assert.equal(wnUrl("en", ""), `${WN_PAGE}?embed=1&lang=en`);
assert.equal(wnShownAddress(wnUrl("fr", "0.14.1")), "kameka22.github.io/snap-studio/whats-new/");

const origin = new URL(WN_PAGE).origin;
const msg = (type, extra) => ({ source: "snapstudio-whats-new", type, ...extra });
assert.deepEqual(wnMessage(origin, msg("ready")), { type: "ready" });
assert.deepEqual(wnMessage(origin, msg("close")), { type: "close" });
assert.deepEqual(wnMessage(origin, msg("open", { url: "https://github.com/kameka22/snap-studio" })), { type: "open", url: "https://github.com/kameka22/snap-studio" });
// Another origin, another sender, or a link that is not a web page: ignored.
assert.equal(wnMessage("https://evil.example", msg("ready")), null);
assert.equal(wnMessage(origin, { type: "ready" }), null);
assert.equal(wnMessage(origin, msg("open", { url: "file:///etc/passwd" })), null);
assert.equal(wnMessage(origin, msg("open", { url: "javascript:alert(1)" })), null);
assert.equal(wnMessage(origin, msg("eval")), null);
assert.equal(wnMessage(origin, null), null);

// The app's copy of the highlights follows the site's versions.json.
const root = path.join(__dirname, "..");
execFileSync("python3", [path.join(root, "scripts", "whats-new.py"), "--check"], { stdio: "pipe" });
const site = JSON.parse(fs.readFileSync(path.join(root, "site", "whats-new", "versions.json"), "utf8"));
const cur = site.versions.find((v) => v.version === site.current);
assert.ok(cur && cur.features.length, "versions.json: the current version has features");
for (const v of site.versions) {
  assert.ok(!/^\d+\.\d+\.\d+$/.test(v.version), `versions.json: ${v.version} — patch versions fold into their minor`);
  for (const f of v.features || []) for (const k of ["title", "text", "chip", "tag"]) assert.ok(f[k].en && f[k].fr, `${v.version} ${f.id}: ${k} in en and fr`);
  for (const h of v.highlights || []) assert.ok(h.title.en && h.title.fr && h.text.en && h.text.fr, `${v.version}: a highlight in en and fr`);
  for (const sm of v.small || []) assert.ok(sm.title.en && sm.title.fr && sm.text.en && sm.text.fr, `${v.version}: a smaller improvement in en and fr`);
  if (v !== cur && v.features) {
    // A previous version with a full section: its header row needs a
    // tagline and a summary, and it has no timeline entry.
    assert.ok(v.tagline.en && v.tagline.fr && v.summary.en && v.summary.fr, `${v.version}: tagline and summary in en and fr`);
    assert.ok(v.features.length >= 2 && v.features.length <= 5, `${v.version}: 2 to 5 features`);
    assert.ok(!v.highlights, `${v.version}: a full section or a timeline entry, not both`);
  } else if (v !== cur) assert.ok(v.highlights.length >= 3 && v.highlights.length <= 5, `${v.version}: 3 to 5 highlights`);
  for (const img of [v.image, ...(v.features || []).map((f) => f.image)].filter(Boolean))
    assert.ok(fs.existsSync(path.join(root, "site", "whats-new", img)), `${v.version}: ${img} exists`);
}

// Feature ids are the page's anchors: unique across the versions.
const ids = site.versions.flatMap((v) => (v.features || []).map((f) => f.id));
assert.equal(new Set(ids).size, ids.length, "versions.json: feature ids are unique");
// Versions are newest first, the current one at the top.
assert.equal(site.versions[0], cur, "versions.json: the current version comes first");

console.log("whatsnew: ok");
