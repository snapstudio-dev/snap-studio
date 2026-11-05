"use strict";
/* Snappy's avatar, alive: the white rounded square with its rainbow
   outline and its two tilted eyes (docs/plans/snappy/snappy-squircle-clear.png),
   drawn in SVG so it can move as open-bot-avatar's avatars do
   (https://github.com/DominikScholz/open-bot-avatar, MIT): the eyes follow
   the pointer, blink now and then, and the mood shows — idle (a slow
   breath), thinking while Snappy answers (the eyes look up and around),
   happy when an answer lands (a hop, eyes squinting). Nothing moves when
   the system asks for reduced motion, but the gaze. */

/* How far the eyes go towards the pointer, in the avatar's 100-unit box,
   and how far away the pointer must be for the full reach. */
const SNAPPY_GAZE_MAX = 4.5;
const SNAPPY_GAZE_REACH = 320;

/* The eyes' offset for a pointer at (dx, dy) pixels from the avatar's
   center: towards it, capped, softer when the pointer is close. */
function snappyGaze(dx, dy, max = SNAPPY_GAZE_MAX, reach = SNAPPY_GAZE_REACH) {
  const d = Math.hypot(dx, dy);
  if (!d) return { x: 0, y: 0 };
  const k = (max * Math.min(1, d / reach)) / d;
  return { x: dx * k, y: dy * k };
}

if (typeof module !== "undefined") module.exports = { snappyGaze };

if (typeof document !== "undefined") {
  const AVATARS = new Set();
  const SVGNS = "http://www.w3.org/2000/svg";

  /* One eye: a capsule along its length, tilted, blinking along it. */
  const eye = (cx, cy) =>
    `<g transform="translate(${cx} ${cy}) rotate(-36)"><rect class="snv-eye" x="-4.7" y="-10.6" width="9.4" height="21.2" rx="4.7"/></g>`;

  /* Mounts an avatar in `host`; returns { setMood, destroy }. */
  window.snappyAvatar = function snappyAvatar(host) {
    const el = document.createElement("span");
    el.className = "snv";
    el.dataset.mood = "idle";
    el.innerHTML =
      `<span class="snv-ring"></span><span class="snv-face"></span>` +
      `<svg class="snv-eyes" viewBox="0 0 100 100" aria-hidden="true"><g class="snv-gaze">${eye(51.5, 35.3)}${eye(75.6, 25.8)}</g></svg>`;
    host.appendChild(el);
    const a = { el, gaze: el.querySelector(".snv-gaze"), blinkAt: 0 };
    AVATARS.add(a);
    snappyBlinkLater(a);
    return {
      setMood(mood) {
        el.dataset.mood = mood;
        if (mood === "happy") {
          clearTimeout(a.moodTimer);
          a.moodTimer = setTimeout(() => el.dataset.mood === "happy" && (el.dataset.mood = "idle"), 1400);
        }
      },
      destroy() {
        AVATARS.delete(a);
        clearTimeout(a.blinkTimer);
        el.remove();
      },
    };
  };

  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /* A blink every 2.5 to 6 seconds, a double one now and then. */
  function snappyBlinkLater(a) {
    a.blinkTimer = setTimeout(() => {
      if (!reduced() && a.el.isConnected) {
        a.el.classList.add("blink");
        setTimeout(() => a.el.classList.remove("blink"), 130);
        if (Math.random() < 0.2) setTimeout(() => {
          a.el.classList.add("blink");
          setTimeout(() => a.el.classList.remove("blink"), 120);
        }, 260);
      }
      snappyBlinkLater(a);
    }, 2500 + Math.random() * 3500);
  }

  /* The eyes follow the pointer, one frame at a time. */
  let pointer = null;
  let frame = 0;
  document.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(snappyLook);
    },
    { passive: true }
  );
  function snappyLook() {
    frame = 0;
    if (!pointer) return;
    for (const a of AVATARS) {
      // Thinking, the eyes have their own business (CSS).
      if (a.el.dataset.mood === "thinking" || !a.el.isConnected) continue;
      const r = a.el.getBoundingClientRect();
      if (!r.width) continue;
      const g = snappyGaze(pointer.x - (r.left + r.width / 2), pointer.y - (r.top + r.height / 2));
      a.gaze.setAttribute("transform", `translate(${g.x.toFixed(2)} ${g.y.toFixed(2)})`);
    }
  }
}
