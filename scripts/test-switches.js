// node scripts/test-switches.js — the app's switches (input.sw).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const UI = path.join(__dirname, "..", "ui");

// Every switch, in the page or built in code, is a checkbox announced as a
// switch: role="switch" on each input.sw.
let n = 0;
for (const f of fs.readdirSync(UI).filter((f) => /\.(html|js)$/.test(f))) {
  const src = fs.readFileSync(path.join(UI, f), "utf8");
  for (const m of src.matchAll(/<input\b[^>]*\bclass="sw\b[^"]*"[^>]*>/g)) {
    n++;
    assert.ok(/\btype="checkbox"/.test(m[0]), `${f}: a switch is a checkbox: ${m[0]}`);
    assert.ok(/\brole="switch"/.test(m[0]), `${f}: role="switch" missing: ${m[0]}`);
  }
}
assert.ok(n >= 18, `switches found: ${n}`);

// The camera is shown and hidden with switches, no longer with Show/Hide buttons.
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
assert.ok(/<input type="checkbox" id="cam-toggle" class="sw small" role="switch"/.test(html));
assert.ok(/id="v-plate" class="sw small" role="switch" checked/.test(html), "the plate is shown by default");
assert.ok(/id="pj-cam-toggle" class="sw small" role="switch"/.test(fs.readFileSync(path.join(UI, "prints.js"), "utf8")));

// Enter toggles a switch, as Space does; never a disabled one, never another field.
const app = fs.readFileSync(path.join(UI, "app.js"), "utf8");
const at = app.indexOf('document.addEventListener("keydown", (e) => {\n  const t = e.target;\n  if (e.key !== "Enter"');
assert.ok(at > 0, "Enter handler for switches");
const code = app.slice(at, app.indexOf("}, true);", at) + "}, true);".length);
class HTMLInputElement {
  constructor(cls, disabled = false) { this.classList = { contains: (c) => cls.split(" ").includes(c) }; this.disabled = disabled; this.clicks = 0; }
  click() { this.clicks++; }
}
let handler;
new Function("document", "HTMLInputElement", code)({ addEventListener: (type, fn, capture) => { assert.equal(type, "keydown"); assert.equal(capture, true); handler = fn; } }, HTMLInputElement);
const press = (target, key = "Enter") => {
  const ev = { key, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  handler(ev);
  return ev;
};
const sw = new HTMLInputElement("sw small");
let ev = press(sw);
assert.equal(sw.clicks, 1);
assert.ok(ev.prevented && ev.stopped, "Enter does not reach a form or a sheet behind");
press(sw, " ");
assert.equal(sw.clicks, 1, "Space stays the checkbox's own");
const off = new HTMLInputElement("sw", true);
ev = press(off);
assert.equal(off.clicks, 0);
assert.ok(!ev.prevented);
const field = new HTMLInputElement("field");
press(field);
assert.equal(field.clicks, 0);
assert.ok(!press({ classList: { contains: () => true } }).prevented, "not an input");

console.log(`switches: ok (${n})`);
