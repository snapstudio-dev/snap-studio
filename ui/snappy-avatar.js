"use strict";
/* Snappy's avatar, alive: the white rounded square with its rainbow
   outline, given a volume and two eyes that face you.

   The motion follows open-bot-avatar's pose model
   (https://github.com/DominikScholz/open-bot-avatar, MIT License,
   Copyright (c) Dominik Scholz — packages/core/src/motion.ts, follow.ts,
   mood.ts): a pose is a pure function of time and mood — the body's turn
   (yaw, pitch, roll), lift and squash, the eyes' look, blink and shape —
   and the pointer is followed by easing a look target, the whole body
   turning towards it with the eyes adding a share. Moods: idle (a breath,
   a sway, blinks, the eyes wandering), thinking (while Snappy works: it
   turns about its vertical axis, a full turn then a pause, eyes up and
   narrowed), happy (hops, eyes as arcs). Mood changes ease over 420 ms.
   Reduced motion keeps the body still; only the eyes follow.

   Drawn with CSS 3D: the ring stacked in a few slices for its volume, the
   white face and the eyes on the front, the back face behind. */

const SNV_TAU = Math.PI * 2;
/* Resting view: turned a little, seen a little from above (motion.ts). */
const SNV_BASE_YAW = -0.3;
const SNV_BASE_PITCH = 0.2;
/* Following a target: body turn at full deflection, and the eyes' share. */
const SNV_LOOK_YAW = 0.32;
const SNV_LOOK_PITCH = 0.18;
const SNV_LOOK_EYES = 0.7;
/* The eyes, in the 100-unit box: centered, facing front. */
const SNV_EYES = { x: 50, y: 47, spacing: 17, w: 6.4, h: 17.6, gx: 3.2, gy: 2.6 };
/* A thinking turn: one full turn over SNV_SPIN_TURN s, every SNV_SPIN_PERIOD s. */
const SNV_SPIN_PERIOD = 3.4;
const SNV_SPIN_TURN = 1.5;
/* Mood change length, ms (mood.ts). */
const SNV_MOOD_MS = 420;

const snvClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snvSmooth = (u) => {
  const x = snvClamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

/* Stateless hash noise in [0, 1) (motion.ts). */
function snvNoise(seed, n) {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* Blink closure 0..1: one per ~4.2 s slot, sometimes a double one. */
function snvBlink(seed, t) {
  const SLOT = 4.2, DUR = 0.19;
  const slot = Math.floor(t / SLOT);
  let closure = 0;
  for (const s of [slot - 1, slot]) {
    const start = s * SLOT + 0.5 + snvNoise(seed, s * 2) * 2.9;
    const starts = snvNoise(seed, s * 2 + 1) > 0.8 ? [start, start + 0.34] : [start];
    for (const b of starts) {
      const u = (t - b) / DUR;
      if (u > 0 && u < 1) closure = Math.max(closure, Math.sin(Math.PI * u));
    }
  }
  return closure;
}

/* Idle eye wander: short holds between quick saccades, centered more often. */
function snvWander(seed, t) {
  const SLOT = 1.9;
  const s = Math.floor(t / SLOT);
  const target = (k) =>
    snvNoise(seed, 1000 + k * 3) < 0.35 ? [0, 0] : [(snvNoise(seed, 1001 + k * 3) * 2 - 1) * 0.9, (snvNoise(seed, 1002 + k * 3) * 2 - 1) * 0.5];
  const a = target(s - 1), b = target(s);
  const e = snvSmooth((t - s * SLOT) / 0.16);
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
}

/* Idle gestures, now and then at random moments: a sway left then right,
   a look around, a little hop, a curious head tilt, a quick wiggle. Slots
   of SNV_GESTURE_SLOT s; in each, maybe one gesture, starting at a random
   point — so they come every 4 to 9 s or so, never on a beat. Returns the
   pose offsets at `t` (all zero between gestures). */
const SNV_GESTURE_SLOT = 6.5;
const SNV_GESTURES = ["sway", "look", "hop", "tilt", "wiggle"];
function snvGesture(seed, t) {
  const none = { kind: null, yaw: 0, roll: 0, lift: 0, sx: 1, sy: 1, gazeX: 0 };
  const slot = Math.floor(t / SNV_GESTURE_SLOT);
  for (const s of [slot - 1, slot]) {
    if (snvNoise(seed, 5000 + s * 4) < 0.18) continue;
    const kind = SNV_GESTURES[Math.floor(snvNoise(seed, 5001 + s * 4) * SNV_GESTURES.length)];
    const dur = { sway: 2.2, look: 2.6, hop: 0.75, tilt: 1.8, wiggle: 0.9 }[kind];
    const start = s * SNV_GESTURE_SLOT + snvNoise(seed, 5002 + s * 4) * (SNV_GESTURE_SLOT - dur);
    const u = (t - start) / dur;
    if (u <= 0 || u >= 1) continue;
    const side = snvNoise(seed, 5003 + s * 4) < 0.5 ? -1 : 1;
    // Eased in and out over the gesture.
    const env = Math.sin(Math.PI * u);
    const g = { ...none, kind };
    if (kind === "sway") {
      // Left, then right, then back.
      g.roll = 10 * side * Math.sin(SNV_TAU * u) * env;
      g.yaw = 0.28 * side * Math.sin(SNV_TAU * u) * env;
      g.lift = -1.2 * env;
    } else if (kind === "look") {
      // One side, a hold, the other side, back.
      const k = u < 0.4 ? snvSmooth(u / 0.18) : u < 0.8 ? 1 - 2 * snvSmooth((u - 0.4) / 0.2) : -1 + snvSmooth((u - 0.8) / 0.2);
      g.yaw = 0.6 * side * k;
      g.gazeX = 0.9 * side * k;
    } else if (kind === "hop") {
      const air = 4 * u * (1 - u);
      g.lift = -6 * air;
      const land = snvClamp(1 - Math.min(u, 1 - u) / 0.15, 0, 1);
      g.sy = 1 - 0.1 * land + 0.04 * air;
      g.sx = 1 + 0.08 * land - 0.02 * air;
    } else if (kind === "tilt") {
      // A curious tilt, held, the eyes up the same way.
      const k = snvSmooth(u / 0.25) * (1 - snvSmooth((u - 0.75) / 0.25));
      g.roll = 14 * side * k;
      g.gazeX = 0.4 * side * k;
    } else {
      g.roll = 5 * Math.sin(SNV_TAU * 3 * u) * env;
    }
    return g;
  }
  return none;
}

/* The thinking turn's angle at `t`: a full eased turn, then a pause. */
function snvSpin(t) {
  const p = ((t % SNV_SPIN_PERIOD) + SNV_SPIN_PERIOD) % SNV_SPIN_PERIOD;
  return SNV_TAU * snvSmooth(p / SNV_SPIN_TURN);
}

/* The pose for a mood at time `t` (s), with an optional look target
   `gaze` = { x, y, weight } (-1..1, x right, y down). */
function snvMoodPose({ seed, t: time, mood, gaze, reduced }) {
  const t = reduced ? 0 : time + snvNoise(seed, 7) * 10;
  const wave = (period, phase = 0) => (reduced ? 0 : Math.sin((SNV_TAU * t) / period + phase));
  const weight = gaze ? snvClamp(gaze.weight ?? 1, 0, 1) : 0;
  const sway = 1 - 0.7 * weight;
  const pose = { yaw: SNV_BASE_YAW, pitch: SNV_BASE_PITCH, roll: 0, lift: 0, sx: 1, sy: 1, gazeX: 0, gazeY: 0, blink: 0, squint: 0, happy: false };
  let follows = true;

  if (mood === "happy") {
    const period = 0.92;
    const p = reduced ? 0.5 : ((t % period) + period) % period / period;
    const air = 4 * p * (1 - p);
    const land = reduced ? 0 : snvClamp(1 - Math.min(p, 1 - p) / 0.12, 0, 1);
    pose.lift = reduced ? 0 : -3.2 * air;
    pose.sy = 1 - 0.09 * land + (reduced ? 0 : 0.03 * air);
    pose.sx = 1 + 0.07 * land - (reduced ? 0 : 0.015 * air);
    pose.roll = 4.5 * wave(period * 2);
    pose.yaw += 0.1 * wave(period * 2, 0.6);
    pose.happy = true;
  } else if (mood === "thinking") {
    // It works: turns on itself, eyes up and narrowed, floating a little.
    // The pointer does not turn it.
    follows = false;
    pose.yaw = (reduced ? 0 : snvSpin(t)) + 0.12 + 0.05 * wave(7.3);
    pose.pitch += 0.08;
    pose.roll = -5 + 1.4 * wave(4.1);
    pose.lift = reduced ? 0 : -1.2 * (1 - Math.cos((SNV_TAU * t) / 2.6));
    pose.gazeX = 0.55 + 0.3 * wave(5.6);
    pose.gazeY = -0.8;
    pose.squint = 0.3 + 0.1 * wave(3.1);
    if (!reduced) pose.blink = snvBlink(seed, t * 0.7);
  } else {
    // Rest, well visible: a sway, a tilt, a float, a breath.
    pose.yaw += 0.16 * sway * wave(6.1);
    pose.pitch += 0.08 * sway * wave(4.7, 1);
    pose.roll = 3.5 * wave(5.3, 2);
    pose.lift = reduced ? 0 : -1.4 * (1 - Math.cos((SNV_TAU * t) / 3.4));
    const breath = wave(3.4, -Math.PI / 2);
    pose.sy = 1 + 0.03 * breath;
    pose.sx = 1 - 0.02 * breath;
    if (!reduced) {
      pose.blink = snvBlink(seed, t);
      [pose.gazeX, pose.gazeY] = snvWander(seed, t);
      // Now and then a gesture, softer while it looks at the pointer.
      const g = snvGesture(seed, t);
      if (g.kind) {
        pose.yaw += g.yaw * sway;
        pose.roll += g.roll * sway;
        pose.lift += g.lift;
        pose.sx *= g.sx;
        pose.sy *= g.sy;
        if (g.gazeX) pose.gazeX = g.gazeX;
      }
    }
  }

  if (gaze && weight > 0 && follows) {
    // The body turns to face the target; the eyes add a share.
    const share = reduced ? 1 : SNV_LOOK_EYES;
    if (!pose.happy) {
      pose.gazeX += (gaze.x * share - pose.gazeX) * weight;
      pose.gazeY += (gaze.y * share - pose.gazeY) * weight;
    }
    if (!reduced) {
      pose.yaw += weight * (gaze.x * SNV_LOOK_YAW - SNV_BASE_YAW);
      pose.pitch += weight * (-gaze.y * SNV_LOOK_PITCH - SNV_BASE_PITCH / 2);
    }
  }
  return pose;
}

/* Part way from pose `a` to `b` (0..1). The turn takes the short way
   round, so leaving a thinking turn never unwinds it. The eye shape
   swaps halfway, inside a blink. */
function snvBlend(a, b, k) {
  k = snvClamp(k, 0, 1);
  const mix = (x, y) => x + (y - x) * k;
  let dy = (b.yaw - a.yaw) % SNV_TAU;
  if (dy > Math.PI) dy -= SNV_TAU;
  if (dy < -Math.PI) dy += SNV_TAU;
  const pose = {
    yaw: a.yaw + dy * k, pitch: mix(a.pitch, b.pitch), roll: mix(a.roll, b.roll), lift: mix(a.lift, b.lift),
    sx: mix(a.sx, b.sx), sy: mix(a.sy, b.sy), gazeX: mix(a.gazeX, b.gazeX), gazeY: mix(a.gazeY, b.gazeY),
    blink: mix(a.blink, b.blink), squint: mix(a.squint, b.squint), happy: b.happy,
  };
  if (a.happy !== b.happy) {
    pose.happy = k < 0.5 ? a.happy : b.happy;
    pose.blink = Math.max(pose.blink, 1 - Math.abs(2 * k - 1));
  }
  return pose;
}

/* Look direction (-1..1) towards a viewport point, from the eyes, soft
   and radial (follow.ts). */
function snvPointerGaze(pointer, box) {
  const reach = Math.max(box.width, box.height, 160);
  const dx = (pointer.x - (box.left + box.width * 0.5)) / reach;
  const dy = (pointer.y - (box.top + box.height * (SNV_EYES.y / 100))) / reach;
  const m = Math.hypot(dx, dy);
  if (!Number.isFinite(m) || m < 1e-9) return { x: 0, y: 0 };
  const k = Math.tanh(m) / m;
  return { x: dx * k, y: dy * k };
}

/* One easing step of the look towards `target` (null: back to rest). */
function snvFollow(state, target, dt, reduced) {
  const goal = target ? { x: target.x, y: target.y, attention: 1 } : { x: 0, y: 0, attention: 0 };
  const step = snvClamp(dt, 0, 0.1);
  const ease = (tau) => (reduced ? 1 : 1 - Math.exp(-step / tau));
  const k = ease(target ? 0.12 : 0.3);
  return {
    x: state.x + (goal.x - state.x) * k,
    y: state.y + (goal.y - state.y) * k,
    attention: state.attention + (goal.attention - state.attention) * ease(0.3),
  };
}

/* The eyes as SVG, in the face's 100-unit box. */
function snvEyesSvg(pose) {
  const E = SNV_EYES;
  const dx = pose.gazeX * E.gx, dy = pose.gazeY * E.gy;
  const f = (n) => n.toFixed(2);
  return [E.x - E.spacing / 2, E.x + E.spacing / 2]
    .map((cx) => {
      const x = cx + dx, y = E.y + dy;
      if (pose.happy) {
        const hw = E.w * 0.72, base = y + E.h * 0.1;
        return `<path d="M${f(x - hw)} ${f(base)}Q${f(x)} ${f(y - E.h * 0.42)} ${f(x + hw)} ${f(base)}" fill="none" stroke="#151515" stroke-width="${f(E.w * 0.6)}" stroke-linecap="round"/>`;
      }
      const open = Math.max(E.h * Math.max(0.09, (1 - pose.blink) * (1 - pose.squint * 0.4)), E.w * 0.55);
      const cy = y + (E.h - open) * 0.18;
      return `<rect x="${f(x - E.w / 2)}" y="${f(cy - open / 2)}" width="${f(E.w)}" height="${f(open)}" rx="${f(Math.min(E.w, open) / 2)}" fill="#151515"/>`;
    })
    .join("");
}

if (typeof module !== "undefined") module.exports = { snvGesture, snvMoodPose, snvBlend, snvSpin, snvPointerGaze, snvFollow, snvEyesSvg, SNV_EYES };

if (typeof document !== "undefined") {
  const AVATARS = new Set();
  /* Slices of the ring behind the front, for the volume. */
  const SLICES = 6;
  const DEPTH = 12;
  /* Gaps between planes, in real pixels: WebKit (Tauri on macOS) merges
     planes closer than about a pixel and may draw the face over the eyes
     — at 42 px a unit is 0.4 px, so these are never in units
     (open-bot-avatar's EYE_LIFT note). */
  const EYES_LIFT_PX = 3;
  const SLICE_GAP_PX = 2;
  const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /* Mounts an avatar in `host`; returns { setMood, destroy }. */
  window.snappyAvatar = function snappyAvatar(host) {
    const el = document.createElement("span");
    el.className = "snv";
    let slices = "";
    // The slices go from SLICE_GAP_PX behind the front to the back.
    for (let i = SLICES; i >= 1; i--) {
      slices += `<span class="snv-slice" style="transform:translateZ(calc(${(-DEPTH * i) / SLICES}em - ${SLICE_GAP_PX}px))"></span>`;
    }
    el.innerHTML =
      `<span class="snv-body">${slices}` +
      `<span class="snv-back" style="transform:translateZ(calc(${-DEPTH}em - ${SLICE_GAP_PX * 2}px)) rotateY(180deg)"><span class="snv-ring"></span><span class="snv-face"></span></span>` +
      `<span class="snv-front"><span class="snv-ring"></span><span class="snv-face"></span></span>` +
      `<span class="snv-eyes" style="transform:translateZ(${EYES_LIFT_PX}px)"><svg viewBox="0 0 100 100" aria-hidden="true"></svg></span></span>`;
    host.appendChild(el);
    const a = {
      el,
      body: el.querySelector(".snv-body"),
      eyes: el.querySelector(".snv-eyes svg"),
      seed: Math.floor(Math.random() * 2 ** 31),
      mood: { now: "idle", from: null, since: 0 },
      look: { x: 0, y: 0, attention: 0 },
      eyesHtml: "",
    };
    // Drawn at once, at rest: never a face without eyes, even before the
    // first frame (or when frames are paused).
    a.eyesHtml = snvEyesSvg(snvMoodPose({ seed: a.seed, t: 0, mood: "idle", gaze: null, reduced: true }));
    a.eyes.innerHTML = a.eyesHtml;
    AVATARS.add(a);
    snvTick();
    return {
      setMood(mood) {
        if (mood === a.mood.now) return;
        const now = performance.now();
        // The new mood eases in from the pose on screen.
        a.mood = { now: mood, from: a.last || null, since: now };
        clearTimeout(a.happyTimer);
        if (mood === "happy") a.happyTimer = setTimeout(() => a.mood.now === "happy" && this.setMood("idle"), 1600);
      },
      destroy() {
        AVATARS.delete(a);
        el.remove();
      },
    };
  };

  /* The pointer, and when it last moved: still for a while, the avatar
     goes back to its own idle look. */
  let pointer = null;
  let movedAt = 0;
  document.addEventListener("pointermove", (e) => ((pointer = { x: e.clientX, y: e.clientY }), (movedAt = performance.now())), { passive: true });
  document.addEventListener("pointerleave", () => (pointer = null));

  let last = 0;
  let running = false;
  function snvTick() {
    if (running) return;
    running = true;
    requestAnimationFrame(snvFrame);
  }

  function snvFrame(now) {
    running = false;
    // The next frame first: one frame that fails must not stop them all.
    if (AVATARS.size) snvTick();
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const still = reduced();
    for (const a of AVATARS) {
      if (!a.el.isConnected || !a.el.offsetParent) continue;
      const box = a.el.getBoundingClientRect();
      // 1 em = one unit of the avatar's 100-unit box.
      const unit = box.width / 100;
      if (unit && a.unit !== unit) {
        a.unit = unit;
        a.el.style.fontSize = unit + "px";
      }
      const target = pointer && now - movedAt < 4000 ? snvPointerGaze(pointer, box) : null;
      a.look = snvFollow(a.look, target, dt, still);
      const w = snvSmooth(a.look.attention);
      const gaze = w > 0.001 ? { x: a.look.x, y: a.look.y, weight: w } : null;
      const t = now / 1000;
      let pose = snvMoodPose({ seed: a.seed, t, mood: a.mood.now, gaze, reduced: still });
      const k = still ? 1 : snvSmooth((now - a.mood.since) / SNV_MOOD_MS);
      if (a.mood.from && k < 1) pose = snvBlend(a.mood.from, pose, k);
      else a.mood.from = null;
      a.last = pose;
      a.body.style.transform =
        `translateY(${pose.lift.toFixed(2)}em) rotateZ(${pose.roll.toFixed(2)}deg) rotateY(${pose.yaw.toFixed(4)}rad) ` +
        `rotateX(${pose.pitch.toFixed(4)}rad) translateZ(${DEPTH / 2}em) scale(${pose.sx.toFixed(4)}, ${pose.sy.toFixed(4)})`;
      // Eyes only while the face looks towards us (open-bot-avatar's
      // EYE_FACING): WebKit does not always hide a turned-away plane.
      const facing = Math.cos(pose.yaw) * Math.cos(pose.pitch) > 0.22;
      if (a.facing !== facing) {
        a.facing = facing;
        a.eyes.style.visibility = facing ? "" : "hidden";
      }
      const html = snvEyesSvg(pose);
      if (html !== a.eyesHtml) {
        a.eyesHtml = html;
        a.eyes.innerHTML = html;
      }
    }
  }
}
