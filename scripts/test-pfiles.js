// node scripts/test-pfiles.js — a printer's files: names, dates, search, sort, what can be deleted.
const assert = require("assert");
const L = require("../ui/pfiles-logic.js");

// Names: folder, extension and Snap Studio's "-a1b2c3" go; a word stays.
assert.equal(L.pflName("Cube-3f9a0c.gcode"), "Cube");
assert.equal(L.pflName("sub/dir/Benchy_PLA.gcode"), "Benchy_PLA");
assert.equal(L.pflName("Maison-facade.gcode"), "Maison-facade");
assert.equal(L.pflName("Vase.3MF"), "Vase");
assert.equal(L.pflName("noext"), "noext");

// Video dates: from the name when it carries one, else the file's date.
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
assert.equal(L.pflVideoDate({ path: "20260107114733.mp4", modified: 1 }), at(2026, 1, 7, 11, 47, 33));
assert.equal(L.pflVideoDate({ path: "timelapse_Cube-3f9a0c_20261019_1530.mp4", modified: 1 }), at(2026, 10, 19, 15, 30));
assert.equal(L.pflVideoDate({ path: "video.mp4", modified: 42 }), 42);
assert.equal(L.pflVideoDate({ path: "20261399999999.mp4", modified: 7 }), 7);

// Video titles: the print for moonraker-timelapse's names.
assert.equal(L.pflVideoTitle({ path: "timelapse_Cube-3f9a0c_20261019_1530.mp4" }), "Cube");
assert.equal(L.pflVideoTitle({ path: "sub/20260107114733.mp4" }), "20260107114733");

const files = [
  { root: "gcodes", path: "Support écran-1a2b3c.gcode", size: 300, modified: 30, writable: true, meta: { estimated_time: 3600, filament_types: ["PLA"], tools: [0] } },
  { root: "gcodes", path: "bracket.gcode", size: 100, modified: 10, writable: true, meta: { estimated_time: null, filament_types: ["PETG", "PLA"], filament_name: "Bambu PETG", tools: [0, 1] } },
  { root: "gcodes", path: "dir/Vase.gcode", size: 200, modified: 20, writable: true, meta: { estimated_time: 600, tools: [] } },
];
const names = (l) => l.map((f) => L.pflName(f.path));

// Search: accents and case ignored, all words, material and folder.
const find = (q) => names(files.filter((f) => L.pflMatches(f, q)));
assert.deepEqual(find(""), ["Support écran", "bracket", "Vase"]);
assert.deepEqual(find("ECRAN"), ["Support écran"]);
assert.deepEqual(find("petg"), ["bracket"]);
assert.deepEqual(find("bambu"), ["bracket"]);
assert.deepEqual(find("dir vase"), ["Vase"]);
assert.deepEqual(find("vase petg"), []);

// Sort: by date (newest first), name, size, duration (unknown last both ways).
assert.deepEqual(names(L.pflSort(files, "date", true)), ["Support écran", "Vase", "bracket"]);
assert.deepEqual(names(L.pflSort(files, "name", false)), ["bracket", "Support écran", "Vase"]);
assert.deepEqual(names(L.pflSort(files, "size", true)), ["Support écran", "Vase", "bracket"]);
assert.deepEqual(names(L.pflSort(files, "duration", true)), ["Support écran", "Vase", "bracket"]);
assert.deepEqual(names(L.pflSort(files, "duration", false)), ["Vase", "Support écran", "bracket"]);
assert.notEqual(L.pflSort(files), files, "a copy");

// Videos sort by their measured duration.
const vids = [
  { root: "camera", path: "a.mp4", size: 1, modified: 1 },
  { root: "camera", path: "b.mp4", size: 1, modified: 2 },
  { root: "camera", path: "c.mp4", size: 1, modified: 3 },
];
const durs = new Map([["camera/a.mp4", 90], ["camera/c.mp4", 30]]);
assert.deepEqual(L.pflSort(vids, "duration", true, durs).map((v) => v.path), ["a.mp4", "c.mp4", "b.mp4"]);
assert.equal(L.pflDuration(vids[0], durs), 90);
assert.equal(L.pflDuration(files[0], durs), 3600);

// Summary.
assert.deepEqual(L.pflSummary(files, { total: 1000, used: 400, free: 600 }), { count: 3, bytes: 600, free: 600, total: 1000 });
assert.deepEqual(L.pflSummary([], null), { count: 0, bytes: 0, free: null, total: null });

// Filament dots: one per tool, grams per tool, the total for a single one.
const meta = { tools: [0, 2], filament_types: ["PLA", "PETG", "TPU"], filament_colors: ["#ff0000", "#00ff00", "#0000ff"], filament_weights: [12.5, 0, 3], filament_weight_total: 15.5 };
assert.deepEqual(L.pflFilaments(meta), [
  { tool: 0, color: "#ff0000", type: "PLA", grams: 12.5 },
  { tool: 2, color: "#0000ff", type: "TPU", grams: 3 },
]);
assert.deepEqual(L.pflFilaments({ tools: [], filament_types: ["PLA"], filament_colors: [], filament_weights: [], filament_weight_total: 8 }), [{ tool: 0, color: null, type: "PLA", grams: 8 }]);
assert.deepEqual(L.pflFilaments(null), []);

// What the send sheet and the spool check get.
assert.deepEqual(L.pflSendStats(meta), { tools: [0, 2], filament_types: ["PLA", "PETG", "TPU"], filament_colors: ["#ff0000", "#00ff00", "#0000ff"], print_time_s: null, filament_g: 15.5 });
assert.deepEqual(L.pflSendStats(null).tools, [0]);

// Deleting: never the file being printed, never in a read-only root.
assert.deepEqual(L.pflCanChange(files[0], "Support écran-1a2b3c.gcode"), { ok: false, reason: "printing" });
assert.deepEqual(L.pflCanChange(files[0], "/Support écran-1a2b3c.gcode"), { ok: false, reason: "printing" });
assert.deepEqual(L.pflCanChange(files[1], "Support écran-1a2b3c.gcode"), { ok: true, reason: null });
assert.deepEqual(L.pflCanChange(files[1], null), { ok: true, reason: null });
// A read-only root does not hide the delete: the printer is asked anyway.
assert.deepEqual(L.pflCanChange({ root: "camera", path: "a.mp4", writable: false }, null), { ok: true, reason: null });
assert.deepEqual(L.pflCanChange({ root: "camera", path: "Support écran-1a2b3c.gcode", writable: true }, "Support écran-1a2b3c.gcode"), { ok: true, reason: null });

// Player: neighbours, speeds, clock.
assert.equal(L.pflNeighbor(0, 3, -1), -1);
assert.equal(L.pflNeighbor(0, 3, 1), 1);
assert.equal(L.pflNeighbor(2, 3, 1), -1);
assert.equal(L.pflNextSpeed(1), 1.5);
assert.equal(L.pflNextSpeed(4), 0.5);
assert.equal(L.pflClock(0), "0:00");
assert.equal(L.pflClock(65.9), "1:05");
assert.equal(L.pflClock(3725), "1:02:05");

// Selection.
let s = new Set();
s = L.pflToggle(s, "a");
s = L.pflToggle(s, "b");
s = L.pflToggle(s, "a");
assert.deepEqual([...s], ["b"]);
assert.deepEqual([...L.pflToggle(s, "b", true)], ["b"]);

// Deleting: one batch per root, in order of first appearance, a video's
// picture right after it. Two roots' videos are never sent under one root.
assert.deepEqual(
  L.pflDeleteBatches([
    { root: "camera", path: "20260107114733.mp4", thumb: "20260107114733.jpg" },
    { root: "timelapse", path: "timelapse_Cube_20261019_1530.mp4" },
    { root: "camera", path: "20260108120000.mp4", thumb: null },
    { root: "timelapse", path: "sub/x.mp4", thumb: "sub/x.png" },
  ]),
  [
    { root: "camera", paths: ["20260107114733.mp4", "20260107114733.jpg", "20260108120000.mp4"] },
    { root: "timelapse", paths: ["timelapse_Cube_20261019_1530.mp4", "sub/x.mp4", "sub/x.png"] },
  ]
);
assert.deepEqual(L.pflDeleteBatches([{ root: "gcodes", path: "a.gcode" }]), [{ root: "gcodes", paths: ["a.gcode"] }]);
assert.deepEqual(L.pflDeleteBatches([]), []);

// Right-click: a picked file stands for every picked one, in list order.
{
  const order = ["gcodes/a", "gcodes/b", "gcodes/c", "gcodes/d"];
  const picked = new Set(["gcodes/c", "gcodes/a", "gcodes/b"]);
  assert.deepEqual(L.pflMenuTargets(true, picked, "gcodes/b", order), ["gcodes/a", "gcodes/b", "gcodes/c"]);
  // A file not picked: itself alone, and the picks stay as they were.
  assert.deepEqual(L.pflMenuTargets(true, picked, "gcodes/d", order), ["gcodes/d"]);
  assert.deepEqual([...picked], ["gcodes/c", "gcodes/a", "gcodes/b"]);
  // Outside Select mode, the clicked file only, picks or not.
  assert.deepEqual(L.pflMenuTargets(false, picked, "gcodes/b", order), ["gcodes/b"]);
  // Nothing picked.
  assert.deepEqual(L.pflMenuTargets(true, new Set(), "gcodes/a", order), ["gcodes/a"]);
}

// Shift-click: from the anchor to the clicked key, either way, in list order.
{
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(L.pflRangeKeys(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(L.pflRangeKeys(order, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(L.pflRangeKeys(order, "gone", "c"), ["c"], "an anchor no longer listed");
  assert.deepEqual(L.pflRangeKeys(order, "a", "gone"), []);
}

// Ctrl/Cmd and Shift-click outside Select mode, as in the Files view.
{
  const order = ["a", "b", "c", "d", "e"];
  const none = { picked: new Set(), sel: null, anchor: null };
  const pick = (st, k, mods) => {
    const r = L.pflPickClick(st, k, order, mods);
    return { picked: [...r.picked], sel: r.sel, anchor: r.anchor, next: r };
  };
  // Plain click: one file, the picks gone, the anchor there.
  assert.deepEqual(pick({ picked: new Set(["a", "b"]), sel: null, anchor: "a" }, "c").next, { picked: new Set(), sel: "c", anchor: "c" });
  // Ctrl-click adds to the file already selected.
  let r = pick({ picked: new Set(), sel: "b", anchor: "b" }, "d", { toggle: true });
  assert.deepEqual([r.picked, r.sel, r.anchor], [["b", "d"], null, "d"]);
  // Again on a picked one: out; down to one file, back to a single selection.
  r = pick(r.next, "b", { toggle: true });
  assert.deepEqual([r.picked, r.sel, r.anchor], [[], "d", "b"]);
  // Ctrl-click with nothing selected: that file alone.
  r = pick(none, "c", { toggle: true });
  assert.deepEqual([r.picked, r.sel], [[], "c"]);
  // Shift-click: the range from the selected file, which stays the anchor.
  r = pick({ picked: new Set(), sel: "b", anchor: null }, "d", { range: true });
  assert.deepEqual([r.picked, r.sel, r.anchor], [["b", "c", "d"], null, "b"]);
  // A second Shift-click replaces the range from the same anchor.
  r = pick(r.next, "a", { range: true });
  assert.deepEqual([r.picked, r.anchor], [["a", "b"], "b"]);
  // Shift-click on the anchor itself: one file.
  r = pick({ picked: new Set(), sel: "c", anchor: "c" }, "c", { range: true });
  assert.deepEqual([r.picked, r.sel], [[], "c"]);
  // A selected file hidden by a search does not start the picks.
  r = pick({ picked: new Set(), sel: "hidden", anchor: "hidden" }, "c", { toggle: true });
  assert.deepEqual([r.picked, r.sel], [[], "c"]);
  // The state passed in is never changed.
  const st = { picked: new Set(["a", "b"]), sel: null, anchor: "a" };
  L.pflPickClick(st, "c", order, { toggle: true });
  assert.deepEqual([...st.picked], ["a", "b"]);
}

// prn: addresses: a space is %20 (Rust decodes it; a "+" would stay "+").
assert.equal(L.pflPrnQuery("p 1", "gcodes", ".thumbs/Support écran+1.png"), "/f?id=p%201&root=gcodes&p=.thumbs%2FSupport%20%C3%A9cran%2B1.png");

console.log("pfiles: ok");
