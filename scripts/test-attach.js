// node scripts/test-attach.js — files attached to an AI message.
const assert = require("assert");
const A = require("../ui/attach-logic.js");

// Kinds from the extension, any case, from a name or a path.
assert.strictEqual(A.attachKind("sketch.PNG"), "image");
assert.strictEqual(A.attachKind("photo.jpeg"), "image");
assert.strictEqual(A.attachKind("bracket.Stl"), "model");
assert.strictEqual(A.attachKind("C:\\Users\\me\\Desktop\\box.3MF"), "model");
assert.strictEqual(A.attachKind("/home/me/My Models/v2.box.stl"), "model");
for (const n of ["part.obj", "a.gcode", "notes.txt", "README", ".stl", "", null, "dir.stl/"]) {
  assert.strictEqual(A.attachKind(n), null, String(n));
}

// Where a drop goes: the sheet first, then the conversation shown.
assert.strictEqual(A.attachTarget({ sheetOpen: true, iaVisible: true, convOpen: true }), "sheet");
assert.strictEqual(A.attachTarget({ sheetOpen: true, iaVisible: false, convOpen: false }), "sheet", "the sheet opens from Files too");
assert.strictEqual(A.attachTarget({ sheetOpen: false, iaVisible: true, convOpen: true }), "chat");
assert.strictEqual(A.attachTarget({ sheetOpen: false, iaVisible: true, convOpen: false }), null, "the AI list: nowhere");
assert.strictEqual(A.attachTarget({ sheetOpen: false, iaVisible: false, convOpen: true }), null, "another view: Files' own drop");
assert.strictEqual(A.attachTarget(), null);

// A text/uri-list from a file manager.
assert.deepStrictEqual(
  A.pathsFromUriList("# copied\r\nfile:///home/me/My%20Models/box.stl\r\nfile:///home/me/caf%C3%A9.3mf\nhttps://example.com/a.stl\n\n"),
  ["/home/me/My Models/box.stl", "/home/me/café.3mf"]
);
assert.deepStrictEqual(A.pathsFromUriList("file:///C:/Users/me/box.stl"), ["C:/Users/me/box.stl"], "Windows drive");
assert.deepStrictEqual(A.pathsFromUriList("file://localhost/tmp/a.stl"), ["/tmp/a.stl"]);
assert.deepStrictEqual(A.pathsFromUriList("file://server/share/a.stl"), [], "another machine's file");
assert.deepStrictEqual(A.pathsFromUriList("file:///tmp/bad%E0.stl"), [], "undecodable");
assert.deepStrictEqual(A.pathsFromUriList(""), []);
assert.deepStrictEqual(A.pathsFromUriList(undefined), []);

// Room left: images and models counted apart.
const img = { name: "a.png", url: "data:" };
const model = { kind: "model", name: "b.stl" };
assert.strictEqual(A.attachRoom([], "image"), 5);
assert.strictEqual(A.attachRoom([img, img, model], "image"), 3);
assert.strictEqual(A.attachRoom([img, model, model], "model"), 1);
assert.strictEqual(A.attachRoom([model, model, model], "model"), 0);
assert.strictEqual(A.ATTACH_MAX_MODELS, 3);

// Messages for refused files.
assert.deepStrictEqual(A.attachRejectMessage({ name: "a.obj", reason: "type" }), ["chat.unsupported_file", { name: "a.obj" }]);
assert.deepStrictEqual(A.attachRejectMessage({ name: "a.stl", reason: "size", max: 209715200 }), ["chat.file_too_big", { name: "a.stl", max: 209715200 }]);
assert.deepStrictEqual(A.attachRejectMessage({ name: "a.3mf", reason: "tris", max: 8000000 }), ["chat.model_tris", { name: "a.3mf", max: 8000000 }]);
assert.deepStrictEqual(A.attachRejectMessage({ name: "a.stl", reason: "unreadable" }), ["chat.model_unreadable", { name: "a.stl" }]);
assert.deepStrictEqual(A.attachRejectMessage({ name: "a.png", reason: "unreadable" }), ["chat.bad_image", { name: "a.png" }]);

// Units.
assert.ok(A.attachOddScale([0.4, 0.2, 0.1]), "meters read as millimeters");
assert.ok(A.attachOddScale([2540, 100, 10]), "too big for any printer");
assert.ok(!A.attachOddScale([40, 20, 10]));
assert.ok(A.attachOddScale([]), "no size: say so");
assert.deepStrictEqual(A.attachDims([40.04, 19.96, 10]), [40, 20, 10]);
assert.deepStrictEqual(A.attachDims([1.25, 0.04, 3.333]), [1.3, 0.04, 3.3]);
assert.deepStrictEqual(A.attachDims([0.0412, 0.02, 0]), [0.041, 0.02, 0], "a model in meters still reads");

// The extensions offered by the dialog are the ones the app accepts.
assert.deepStrictEqual(A.ATTACH_MODEL_EXT, ["stl", "3mf"]);

console.log("attach: ok");
