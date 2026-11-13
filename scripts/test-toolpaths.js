// node scripts/test-toolpaths.js — the slice preview's toolpath buffer
// (gcode.rs encode → viewer.js decodeGcode), version 4: positions
// quantized in a box, a byte per attribute, per-layer ends and tops.
const assert = require("assert");
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../ui/viewer.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
// decodeGcode as written, with the constants it reads.
const code = [
  cut("const DEFAULT_WIDTH", "/* The toolpath buffer's"),
  cut("const FEATURES = [", "];") + "];",
  cut("const SEG_ATTRS", "/* Plain lines"),
  cut("const PATH_VS", "const PATH_FS"),
  cut("const RIB_VS", "const RIB_FS"),
  cut("function decodeGcode(buf)", "\n/* Color of a head"),
].join("\n");
const ctx = {};
vm.runInNewContext(code + "\nthis.decodeGcode = decodeGcode; this.PATH_VS = PATH_VS; this.RIB_VS = RIB_VS;", ctx);

// A buffer as gcode.rs writes it: two layers, two extrusions (inner wall
// on T0, outer wall on T2), a box from (10, 20, 0.2) spanning 100 × 50 × 0.2.
function buffer({ flags = 1, widths = [45, 0], heights = [16, 8] } = {}) {
  const n = 2, layers = 2;
  const pos = 68 + layers * 8;
  const b = new ArrayBuffer(pos + n * 16 + 1 + 2 * 4), dv = new DataView(b), u8 = new Uint8Array(b);
  u8.set([..."3MFG"].map((c) => c.charCodeAt(0)), 0);
  dv.setUint8(4, 4);
  dv.setUint8(5, flags);
  dv.setUint16(6, (1 << 1) | (1 << 2), true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, layers, true);
  [10, 20, 0.2, 110, 70, 0.4, 10, 20, 0.2, 100, 50, 0.2].forEach((v, i) => dv.setFloat32(16 + i * 4, v, true));
  dv.setUint16(64, (1 << 0) | (1 << 2), true);
  [1, 2].forEach((v, i) => dv.setUint32(68 + i * 4, v, true));
  [0.2, 0.4].forEach((v, i) => dv.setFloat32(68 + layers * 4 + i * 4, v, true));
  // Quantized ends: (10,20,0.2)→(110,20,0.2), then (110,20,0.4)→(110,70,0.4).
  [0, 0, 0, 65535, 0, 0, 65535, 0, 65535, 65535, 65535, 65535].forEach((v, i) => dv.setUint16(pos + i * 2, v, true));
  u8.set([2, 1], pos + n * 12);
  u8.set([0, 2], pos + n * 13);
  u8.set(widths, pos + n * 14);
  u8.set(heights, pos + n * 15);
  u8.set([2, 1, 255, 255, 255, 0, 0, 0, 0], pos + n * 16);
  return b;
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
const plain = (x) => JSON.parse(JSON.stringify(x));

const b = buffer();
const d = ctx.decodeGcode(b);
assert.strictEqual(d.n, 2);
assert.strictEqual(d.layers, 2);
assert.strictEqual(d.simplified, true);
assert.strictEqual(d.travel, false);
assert.deepStrictEqual(plain([...d.ends]), [1, 2]);
near(d.layerZ[1], 0.4);
assert.deepStrictEqual(plain(d.feats), [1, 2], "outer and inner wall");
assert.deepStrictEqual(plain(d.tools), [0, 2]);
near(d.origin[0], 10);
near(d.span[1], 50);
near(d.max[2], 0.4);
// The segments: the very bytes after the per-layer arrays, not a copy.
assert.strictEqual(d.segs.buffer, b);
assert.strictEqual(d.segs.byteOffset, 68 + 16);
assert.strictEqual(d.segs.length, 32);
// The small arrays are copies: the buffer can go once on the GPU.
assert.notStrictEqual(d.ends.buffer, b);
assert.notStrictEqual(d.layerZ.buffer, b);
assert.deepStrictEqual(plain(d.fileColors), [[255, 255, 255], null], "the colors after the segments");
// Travel moves only.
assert.strictEqual(ctx.decodeGcode(buffer({ flags: 2 })).travel, true);
// An older buffer is refused (the viewer says the file cannot be read).
const old = buffer();
new DataView(old).setUint8(4, 3);
assert.throws(() => ctx.decodeGcode(old), /unexpected toolpath format/);

// The shaders read that layout: quantized ends in the box, bytes for the
// rest, colors from the palette; the ribbons keep their cross-section
// (width × height, as Snapmaker Orca draws them) and the eye.
for (const vs of [ctx.PATH_VS, ctx.RIB_VS]) {
  assert.ok(vs.startsWith("#version 300 es\n"), "the version first");
  for (const k of ["in vec3 aA;", "in uint aFeat;", "in uint aH;", "uOrigin + q * uSpan", "texelFetch(uPal", "0.42", "0.005"]) {
    assert.ok(vs.includes(k), k);
  }
}
for (const k of ["uniform vec3 uEye;", "- u * hh", "segHeight()"]) assert.ok(ctx.RIB_VS.includes(k), k);
assert.ok(ctx.PATH_VS.includes("gl_VertexID == 0 ? aA : aB"), "one instance per line");

console.log("toolpaths: ok");
