// node scripts/test-themes.js — display settings: themes, mode, accent, contrast.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const T = require("../ui/themes.js");

const css = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
// Snap Studio's tokens, light and dark, as written in style.css.
const block = (head) => {
  const at = css.indexOf(head);
  assert.ok(at >= 0, `token block ${head}`);
  const body = css.slice(at + head.length, css.indexOf("\n}\n", at));
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
};
const LIGHT = block(':root,\n[data-scheme="light"] {');
const DARK = { ...LIGHT, ...block('[data-scheme="dark"] {') };
assert.strictEqual(LIGHT["--content-bg"], "#f3f3f5");
assert.strictEqual(DARK["--content-bg"], "#1e1e20");

// The mode is only decided by tokens on data-scheme: no media query left.
assert.ok(!/prefers-color-scheme/.test(css), "style.css follows data-scheme, not the media query");

// Settings are normalised.
assert.deepStrictEqual(T.displayNormalize(null), T.DISPLAY_DEFAULT);
assert.deepStrictEqual(T.displayNormalize({ mode: "dim", theme: "nope", accent: "javascript:x" }), T.DISPLAY_DEFAULT);
assert.deepStrictEqual(T.displayNormalize({ mode: "dark", theme: "space", accent: "#A1B2C3" }), { mode: "dark", theme: "space", accent: "#a1b2c3", cvd: false });
// Colour-blind safe was a theme: kept as the option, over Snap Studio.
assert.deepStrictEqual(T.displayNormalize({ theme: "cvd" }), { ...T.DISPLAY_DEFAULT, cvd: true });
assert.strictEqual(T.displayNormalize({ theme: "nord", cvd: "yes" }).cvd, false, "only true");
assert.deepStrictEqual(T.displayNormalize({ accent: "green" }).accent, "green");
assert.strictEqual(T.displayNormalize({ accent: "#fff" }).accent, "theme", "only #rrggbb");

// Mode resolution.
assert.strictEqual(T.displayResolveMode("system", true), "dark");
assert.strictEqual(T.displayResolveMode("system", false), "light");
assert.strictEqual(T.displayResolveMode("light", true), "light");
assert.strictEqual(T.displayResolveMode("dark", false), "dark");

// Accent: theme's own, system (null: the CSS keeps AccentColor), preset, custom.
const S = (o) => T.displayNormalize({ ...T.DISPLAY_DEFAULT, ...o });
assert.strictEqual(T.displayAccent(S({}), "light"), null, "Snap Studio: system accent");
assert.strictEqual(T.displayAccent(S({ theme: "space" }), "light"), "#0c63e2");
assert.strictEqual(T.displayAccent(S({ theme: "space" }), "dark"), "#3d8bff");
assert.strictEqual(T.displayAccent(S({ theme: "space", accent: "system" }), "dark"), null);
assert.strictEqual(T.displayAccent(S({ accent: "purple" }), "dark"), "#af52de");
assert.strictEqual(T.displayAccent(S({ accent: "#123456" }), "light"), "#123456");

// Tokens written inline: nothing for the default look.
assert.deepStrictEqual(T.displayTokens(S({}), "light"), {});
assert.deepStrictEqual(T.displayTokens(S({}), "dark"), {});
assert.deepStrictEqual(T.displayTokens(S({ accent: "red" }), "light"), { "--accent": "#ff3b30" });
const space = T.displayTokens(S({ theme: "space" }), "dark");
assert.strictEqual(space["--content-bg"], "#101828");
assert.strictEqual(space["--accent"], "#3d8bff");

// Every token a theme writes exists in style.css (no typo silently ignored).
for (const t of T.THEMES) {
  assert.ok(t.name.startsWith("display.theme.") && t.sub, t.id);
  for (const mode of ["light", "dark"]) {
    for (const k of Object.keys(t.tokens[mode])) assert.ok(k in LIGHT, `${t.id}/${mode}: unknown token ${k}`);
  }
}
assert.deepStrictEqual(T.THEMES.map((t) => t.id), [
  "studio", "space", "contrast", "graphite", "night", "studiolight", "nord", "solarized", "filament", "macos",
]);
// Each theme gives both modes (a token left out takes Snap Studio's value
// for that mode).
for (const t of T.THEMES) {
  assert.ok(t.tokens.light && t.tokens.dark, `${t.id}: light and dark`);
  if (t.id !== "studio" && t.id !== "macos" && t.id !== "contrast") {
    assert.ok(t.tokens.light["--content-bg"] && t.tokens.dark["--content-bg"], `${t.id}: own surfaces in both modes`);
  }
  if (t.accent) assert.ok(t.accent.light && t.accent.dark, `${t.id}: accent per mode`);
}

// Colors.
assert.deepStrictEqual(T.parseColor("#fff"), [255, 255, 255, 1]);
assert.deepStrictEqual(T.parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
assert.deepStrictEqual(T.parseColor("rgb(1 2 3 / 0.25)"), [1, 2, 3, 0.25]);
assert.strictEqual(T.parseColor("AccentColor"), null);
assert.ok(Math.abs(T.contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 1e-9);
assert.strictEqual(T.accentTextFor([0, 122, 255]), "#ffffff", "white on the macOS blue");
assert.strictEqual(T.accentTextFor(T.parseColor("#ffcc00")), "#1d1d1f", "dark on yellow");
assert.strictEqual(T.accentTextFor(T.parseColor("#28cd41")), "#1d1d1f", "dark on light green");

// Filament: the accent is the T0 spool's color, readable on the page.
assert.strictEqual(T.spoolT0([{ index: 1, present: true, color: "#ff0000" }, { index: 0, present: true, color: "#00AAFF" }]), "#00aaff");
assert.strictEqual(T.spoolT0([{ index: 0, present: true, color: "00aaffff" }]), "#00aaff", "RGBA hex");
assert.strictEqual(T.spoolT0([{ index: 0, present: false, color: "#00aaff" }]), null, "empty head");
assert.strictEqual(T.spoolT0([{ index: 0, present: true, color: null }]), null);
assert.strictEqual(T.spoolT0([]), null);
assert.strictEqual(T.spoolT0(undefined), null);
const fil = T.themeById("filament");
const filAcc = (spool, mode) => T.displayAccent(S({ theme: "filament" }), mode, spool);
assert.strictEqual(filAcc(null, "light"), fil.accent.light, "no spool: neutral");
assert.strictEqual(filAcc(null, "dark"), fil.accent.dark);
assert.strictEqual(filAcc("#c0392b", "light"), "#c0392b", "a strong color is kept");
assert.strictEqual(filAcc("#c0392b", "dark"), T.filamentAccent("#c0392b", "dark", fil.tokens.dark["--content-bg"], "x"));
assert.strictEqual(T.displayAccent(S({ theme: "filament", accent: "purple" }), "light", "#c0392b"), "#af52de", "a chosen accent wins");
assert.strictEqual(T.displayAccent(S({ theme: "filament", accent: "system" }), "light", "#c0392b"), null);
assert.strictEqual(T.displayAccent(S({ theme: "space" }), "light", "#c0392b"), "#0c63e2", "other themes ignore the spool");
assert.strictEqual(T.displayTokens(S({ theme: "filament" }), "dark", "#2ecc71")["--accent"], T.filamentAccent("#2ecc71", "dark", fil.tokens.dark["--content-bg"], "x"));
for (const mode of ["light", "dark"]) {
  const page = T.parseColor(fil.tokens[mode]["--content-bg"]);
  for (const spool of ["#ffffff", "#000000", "#fff200", "#1a1a1a", "#f2f2f2", "#7f7f7f", "#00aaff"]) {
    const a = T.parseColor(filAcc(spool, mode));
    assert.ok(T.contrastRatio(a, page) >= 3, `filament ${spool}/${mode} stands out: ${filAcc(spool, mode)}`);
    assert.ok(T.contrastRatio(a, T.parseColor(T.accentTextFor(a))) >= 3, `filament ${spool}/${mode}: text on it`);
  }
}
assert.strictEqual(filAcc("#ffffff", "light") !== "#ffffff", true, "a white spool is darkened on a light page");
assert.strictEqual(T.toHex([255, 0, 16.4]), "#ff0010");

// Contrast per theme and mode (WCAG): text AA everywhere (Apple's own
// secondary text is lighter by design); the new themes keep their
// secondary text AA; High contrast is AAA, with visible borders.
const opaque = (c, bg) => {
  const p = T.parseColor(c);
  assert.ok(p, `color ${c}`);
  return p[3] < 1 ? T.blendOver(p, bg) : p;
};
const SAME_AS_STUDIO = new Set(["studio"]);
// Sidebar text: the theme's own (a dark sidebar), else the page's.
const sideTok = (tok, k) => (/^var\(/.test(tok[`--sidebar-${k}`] || "var(") ? tok[`--${k}`] : tok[`--sidebar-${k}`]);
for (const t of T.THEMES) {
  for (const mode of ["light", "dark"]) {
    const tok = { ...(mode === "dark" ? DARK : LIGHT), ...t.tokens[mode] };
    for (const surface of ["--content-bg", "--card-bg", "--sheet-bg"]) {
      // See-through surfaces (macOS cards) are judged over the page.
      const bg = opaque(tok[surface], opaque(tok["--content-bg"], [0, 0, 0, 1]));
      const ratio = (k) => T.contrastRatio(opaque(tok[k], bg), bg);
      const where = `${t.id}/${mode} on ${surface}`;
      assert.ok(ratio("--text") >= (t.id === "contrast" ? 15 : 7), `${where}: text ${ratio("--text").toFixed(2)}`);
      // Colour-blind safe is Snap Studio but for the states: same tier.
      if (!SAME_AS_STUDIO.has(t.id)) assert.ok(ratio("--text-secondary") >= (t.id === "contrast" ? 7 : 4.5), `${where}: secondary ${ratio("--text-secondary").toFixed(2)}`);
      // Status colors used as text (danger buttons, saved / draft badges).
      if (t.id !== "studio" && t.id !== "space") {
        for (const k of ["--danger", "--success-text", "--warning-text"]) {
          assert.ok(ratio(k) >= (t.id === "contrast" ? 4.5 : 3), `${where}: ${k} ${ratio(k).toFixed(2)}`);
        }
      }
      if (t.id === "contrast") {
        assert.ok(ratio("--separator") >= 3, `${where}: separator ${ratio("--separator").toFixed(2)}`);
        assert.ok(ratio("--control-border") >= 3, `${where}: control border`);
      }
    }
    // The sidebar (opaque outside macOS) reads as well as the page.
    if (!SAME_AS_STUDIO.has(t.id)) {
      const side = opaque(tok["--sidebar-opaque"], [0, 0, 0, 1]);
      assert.ok(T.contrastRatio(opaque(sideTok(tok, "text"), side), side) >= 7, `${t.id}/${mode}: text on sidebar`);
      assert.ok(T.contrastRatio(opaque(sideTok(tok, "text-secondary"), side), side) >= 4.5, `${t.id}/${mode}: secondary on sidebar`);
    }
    // Glass panels: the sheet color at --glass-mix over a mid-grey scene
    // (the Prepare view behind) keeps the text readable.
    const mix = parseFloat(tok["--glass-mix"]) / 100;
    const sheet = opaque(tok["--sheet-bg"], [0, 0, 0, 1]);
    for (const behind of [[128, 128, 128], opaque(tok["--content-bg"], [0, 0, 0, 1])]) {
      const glass = T.blendOver([...sheet.slice(0, 3), mix], behind);
      assert.ok(T.contrastRatio(opaque(tok["--text"], glass), glass) >= 4.5, `${t.id}/${mode}: text on glass`);
    }
    // Text on the theme's own accent (primary buttons, selection).
    const acc = t.accent?.[mode];
    if (acc) {
      const a = T.parseColor(acc);
      const fg = T.parseColor(T.accentTextFor(a));
      assert.ok(T.contrastRatio(a, fg) >= (t.id === "contrast" ? 4.5 : 3), `${t.id}/${mode}: text on accent`);
      // The accent itself stands out from the page (links, focus, selected rows).
      const bg = opaque(tok["--content-bg"], [0, 0, 0, 1]);
      assert.ok(T.contrastRatio(a, bg) >= 3, `${t.id}/${mode}: accent on page`);
    }
  }
}

// Colour-blind safe: no state is red or green any more; they stay apart.
const hue = (c) => {
  const [r, g, b] = T.parseColor(c).map((v, i) => (i < 3 ? v / 255 : v));
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
for (const mode of ["light", "dark"]) {
  const k = T.CVD_TOKENS[mode];
  for (const n of ["--danger", "--success", "--success-text"]) {
    const h = hue(k[n]);
    assert.ok(!(h < 20 || h > 345) && !(h > 75 && h < 165), `cvd/${mode} ${n} is neither red nor green (${h.toFixed(0)}°)`);
  }
  const hs = ["--danger", "--warning", "--success"].map((n) => hue(k[n]));
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const d = Math.abs(hs[i] - hs[j]);
    assert.ok(Math.min(d, 360 - d) >= 60, `cvd/${mode}: states apart`);
  }
}
// Colour-blind safe is an option over every theme: its states stay
// readable on each theme's surfaces.
for (const t of T.THEMES) {
  for (const mode of ["light", "dark"]) {
    const tok = { ...(mode === "dark" ? DARK : LIGHT), ...T.displayTokens(S({ theme: t.id, cvd: true }), mode) };
    for (const k of Object.keys(T.CVD_TOKENS[mode])) assert.strictEqual(tok[k], T.CVD_TOKENS[mode][k], `${t.id}/${mode}: cvd ${k} wins`);
    for (const surface of ["--content-bg", "--card-bg", "--sheet-bg"]) {
      const bg = opaque(tok[surface], opaque(tok["--content-bg"], [0, 0, 0, 1]));
      for (const k of ["--danger", "--success-text", "--warning-text"]) {
        const r = T.contrastRatio(opaque(tok[k], bg), bg);
        assert.ok(r >= 3, `${t.id}/${mode} cvd on ${surface}: ${k} ${r.toFixed(2)}`);
      }
    }
  }
}
assert.deepStrictEqual(T.displayTokens(S({ cvd: true }), "light"), T.CVD_TOKENS.light);

// Filament tints its surfaces with the spool (the sidebar more than the
// page); text stays readable whatever the spool.
const filTok = T.displayTokens(S({ theme: "filament" }), "light", "#ff0000");
assert.notStrictEqual(filTok["--content-bg"], fil.tokens.light["--content-bg"], "page tinted");
assert.ok(/^rgba\(/.test(filTok["--sidebar-bg"]), "translucent sidebar keeps its alpha");
assert.deepStrictEqual(T.filamentTint(fil.tokens.light, null), {}, "no spool: no tint");
const shift = (k) => {
  const a = T.parseColor(fil.tokens.light[k]), b = T.parseColor(filTok[k]);
  return Math.abs(a[0] - b[0]);
};
assert.ok(shift("--sidebar-opaque") > shift("--content-bg"), "the sidebar takes more of it");
for (const mode of ["light", "dark"]) {
  for (const spool of ["#ff0000", "#00aa00", "#0000ff", "#000000", "#ffffff", "#fff200", "#8b00ff"]) {
    const tok = { ...(mode === "dark" ? DARK : LIGHT), ...T.displayTokens(S({ theme: "filament" }), mode, spool) };
    for (const surface of ["--content-bg", "--card-bg", "--sheet-bg", "--sidebar-opaque"]) {
      const bg = opaque(tok[surface], [0, 0, 0, 1]);
      assert.ok(T.contrastRatio(opaque(tok["--text"], bg), bg) >= 7, `filament ${spool}/${mode}: text on ${surface}`);
      assert.ok(T.contrastRatio(opaque(tok["--text-secondary"], bg), bg) >= 4.5, `filament ${spool}/${mode}: secondary on ${surface}`);
    }
  }
}

// No two themes look alike: in each mode, the page, the sidebar and the
// accent together differ enough (Snap Studio's accent: the macOS blue).
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
for (const mode of ["light", "dark"]) {
  const look = (t) => {
    const tok = { ...(mode === "dark" ? DARK : LIGHT), ...t.tokens[mode] };
    return ["--content-bg", "--sidebar-opaque"].map((k) => opaque(tok[k], [0, 0, 0, 1])).concat([T.parseColor(t.accent?.[mode] || "#007aff")]);
  };
  const ts = T.THEMES.filter((t) => t.id !== "macos");
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      const [a, b] = [look(ts[i]), look(ts[j])];
      const d = a.reduce((sum, c, n) => sum + dist(c, b[n]), 0);
      assert.ok(d >= 60, `${ts[i].id} and ${ts[j].id} look alike in ${mode} (${d.toFixed(0)})`);
    }
  }
}

// The macOS theme rounds cards and controls through the radius tokens
// only, and its glass falls back to the defaults elsewhere.
assert.ok("--radius-card" in LIGHT && "--glass-blur" in LIGHT);
assert.ok(parseFloat(T.themeById("macos").tokens.light["--radius-card"]) > parseFloat(LIGHT["--radius-card"]));

// macOS: its structure (floating sidebar, capsules, glass) lives in one
// block at the end of style.css, every rule scoped to the theme (or its
// preview tile); nothing else in the stylesheet selects on a theme.
const MAC_AT = css.indexOf("macOS theme (macOS 26 Tahoe");
assert.ok(MAC_AT > 0, "macOS block");
const SCOPES = [':root[data-theme="macos"]', '.disp-mock[data-mock="macos"]'];
const macRules = [...css.slice(css.indexOf("*/", MAC_AT) + 2).matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim());
assert.ok(macRules.length > 30, `macOS rules: ${macRules.length}`);
for (const sel of macRules) {
  for (const one of sel.split(",").map((x) => x.trim())) {
    assert.ok(SCOPES.some((sc) => one.startsWith(sc)), `macOS block: unscoped selector ${one}`);
  }
}
assert.ok(!/data-theme=|data-mock=/.test(css.slice(0, MAC_AT)), "no theme-specific rule outside the macOS block");
const macRule = (sel) => macRules.some((r) => r.split(",").map((x) => x.trim()).includes(sel));
for (const sel of [".sidebar", ".tb-btn", ".search", ".seg", ".seg-btn.on", ".side-item.on", "input.sw", ".modal-box", ".window"]) {
  assert.ok(macRule(`:root[data-theme="macos"] ${sel}`), `macOS restyles ${sel}`);
}

// Its glass and wallpaper keep text readable: the wallpaper's stops, the
// glass tints and the cards (see-through) over each stop, the selected
// sidebar row (accent tint, system blue assumed).
const macVars = (head) => block(head);
const MV = { light: macVars(':root[data-theme="macos"],\n.disp-mock[data-mock="macos"] {') };
MV.dark = { ...MV.light, ...macVars(':root[data-theme="macos"][data-scheme="dark"],\n.disp-mock[data-mock="macos"][data-scheme="dark"] {') };
for (const mode of ["light", "dark"]) {
  const tok = { ...(mode === "dark" ? DARK : LIGHT), ...T.themeById("macos").tokens[mode] };
  const v = MV[mode];
  for (const stop of ["--mt-wall-a", "--mt-wall-b", "--mt-wall-c"]) {
    const wall = T.parseColor(v[stop]);
    const layers = {
      wallpaper: wall,
      glass: T.blendOver(T.parseColor(v["--mt-glass"]), wall),
      "glass-strong": T.blendOver(T.parseColor(v["--mt-glass-strong"]), wall),
      card: T.blendOver(T.parseColor(tok["--card-bg"]), wall),
    };
    layers.selected = T.blendOver([0, 122, 255, 0.2], layers.glass);
    for (const [name, bg] of Object.entries(layers)) {
      const r = (k) => T.contrastRatio(opaque(tok[k], bg), bg);
      assert.ok(r("--text") >= 7, `macos/${mode} text on ${name} over ${stop}: ${r("--text").toFixed(2)}`);
      assert.ok(r("--text-secondary") >= 4.5, `macos/${mode} secondary on ${name} over ${stop}: ${r("--text-secondary").toFixed(2)}`);
    }
  }
}
assert.ok(/:root:not\(\.mac\) \.sidebar \{ background: var\(--sidebar-opaque\); \}/.test(css), "no vibrancy: opaque sidebar");

// The page's scripts share one global scope: themes.js (loaded first)
// must not declare a name another script declares too.
const UI = path.join(__dirname, "..", "ui");
const decl = /^(?:async )?function (\w+)|^(?:const|let|var|class) (\w+)/gm;
const seen = new Map();
for (const f of fs.readdirSync(UI).filter((f) => f.endsWith(".js"))) {
  for (const m of fs.readFileSync(path.join(UI, f), "utf8").matchAll(decl)) {
    const name = m[1] || m[2];
    assert.ok(!seen.has(name), `${name} declared in ${seen.get(name)} and ${f}`);
    seen.set(name, f);
  }
}

console.log("themes: ok");
