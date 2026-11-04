// node scripts/test-stepper.js — number steppers.
const assert = require("assert");
const S = require("../ui/stepper-logic.js");

assert.strictEqual(S.stDecimals(1), 0);
assert.strictEqual(S.stDecimals("0.1"), 1);
assert.strictEqual(S.stDecimals(0.05), 2);
assert.strictEqual(S.stDecimals(1e-7), 7);
assert.strictEqual(S.stDecimals("10"), 0);

// Steps, rounded to the step: no floating-point tails.
assert.strictEqual(S.stStep("0.2", 1, { step: 0.1 }), "0.3");
assert.strictEqual(S.stStep("0.3", -1, { step: "0.1" }), "0.2");
assert.strictEqual(S.stStep("30", 1, { step: 1 }), "31");
assert.strictEqual(S.stStep("0.25", 1, { step: 0.1 }), "0.35", "a finer value keeps its decimals");
assert.strictEqual(S.stStep("100", 1, { step: 10, min: 1 }), "110");
// Bounds.
assert.strictEqual(S.stStep("1", -1, { step: 1, min: 1 }), "1");
assert.strictEqual(S.stStep("65535", 1, { step: 1, max: 65535 }), "65535");
assert.strictEqual(S.stStep("0", -1, { step: 1 }), "-1", "no min: negative allowed (compensations)");
assert.strictEqual(S.stStep("5", 1, { step: 1, min: "", max: "" }), "6", "empty bounds as an input gives them");
// Empty value: from min, else 0.
assert.strictEqual(S.stStep("", 1, { step: 10, min: 1 }), "1");
assert.strictEqual(S.stStep("", -1, { step: 0.1 }), "0");
assert.strictEqual(S.stStep("abc", 1, {}), "0");
// A bad step counts as 1.
assert.strictEqual(S.stStep("2", 1, { step: 0 }), "3");

// Whether a button can move the value.
assert.strictEqual(S.stCan("1", -1, { min: 1 }), false);
assert.strictEqual(S.stCan("1", 1, { min: 1 }), true);
assert.strictEqual(S.stCan("270", 1, { max: 270 }), false);
assert.strictEqual(S.stCan("", -1, { min: 1 }), true, "empty: a step sets a value");

console.log("stepper: ok");
