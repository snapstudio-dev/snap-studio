// node scripts/test-ia-list.js — the AI conversation list: search, filters, sort, groups.
const assert = require("assert");
const L = require("../ui/ia-list.js");

// Monday 19 October 2026, 15:00 local time.
const now = new Date(2026, 9, 19, 15, 0, 0).getTime();
const at = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime() / 1000;

const list = [
  { id: "a", title: "Support d'écran", prompt: "plus large", source_name: "support.3mf", kind: "", engine: "local", created_at: at(1), updated_at: at(19, 9), version: 2, saved: "/x/support-1.3mf" },
  { id: "b", title: "Pièce de rechange", prompt: "a hook", source_name: "", kind: "create", engine: "container", created_at: at(18), updated_at: at(18, 23), version: 0, dest_dir: "/Users/me/Modèles" },
  { id: "c", title: "bracket", prompt: "", source_name: "bracket.3mf", kind: "", engine: "local", created_at: at(15), updated_at: at(14), version: 1 },
  { id: "d", title: "Vase", prompt: "spiral", source_name: "", kind: "create", engine: "local", created_at: at(2), updated_at: at(2), version: 3 },
];

// Search: case, accents, several words, the request, the source, the folder.
const ids = (q, f) => list.filter((c) => L.iaMatches(c, q, f)).map((c) => c.id);
assert.deepEqual(ids(""), ["a", "b", "c", "d"]);
assert.deepEqual(ids("PIECE"), ["b"]);
assert.deepEqual(ids("ecran large"), ["a"]);
assert.deepEqual(ids("ecran hook"), []);
assert.deepEqual(ids("bracket.3mf"), ["c"]);
assert.deepEqual(ids("modeles"), ["b"]);
assert.deepEqual(ids("spiral"), ["d"]);

// Filters, alone and together with the search.
assert.deepEqual(ids("", { kind: "create" }), ["b", "d"]);
assert.deepEqual(ids("", { kind: "edit" }), ["a", "c"]);
assert.deepEqual(ids("", { state: "saved" }), ["a"]);
assert.deepEqual(ids("", { state: "pending" }), ["b", "c", "d"]);
assert.deepEqual(ids("", { engine: "container" }), ["b"]);
assert.deepEqual(ids("", { engine: "local", kind: "create" }), ["d"]);
assert.deepEqual(ids("vase", { kind: "edit" }), []);

// Sorts: activity, creation, title; the input is left alone.
assert.deepEqual(L.iaSortList(list).map((c) => c.id), ["a", "b", "c", "d"]);
assert.deepEqual(L.iaSortList(list, "created").map((c) => c.id), ["b", "c", "d", "a"]);
const fr = (x, y) => x.localeCompare(y, "fr", { sensitivity: "base" });
assert.deepEqual(L.iaSortList(list, "title", fr).map((c) => c.id), ["c", "b", "a", "d"]);
assert.deepEqual(list.map((c) => c.id), ["a", "b", "c", "d"]);
// Same date: stable on the id.
const tie = [{ id: "z", updated_at: 5 }, { id: "y", updated_at: 5 }];
assert.deepEqual(L.iaSortList(tie).map((c) => c.id), ["y", "z"]);

// Groups by local calendar day.
assert.equal(L.iaGroupOf(at(19, 0), now), "today");
assert.equal(L.iaGroupOf(at(18, 23), now), "yesterday");
assert.equal(L.iaGroupOf(at(18, 0), now), "yesterday");
assert.equal(L.iaGroupOf(at(17, 23), now), "week");
assert.equal(L.iaGroupOf(at(12, 0), now), "week");
assert.equal(L.iaGroupOf(at(11, 23), now), "earlier");
// Shortly after midnight, yesterday evening is yesterday, not today.
assert.equal(L.iaGroupOf(at(18, 23), new Date(2026, 9, 19, 0, 5).getTime()), "yesterday");

const g = L.iaGroupList(list, { now });
assert.deepEqual(g.map((x) => [x.key, x.items.map((c) => c.id)]), [["today", ["a"]], ["yesterday", ["b"]], ["week", ["c"]], ["earlier", ["d"]]]);
// By creation date, the groups follow it.
assert.deepEqual(L.iaGroupList(list, { now, sort: "created" }).map((x) => [x.key, x.items.map((c) => c.id)]), [["yesterday", ["b"]], ["week", ["c"]], ["earlier", ["d", "a"]]]);
// By title: one group without a heading; nothing left: no group.
assert.deepEqual(L.iaGroupList(list, { now, sort: "title", compare: fr }).map((x) => x.key), [null]);
assert.deepEqual(L.iaGroupList(list, { now, query: "nothing" }), []);
assert.deepEqual(L.iaGroupList(list, { now, query: "nothing", sort: "title" }), []);
// Search and filters inside the groups.
assert.deepEqual(L.iaGroupList(list, { now, filters: { kind: "create" } }).map((x) => x.key), ["yesterday", "earlier"]);

// Badges, the most pressing first.
assert.equal(L.iaStatusOf(list[0]), "saved");
assert.equal(L.iaStatusOf(list[1]), "draft");
assert.equal(L.iaStatusOf(list[2]), "pending");
assert.equal(L.iaStatusOf(list[2], { failed: true }), "error");
assert.equal(L.iaStatusOf(list[0], { running: true, failed: true }), "running");

// Keyboard.
assert.equal(L.iaMove(-1, 4, "ArrowDown"), 0);
assert.equal(L.iaMove(-1, 4, "ArrowUp"), 3);
assert.equal(L.iaMove(3, 4, "ArrowDown"), 3);
assert.equal(L.iaMove(0, 4, "ArrowUp"), 0);
assert.equal(L.iaMove(2, 4, "Home"), 0);
assert.equal(L.iaMove(0, 4, "End"), 3);
assert.equal(L.iaMove(1, 4, "x"), -1);
assert.equal(L.iaMove(0, 0, "ArrowDown"), -1);

// Titles.
assert.equal(L.iaCleanTitle("  Mon   support \n v2 "), "Mon support v2");
assert.equal(L.iaCleanTitle("   "), "");
assert.equal([...L.iaCleanTitle("é".repeat(200))].length, 120);

// Save is per version: the file of the version shown, none for the others.
// (JSON gives the version numbers as strings; indexing by number finds them.)
const sv = { version: 3, saved_versions: JSON.parse('{"1": "/f/a.3mf", "3": "/f/a-2.3mf"}') };
assert.equal(L.iaSavedPath(sv), "/f/a-2.3mf");
assert.equal(L.iaSavedPath({ ...sv, version: 2 }), null);
assert.equal(L.iaSavedPath({ ...sv, version: 1 }), "/f/a.3mf");
assert.equal(L.iaSavedPath({ version: 1, saved: "/old.3mf" }), null, "saved before versions were tracked: not known");
assert.equal(L.iaSavedPath(null), null);

console.log("ia-list: ok");
