// node scripts/test-toolpaths.js — the slice preview's toolpath buffer
// (gcode.rs encode → viewer.js decodeGcode): version 3 carries each
// extrusion's height, version 2 (no height) still decodes.
const assert = require("assert");
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../ui/viewer.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
// decodeGcode as written, with the constants it reads.
const code = [cut("const DEFAULT_WIDTH", "/* Feature keys"), cut("const FEATURES = [", "];") + "];", cut("function decodeGcode(buf)", "\n/* Color of a head")].join("\n");
const ctx = {};
vm.runInNewContext(code + "\nthis.decodeGcode = decodeGcode;", ctx);

// A buffer as gcode.rs writes it: two extrusions on two layers, widths,
// heights (version 3), two colors.
function buffer(version, { widths = [45, 42], heights = [16, 8] } = {}) {
  const n = 2;
  const size = 40 + n * 24 + n * 4 + n + (version >= 3 ? n : 0) + 1 + 2 * 4;
  const b = new ArrayBuffer(size), dv = new DataView(b), u8 = new Uint8Array(b);
  u8.set([..."3MFG"].map((c) => c.charCodeAt(0)), 0);
  dv.setUint8(4, version);
  dv.setUint32(8, n, true);
  dv.setUint32(12, 2, true);
  const pos = [0, 0, 3.32, 10, 0, 3.32, 10, 0, 3.36, 10, 10, 3.36];
  pos.forEach((v, i) => dv.setFloat32(40 + i * 4, v, true));
  let o = 40 + n * 24;
  for (let i = 0; i < n; i++, o += 4) u8.set([i, 0, 1, i << 4], o);
  u8.set(widths, o);
  o += n;
  if (version >= 3) {
    u8.set(heights, o);
    o += n;
  }
  u8.set([2, 1, 255, 255, 255, 1, 0, 0, 0], o);
  return b;
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

let d = ctx.decodeGcode(buffer(3));
assert.strictEqual(d.out.e.feat.length, 2);
near(d.out.e.width[0], 0.45);
near(d.out.e.height[0], 0.08);
near(d.out.e.height[1], 0.04, "a sub-layer");
assert.deepStrictEqual(JSON.parse(JSON.stringify(d.fileColors)), [[255, 255, 255], [0, 0, 0]], "the colors after the heights");
// Version 2: no height (0, drawn round), the colors right after the widths.
d = ctx.decodeGcode(buffer(2));
assert.deepStrictEqual([...d.out.e.height], [0, 0]);
near(d.out.e.width[1], 0.42);
assert.deepStrictEqual(JSON.parse(JSON.stringify(d.fileColors)), [[255, 255, 255], [0, 0, 0]]);
// A height not known in version 3 stays 0; the width falls back too.
d = ctx.decodeGcode(buffer(3, { widths: [0, 42], heights: [0, 8] }));
near(d.out.e.height[0], 0);
near(d.out.e.width[0], 0.42);

// The ribbons' shader takes the height and the eye (one cross-section,
// width × height, as Snapmaker Orca draws them).
const vs = cut("const RIB_VS", "}`;");
for (const k of ["in float aH;", "uniform vec3 uEye;", "- u * hh"]) assert.ok(vs.includes(k), k);
assert.ok(!vs.includes("uPxPerMm"), "no longer sized in screen pixels by the width alone");

console.log("toolpaths: ok");
