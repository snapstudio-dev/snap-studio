/* Is the site under the floating navigation light or dark? Injected by
   library.rs into each site's view (main frame), it only reads: the colors
   under the pill (overlay.html), at most every 250 ms, and keeps one word,
   "light" or "dark", that Rust reads (`eval_with_callback`) and passes to
   the pill. It makes no request, changes nothing in the page and stores
   nothing. The rules are pure functions, tested in Node
   (scripts/test-navtone.js). */
(function () {
  "use strict";

  /* Points under the pill, in the page's CSS pixels: the pill is laid at
     (10, 10) from the view's corner, 112 × 40 (library.rs NAV_SIZE). */
  const POINTS = [[24, 30], [66, 30], [108, 30]];
  /* Two thresholds with a gap: a mid-grey header keeps the current tone
     rather than making the pill flicker. */
  const DARK_BELOW = 0.4, LIGHT_ABOVE = 0.6;

  /* "rgb(…)", "rgba(…)" (commas or spaces, alpha as a number or %), "#rgb",
     "#rgba", "#rrggbb", "#rrggbbaa", "transparent": [r, g, b, a] (0–255,
     alpha 0–1), null otherwise. */
  function parseColor(s) {
    if (typeof s !== "string") return null;
    s = s.trim().toLowerCase();
    if (s === "transparent") return [0, 0, 0, 0];
    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    m = s.match(/^rgba?\(([^)]*)\)$/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p, max) => (p.endsWith("%") ? (parseFloat(p) / 100) * max : parseFloat(p));
    const c = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), parts[3] != null ? num(parts[3], 1) : 1];
    return c.every((x) => Number.isFinite(x)) ? c : null;
  }

  /* The colors of a point, top first, laid over each other and over the
     page's canvas (`canvas`, opaque): the color seen, [r, g, b]. */
  function composite(layers, canvas) {
    let out = canvas.slice(0, 3);
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    }
    return out;
  }

  /* Relative luminance (WCAG 2), 0 for black to 1 for white. */
  function luminance([r, g, b]) {
    const lin = (c) => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  /* A color's tone: "dark", "light", or "mid" between the thresholds. */
  function toneOf(rgb) {
    const l = luminance(rgb);
    return l < DARK_BELOW ? "dark" : l > LIGHT_ABOVE ? "light" : "mid";
  }

  /* A picture small enough to be a logo or an icon (CSS pixels): what is
     under it, the header's background, tells more than the page's
     fallbacks. A bigger one (a banner, a cover) leaves the point unread. */
  const smallPicture = (w, h) => h <= 64 && w <= 320;

  /* When the points cannot be read: the page's theme-color, then the
     background of <body>, then of <html> (opaque ones only), then its
     color-scheme. null when none of them tells. */
  function fallbackTone({ themeColor = null, body = null, html = null, colorScheme = "" } = {}) {
    for (const c of [themeColor, body, html]) {
      if (c && c[3] >= 0.99) {
        const t = toneOf(c);
        if (t !== "mid") return t;
      }
    }
    return /\bdark\b/.test(colorScheme || "") && !/\blight\b/.test(colorScheme || "") ? "dark" : null;
  }

  /* The pill's tone from its points: each "light", "dark", "mid", or null
     (unreadable: a picture, a video…), which takes the fallback's tone.
     The majority of the points decides; without one, the current tone
     stays (null: none yet). */
  function decide(points, fallback, current = null) {
    const votes = points.map((t) => (t == null ? fallback : t));
    for (const t of ["light", "dark"]) if (votes.filter((v) => v === t).length * 2 > votes.length) return t;
    return current;
  }

  const rules = { POINTS, parseColor, composite, luminance, toneOf, smallPicture, fallbackTone, decide };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = rules;
    return;
  }

  // ------------------------------------------------------------ in the page

  // The main frame only: ads' frames have nothing to say.
  if (window.top !== window) return;
  // Kept under a symbol: not listed among the page's own variables.
  const KEY = Symbol.for("snapstudio.navTone");
  let tone = null;
  const keep = (t) => {
    tone = t;
    try {
      Object.defineProperty(window, KEY, { value: t, writable: true, configurable: true, enumerable: false });
    } catch (e) {}
  };

  /* A CSS color to [r, g, b, a], whatever its syntax (theme-color may be a
     name or hsl()): through a canvas never added to the page. */
  let probe = null;
  function cssColor(s) {
    const direct = parseColor(s);
    if (direct || !s) return direct;
    try {
      probe ||= (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")).getContext("2d");
      probe.fillStyle = "#010203";
      probe.fillStyle = s;
      return probe.fillStyle === "#010203" && s.replace(/\s/g, "") !== "#010203" ? null : parseColor(probe.fillStyle);
    } catch (e) {
      return null;
    }
  }

  /* Pixels a script cannot read; pictures (images, SVG) are looked under
     when small. */
  const MEDIA = new Set(["VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT"]);
  const PICTURE = new Set(["IMG", "PICTURE"]);
  const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const scheme = () => getComputedStyle(document.documentElement).colorScheme || "";

  /* The tone of one point, or null when a picture is in the way. */
  function pointTone(x, y, canvas) {
    const layers = [];
    for (const el of document.elementsFromPoint(x, y)) {
      if (MEDIA.has(el.tagName)) return null;
      const svg = el instanceof SVGElement ? el.ownerSVGElement || el : null;
      if (svg || PICTURE.has(el.tagName)) {
        const r = (svg || el).getBoundingClientRect();
        if (smallPicture(r.width, r.height)) continue;
        return null;
      }
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        const r = el.getBoundingClientRect();
        if (smallPicture(r.width, r.height)) continue;
        return null;
      }
      const c = parseColor(cs.backgroundColor);
      if (!c || c[3] === 0) continue;
      layers.push(c);
      if (c[3] >= 0.99) break;
    }
    return toneOf(composite(layers, canvas));
  }

  function measure() {
    if (!document.documentElement) return;
    const meta = [...document.querySelectorAll('meta[name="theme-color"]')].find((m) => !m.media || matchMedia(m.media).matches);
    const cs = scheme();
    // A page without a background shows the browser's canvas: white, or
    // black for a page that asks for dark.
    const darkCanvas = /\bdark\b/.test(cs) && (!/\blight\b/.test(cs) || dark());
    const canvas = darkCanvas ? [18, 18, 18, 1] : [255, 255, 255, 1];
    const fb = fallbackTone({
      themeColor: meta ? cssColor(meta.content) : null,
      body: document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null,
      html: parseColor(getComputedStyle(document.documentElement).backgroundColor),
      colorScheme: cs,
    });
    // Pinch zoom: the pill's points in the page's pixels.
    const vv = window.visualViewport;
    const at = vv ? ([x, y]) => [vv.offsetLeft + x / (vv.scale || 1), vv.offsetTop + y / (vv.scale || 1)] : (p) => p;
    const t = decide(POINTS.map((p) => pointTone(...at(p), canvas)), fb, tone);
    if (t !== tone) keep(t);
  }

  /* One measure at most every 250 ms, in an animation frame. */
  let timer = 0, again = false;
  function soon() {
    if (timer) {
      again = true;
      return;
    }
    timer = setTimeout(() => {
      requestAnimationFrame(() => {
        try {
          measure();
        } catch (e) {}
        timer = 0;
        if (again) {
          again = false;
          soon();
        }
      });
    }, 250);
  }

  const watch = () => {
    soon();
    try {
      new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    } catch (e) {}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
  addEventListener("load", soon);
  addEventListener("scroll", soon, { passive: true, capture: true });
  addEventListener("resize", soon, { passive: true });
  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", soon);
  } catch (e) {}
})();
