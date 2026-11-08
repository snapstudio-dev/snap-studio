// node scripts/test-camera.js — the camera's picture in its full-size box.
const assert = require("assert");
const C = require("../ui/camera-logic.js");

// A box wider than the picture: bands left and right.
assert.deepStrictEqual(C.camPictureRect(1600, 900, 640, 480), { x: 200, y: 0, w: 1200, h: 900 });
// Taller than the picture: bands above and below.
assert.deepStrictEqual(C.camPictureRect(800, 1000, 1280, 720), { x: 0, y: 275, w: 800, h: 450 });
// Same shape: no band.
assert.deepStrictEqual(C.camPictureRect(1280, 720, 640, 360), { x: 0, y: 0, w: 1280, h: 720 });
// No frame yet (naturalWidth 0) or an empty box: the whole box.
assert.deepStrictEqual(C.camPictureRect(800, 600, 0, 0), { x: 0, y: 0, w: 800, h: 600 });
assert.deepStrictEqual(C.camPictureRect(0, 0, 640, 480), { x: 0, y: 0, w: 0, h: 0 });
assert.deepStrictEqual(C.camPictureRect(800, 600, undefined, 480), { x: 0, y: 0, w: 800, h: 600 });

// On the picture or beside it.
const r = C.camPictureRect(1600, 900, 640, 480);
assert.strictEqual(C.camInside(r, 800, 450), true, "centre");
assert.strictEqual(C.camInside(r, 100, 450), false, "left band");
assert.strictEqual(C.camInside(r, 1500, 450), false, "right band");
assert.strictEqual(C.camInside(r, 200, 0), true, "edge counts as the picture");
assert.strictEqual(C.camInside(C.camPictureRect(800, 600, 0, 0), 5, 5), true, "no frame: the whole box");

// Where the box goes (camera.js camPlace).
const home = { id: "a" };
assert.strictEqual(C.camHostOf({ on: false, home }), "home", "off: it waits at home, hidden");
assert.strictEqual(C.camHostOf({ on: false, home: null }), null, "off and no screen: nowhere");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home, full: false, pinned: false }), "home");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home, full: true, pinned: false }), "full", "full size first");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home, full: false, pinned: true }), "home", "pinned, on its own screen: there, not the window");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home: { id: "b" }, pinned: true }), "pip", "another printer shown: the window");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home: null, pinned: true }), "pip", "no screen: the window");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home: { id: "b" }, pinned: false }), null, "not pinned, another printer: the stream ends");
assert.strictEqual(C.camHostOf({ on: true, id: "a", home: null, pinned: false }), null);

// Delays between two reads.
assert.strictEqual(C.camRetryDelay(0), 200, "right after a frame");
assert.strictEqual(C.camRetryDelay(1), 1000);
assert.strictEqual(C.camRetryDelay(2), 1000);
assert.strictEqual(C.camRetryDelay(3), 3000, "held to be gone");
assert.strictEqual(C.camRetryDelay(9), 3000);
assert.strictEqual(C.camRetryDelay(1, true), 3000, "the status said the printer is gone");
assert.strictEqual(C.camRetryDelay(0, true), 200, "a frame came: the status was wrong");

console.log("camera: ok");
