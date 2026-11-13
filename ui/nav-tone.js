/* Is the site under the floating navigation light or dark? Injected by
   library.rs into each site's view (main frame), it only reads: the colors
   under the pill (overlay.html), and keeps one value, "light" or "dark"
   and the color seen there, that Rust reads (`eval_with_callback`) and
   passes to the pill. A measure forces the page's styles and layout: none
   is taken while the page scrolls (one follows once it stops), at most
   one every 500 ms, none while the page is hidden. It makes no request,
   changes nothing in the page and stores nothing. The rules are pure
   functions, tested in Node (scripts/test-navtone.js). */
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

  /* A background-image made of gradients only (computed style lists their
     colors): their colors' average, [r, g, b, a]. null with a picture in it
     (url(), image-set…), which cannot be read. */
  function gradientColor(image) {
    if (typeof image !== "string" || !/gradient\(/.test(image) || /url\(|image\(|image-set\(|element\(|cross-fade\(/.test(image)) return null;
    const stops = (image.match(/rgba?\([^)]*\)/g) || []).map(parseColor).filter(Boolean);
    if (!stops.length) return null;
    return [0, 1, 2, 3].map((k) => stops.reduce((a, c) => a + c[k], 0) / stops.length);
  }

  /* A picture's element background color, when opaque: what the site
     shows while it loads, close to it more often than the page's colors. */
  const standIn = (c) => (c && c[3] >= 0.99 ? c : null);

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

  /* The color under the pill, "#rrggbb", for Linux, where its view is
     opaque and shows it in its corners: the readable points' average, else
     the page's background if it has that tone, else white or near black by
     the tone. */
  function underColor(colors, page, tone) {
    const known = colors.filter(Boolean);
    const rgb = known.length
      ? [0, 1, 2].map((k) => known.reduce((a, c) => a + c[k], 0) / known.length)
      : page && page[3] >= 0.99 && toneOf(page) === tone
        ? page
        : tone === "dark"
          ? [18, 18, 18]
          : [255, 255, 255];
    return "#" + rgb.slice(0, 3).map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
  }

  /* Waits between measures (ms): after the last scroll, so that none is
     taken while scrolling, and between two measures, for pages that change
     all the time (carousels, pictures loading). */
  const SCROLL_SETTLE = 150, MIN_GAP = 500;

  /* How long to wait before measuring, at `now`, given the last scroll and
     the last measure (ms, -Infinity: never): 0 measures now. */
  function waitFor(now, lastScroll, lastMeasure) {
    return Math.max(0, lastScroll + SCROLL_SETTLE - now, lastMeasure + MIN_GAP - now);
  }

  const rules = { POINTS, SCROLL_SETTLE, MIN_GAP, waitFor, parseColor, composite, luminance, toneOf, smallPicture, gradientColor, standIn, fallbackTone, decide, underColor };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = rules;
    return;
  }

  // ------------------------------------------------------------ in the page

  // The main frame only: ads' frames have nothing to say.
  if (window.top !== window) return;
  // Kept under a symbol: not listed among the page's own variables.
  const KEY = Symbol.for("snapstudio.navTone");
  let tone = null, kept = null;
  /* What Rust reads: the tone and the color under the pill, "dark #121212". */
  const keep = (t, color) => {
    tone = t;
    const v = `${t} ${color}`;
    if (v === kept) return;
    kept = v;
    try {
      Object.defineProperty(window, KEY, { value: v, writable: true, configurable: true, enumerable: false });
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

  /* The color seen at one point, or null when a picture is in the way. */
  function pointColor(x, y, canvas) {
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
        // A gradient: its colors, over the element's own background color.
        const g = gradientColor(cs.backgroundImage);
        if (g) {
          layers.push(g);
          if (g[3] >= 0.99) break;
        } else {
          const r = el.getBoundingClientRect();
          if (smallPicture(r.width, r.height)) continue;
          // A big picture: its element's own color stands in, if any.
          const s = standIn(parseColor(cs.backgroundColor));
          if (!s) return null;
          layers.push(s);
          break;
        }
      }
      const c = parseColor(cs.backgroundColor);
      if (!c || c[3] === 0) continue;
      layers.push(c);
      if (c[3] >= 0.99) break;
    }
    return composite(layers, canvas);
  }

  function measure() {
    if (!document.documentElement) return;
    const meta = [...document.querySelectorAll('meta[name="theme-color"]')].find((m) => !m.media || matchMedia(m.media).matches);
    const cs = scheme();
    // A page without a background shows the browser's canvas: white, or
    // black for a page that asks for dark.
    const darkCanvas = /\bdark\b/.test(cs) && (!/\blight\b/.test(cs) || dark());
    const canvas = darkCanvas ? [18, 18, 18, 1] : [255, 255, 255, 1];
    const body = document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null;
    const html = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    const fb = fallbackTone({ themeColor: meta ? cssColor(meta.content) : null, body, html, colorScheme: cs });
    // Pinch zoom: the pill's points in the page's pixels.
    const vv = window.visualViewport;
    const at = vv ? ([x, y]) => [vv.offsetLeft + x / (vv.scale || 1), vv.offsetTop + y / (vv.scale || 1)] : (p) => p;
    const colors = POINTS.map((p) => pointColor(...at(p), canvas));
    const t = decide(colors.map((c) => c && toneOf(c)), fb, tone);
    if (t) keep(t, underColor(colors, body && body[3] >= 0.99 ? body : html, t));
  }

  /* One timer: a measure once the page has stopped scrolling, at most
     every MIN_GAP, none while the page is hidden. */
  let timer = 0, lastScroll = -Infinity, lastMeasure = -Infinity;
  function soon() {
    if (timer) return;
    const run = () => {
      timer = 0;
      if (document.hidden) return;
      const wait = waitFor(performance.now(), lastScroll, lastMeasure);
      if (wait > 0) {
        timer = setTimeout(run, wait);
        return;
      }
      timer = -1;
      requestAnimationFrame(() => {
        timer = 0;
        lastMeasure = performance.now();
        try {
          measure();
        } catch (e) {}
      });
    };
    timer = setTimeout(run, waitFor(performance.now(), lastScroll, lastMeasure));
  }
  const scrolled = () => {
    lastScroll = performance.now();
    soon();
  };

  const watch = () => {
    soon();
    try {
      new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    } catch (e) {}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
  addEventListener("load", soon);
  addEventListener("scroll", scrolled, { passive: true, capture: true });
  document.addEventListener("visibilitychange", soon);
  addEventListener("resize", soon, { passive: true });
  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", soon);
  } catch (e) {}
})();
