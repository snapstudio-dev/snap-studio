// The Explore pill's tone (ui/nav-tone.js): colors read, blended and
// weighed as the site's view does, on color samples.
const assert = require("assert");
const T = require("../ui/nav-tone.js");

// Colors as computed styles and theme-color give them.
assert.deepStrictEqual(T.parseColor("rgb(255, 255, 255)"), [255, 255, 255, 1]);
assert.deepStrictEqual(T.parseColor("rgba(0, 0, 0, 0.5)"), [0, 0, 0, 0.5]);
assert.deepStrictEqual(T.parseColor("rgb(18 18 18 / 50%)"), [18, 18, 18, 0.5]);
assert.deepStrictEqual(T.parseColor("#fff"), [255, 255, 255, 1]);
assert.deepStrictEqual(T.parseColor("#1c1c1e"), [28, 28, 30, 1]);
assert.deepStrictEqual(T.parseColor("#00000080"), [0, 0, 0, 128 / 255]);
assert.deepStrictEqual(T.parseColor("transparent"), [0, 0, 0, 0]);
for (const bad of ["", "navy", "hsl(0 0% 0%)", "#12", "rgb(1, 2)", null, undefined]) assert.strictEqual(T.parseColor(bad), null, String(bad));

// Layers, top first, over the canvas.
const white = [255, 255, 255, 1];
assert.deepStrictEqual(T.composite([], white), [255, 255, 255]);
assert.deepStrictEqual(T.composite([[0, 0, 0, 1], [255, 0, 0, 1]], white), [0, 0, 0], "an opaque top hides the rest");
assert.deepStrictEqual(T.composite([[0, 0, 0, 0.5]], white).map(Math.round), [128, 128, 128]);
// A dark veil over a white page: light, then undecided, then dark.
assert.strictEqual(T.toneOf(T.composite([[28, 28, 30, 0.08]], white)), "light");
assert.strictEqual(T.toneOf(T.composite([[28, 28, 30, 0.25]], white)), "mid");
assert.strictEqual(T.toneOf(T.composite([[28, 28, 30, 0.6]], white)), "dark");
// A see-through header over a dark canvas stays dark.
assert.strictEqual(T.toneOf(T.composite([[255, 255, 255, 0.08]], [18, 18, 18, 1])), "dark");

// WCAG luminance and the thresholds with a gap.
assert.strictEqual(T.luminance([0, 0, 0]), 0);
assert.strictEqual(T.luminance([255, 255, 255]), 1);
assert.ok(Math.abs(T.luminance([128, 128, 128]) - 0.2159) < 1e-3);
assert.strictEqual(T.toneOf([255, 255, 255]), "light");
assert.strictEqual(T.toneOf([243, 243, 245]), "light", "Printables' light grey");
assert.strictEqual(T.toneOf([18, 18, 18]), "dark");
assert.strictEqual(T.toneOf([32, 33, 36]), "dark", "a dark site's header");
assert.strictEqual(T.toneOf([185, 185, 185]), "mid", "mid grey: undecided");
assert.strictEqual(T.toneOf([0, 120, 215]), "dark", "a saturated blue bar");
assert.strictEqual(T.toneOf([255, 214, 10]), "light", "a yellow bar");

// A logo or an icon under a point: looked under; a banner: unread.
assert.strictEqual(T.smallPicture(48, 48), true);
assert.strictEqual(T.smallPicture(140, 32), true, "a wordmark");
assert.strictEqual(T.smallPicture(1200, 400), false, "a banner");
assert.strictEqual(T.smallPicture(200, 120), false, "a cover");

// Fallbacks, in order: theme-color, body, html, color-scheme.
assert.strictEqual(T.fallbackTone({ themeColor: [0, 0, 0, 1], body: white }), "dark", "theme-color first");
assert.strictEqual(T.fallbackTone({ themeColor: null, body: [20, 20, 20, 1], html: white }), "dark", "then <body>");
assert.strictEqual(T.fallbackTone({ body: [0, 0, 0, 0], html: [250, 250, 250, 1] }), "light", "a transparent <body> is skipped");
assert.strictEqual(T.fallbackTone({ themeColor: [185, 185, 185, 1], html: [10, 10, 10, 1] }), "dark", "a mid theme-color tells nothing");
assert.strictEqual(T.fallbackTone({ colorScheme: "dark" }), "dark");
assert.strictEqual(T.fallbackTone({ colorScheme: "light dark" }), null, "both: the page's own choice is unknown");
assert.strictEqual(T.fallbackTone({}), null);

// The majority of the points; unreadable points take the fallback's tone;
// otherwise the current tone stays.
assert.strictEqual(T.decide(["dark", "dark", "light"], null, null), "dark");
assert.strictEqual(T.decide(["light", "light", "light"], null, "dark"), "light");
assert.strictEqual(T.decide(["dark", "light", "mid"], null, "light"), "light", "no majority: unchanged");
assert.strictEqual(T.decide(["mid", "mid", "mid"], null, "dark"), "dark", "a mid-grey header keeps the tone");
assert.strictEqual(T.decide([null, null, "light"], "dark", null), "dark", "a picture under two points: the page's color");
assert.strictEqual(T.decide([null, null, null], null, "light"), "light", "nothing readable: unchanged");
assert.strictEqual(T.decide([null, null, null], null, null), null, "nothing yet: none");
assert.strictEqual(T.POINTS.length, 3);

console.log("navtone: ok");
