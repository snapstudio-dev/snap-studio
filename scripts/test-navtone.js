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

// A gradient background: its colors are in the computed style.
assert.deepStrictEqual(T.gradientColor("linear-gradient(rgb(20, 20, 20), rgb(40, 40, 40))"), [30, 30, 30, 1]);
assert.deepStrictEqual(T.gradientColor("linear-gradient(90deg, rgba(0, 0, 0, 0.5) 0%, rgb(0, 0, 0) 100%)"), [0, 0, 0, 0.75]);
assert.strictEqual(T.gradientColor('url("https://x/banner.jpg")'), null, "a picture");
assert.strictEqual(T.gradientColor('linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0)), url("x.png")'), null, "a picture under a gradient");
assert.strictEqual(T.gradientColor("none"), null);
assert.strictEqual(T.toneOf(T.composite([T.gradientColor("linear-gradient(rgb(27, 27, 31), rgb(60, 20, 90))")], white)), "dark");

// A big picture's own background color stands in for it, when opaque
// (Thangs' dark hero, under a transparent bar).
assert.deepStrictEqual(T.standIn([29, 29, 30, 1]), [29, 29, 30, 1]);
assert.strictEqual(T.standIn([0, 0, 0, 0]), null);
assert.strictEqual(T.standIn(null), null);

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

// The color under the pill (Linux's opaque view): the readable points'
// average, the page's background, or white / near black by the tone.
assert.strictEqual(T.underColor([[255, 255, 255], [243, 243, 245], null], null, "light"), "#f9f9fa");
assert.strictEqual(T.underColor([null, null, null], [18, 18, 18, 1], "dark"), "#121212");
assert.strictEqual(T.underColor([null], [0, 0, 0, 0], "dark"), "#121212", "a transparent page: by the tone");
assert.strictEqual(T.underColor([], null, "light"), "#ffffff");
assert.strictEqual(T.underColor([null, null, null], [255, 255, 255, 1], "dark"), "#121212", "a white page under a dark banner: by the tone");

// When to measure: never while scrolling, at most every MIN_GAP.
const { waitFor, SCROLL_SETTLE: S, MIN_GAP: G } = T;
assert.strictEqual(waitFor(1000, -Infinity, -Infinity), 0, "nothing yet: now");
assert.strictEqual(waitFor(1000, 1000, -Infinity), S, "just scrolled: once it settles");
assert.strictEqual(waitFor(1000 + S, 1000, -Infinity), 0, "scrolling stopped: now");
assert.strictEqual(waitFor(1100, -Infinity, 1000), G - 100, "just measured: not before the gap");
assert.strictEqual(waitFor(5000, 4990, 1000), S - 10, "scrolling again: the scroll wins");
assert.ok(S < G && G <= 1000);

console.log("navtone: ok");
