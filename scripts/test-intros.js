// Feature introductions (ui/intros-logic.js): which to show, where a move lands.
// node scripts/test-intros.js
const assert = require("assert");
const { introsFor, introsLand } = require("../ui/intros-logic.js");

const intro = (id, available, seen) => ({ id, available: () => available, seen: () => seen });
const list = [intro("snappy", true, false), intro("analytics", false, false), intro("next", true, true)];
const ids = (l) => l.map((i) => i.id);

// The welcome assistant: every one available, seen or not.
assert.deepStrictEqual(ids(introsFor("welcome", list)), ["snappy", "next"]);
// The notice: available and never seen.
assert.deepStrictEqual(ids(introsFor("notice", list)), ["snappy"]);
assert.deepStrictEqual(ids(introsFor("notice", [intro("a", true, true)])), []);
// The preview: all of them.
assert.deepStrictEqual(ids(introsFor("notice", list, { preview: true })), ["snappy", "analytics", "next"]);

// Steps 0..7, step 6 passed: forward from 5 lands on 7, back from 7 on 5.
const skip6 = (n) => n === 6;
assert.strictEqual(introsLand(6, 5, 7, skip6), 7);
assert.strictEqual(introsLand(6, 7, 7, skip6), 5);
assert.strictEqual(introsLand(3, 2, 7, skip6), 3);
// Two passed in a row, and the bounds.
const skip56 = (n) => n === 5 || n === 6;
assert.strictEqual(introsLand(5, 4, 7, skip56), 7);
assert.strictEqual(introsLand(6, 7, 7, skip56), 4);
assert.strictEqual(introsLand(9, 7, 7, skip6), 7);
assert.strictEqual(introsLand(-1, 0, 7, skip6), 0);
console.log("intros: ok");
