/* "A look inside": one large slide at a time, thumbnails, keyboard, swipe,
   autoplay (paused on hover/focus) and a fullscreen lightbox. Labels come
   from STRINGS through t() (main.js); galleryRelabel() runs on each
   language change. */
const G = {
  root: document.getElementById("gallery"),
  i: 0,
  timer: null,
  hold: new Set(), // reasons the autoplay is paused: hover, focus, user, hidden
  delay: 6000,
  reduced: window.matchMedia("(prefers-reduced-motion: reduce)"),
};
G.slides = [...G.root.querySelectorAll(".g-slide")];
G.thumbs = [...G.root.querySelectorAll(".g-thumb")];
G.n = G.slides.length;

function galleryGo(next, dir) {
  const to = ((next % G.n) + G.n) % G.n;
  if (to === G.i) return;
  const from = G.i;
  dir = dir || (to > from ? 1 : -1);
  G.root.style.setProperty("--dir", String(dir));
  G.slides.forEach((s, k) => {
    s.classList.toggle("is-active", k === to);
    s.classList.toggle("is-leaving", k === from);
    s.toggleAttribute("aria-hidden", k !== to);
    s.querySelector(".g-open").tabIndex = k === to ? 0 : -1;
  });
  G.thumbs.forEach((b, k) => {
    b.classList.toggle("is-active", k === to);
    if (k === to) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  G.i = to;
  document.getElementById("g-cur").textContent = String(to + 1);
  galleryIndicator();
  clearTimeout(G.leaveTimer);
  G.leaveTimer = setTimeout(() => G.slides[from].classList.remove("is-leaving"), 700);
  if (document.getElementById("lightbox").open) lightboxShow();
  galleryArm();
}

/* The active thumbnail's underline slides to it; the row scrolls it into view. */
function galleryIndicator() {
  const b = G.thumbs[G.i], ind = G.root.querySelector(".g-ind"), row = document.getElementById("g-thumbs");
  ind.style.transform = `translateX(${b.offsetLeft}px)`;
  ind.style.width = `${b.offsetWidth}px`;
  const left = b.offsetLeft - (row.clientWidth - b.offsetWidth) / 2;
  row.scrollTo({ left, behavior: G.reduced.matches ? "auto" : "smooth" });
}

/* Autoplay: off with reduced motion, paused while anything holds it. */
function galleryArm() {
  clearTimeout(G.timer);
  const play = document.getElementById("g-play");
  const user = G.hold.has("user") || G.reduced.matches;
  play.setAttribute("aria-pressed", String(user));
  play.classList.toggle("paused", user);
  play.setAttribute("aria-label", t(user ? "gal.play" : "gal.pause"));
  if (G.hold.size || G.reduced.matches) return;
  G.timer = setTimeout(() => galleryGo(G.i + 1, 1), G.delay);
}
const hold = (why, on) => {
  on ? G.hold.add(why) : G.hold.delete(why);
  galleryArm();
};

function galleryRelabel() {
  if (!G.root) return;
  G.slides.forEach((s, k) => {
    s.setAttribute("aria-label", t("gal.position", { n: k + 1, total: G.n }));
    const open = s.querySelector(".g-open");
    open.setAttribute("aria-label", t("gal.open", { cap: t(open.dataset.cap) }));
  });
  G.thumbs.forEach((b, k) => b.setAttribute("aria-label", t("gal.thumb", { n: k + 1, cap: t(b.dataset.cap) })));
  galleryArm();
  if (document.getElementById("lightbox").open) lightboxShow();
}

/* ------------------------------------------------------------ lightbox */

function lightboxShow() {
  const img = G.slides[G.i].querySelector("img");
  const lb = document.getElementById("lb-img");
  lb.src = img.currentSrc || img.src;
  lb.alt = img.alt;
  document.getElementById("lb-cap").textContent = `${G.i + 1} / ${G.n} · ${G.slides[G.i].querySelector(".g-cap").textContent}`;
}
function lightboxOpen() {
  const d = document.getElementById("lightbox");
  lightboxShow();
  d.showModal();
  hold("lightbox", true);
}

/* ------------------------------------------------------------ events */

G.root.querySelector(".g-prev").addEventListener("click", () => galleryGo(G.i - 1, -1));
G.root.querySelector(".g-next").addEventListener("click", () => galleryGo(G.i + 1, 1));
G.thumbs.forEach((b) => b.addEventListener("click", () => galleryGo(+b.dataset.go)));
G.slides.forEach((s) => s.querySelector(".g-open").addEventListener("click", (e) => {
  if (G.swiped) return e.preventDefault();
  lightboxOpen();
}));
document.getElementById("g-play").addEventListener("click", () => {
  if (G.reduced.matches) return;
  hold("user", !G.hold.has("user"));
});
G.root.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") { galleryGo(G.i + 1, 1); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { galleryGo(G.i - 1, -1); e.preventDefault(); }
  else if (e.key === "Home") { galleryGo(0, -1); e.preventDefault(); }
  else if (e.key === "End") { galleryGo(G.n - 1, 1); e.preventDefault(); }
});
G.root.addEventListener("mouseenter", () => hold("hover", true));
G.root.addEventListener("mouseleave", () => hold("hover", false));
G.root.addEventListener("focusin", () => hold("focus", true));
G.root.addEventListener("focusout", (e) => { if (!G.root.contains(e.relatedTarget)) hold("focus", false); });

/* Swipe: a horizontal drag of 40 px or more changes slide (touch and pen;
   a mouse uses the buttons). */
const stage = G.root.querySelector(".g-stage");
stage.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  G.drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  G.swiped = false;
});
stage.addEventListener("pointerup", (e) => {
  const d = G.drag;
  G.drag = null;
  if (!d || d.id !== e.pointerId) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
    G.swiped = true;
    galleryGo(G.i + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    setTimeout(() => (G.swiped = false), 50);
  }
});
stage.addEventListener("pointercancel", () => (G.drag = null));

/* Slight parallax: the active image leans toward the pointer. */
stage.addEventListener("pointermove", (e) => {
  if (G.reduced.matches || e.pointerType !== "mouse") return;
  const r = stage.getBoundingClientRect();
  stage.style.setProperty("--px", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
  stage.style.setProperty("--py", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
});
stage.addEventListener("pointerleave", () => {
  stage.style.setProperty("--px", "0");
  stage.style.setProperty("--py", "0");
});

const lb = document.getElementById("lightbox");
lb.querySelector(".lb-close").addEventListener("click", () => lb.close());
lb.querySelector(".lb-prev").addEventListener("click", () => galleryGo(G.i - 1, -1));
lb.querySelector(".lb-next").addEventListener("click", () => galleryGo(G.i + 1, 1));
lb.addEventListener("click", (e) => { if (e.target === lb) lb.close(); });
lb.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") galleryGo(G.i + 1, 1);
  else if (e.key === "ArrowLeft") galleryGo(G.i - 1, -1);
});
lb.addEventListener("close", () => {
  hold("lightbox", false);
  G.slides[G.i].querySelector(".g-open").focus({ preventScroll: true });
});

/* Autoplay only while the gallery is on screen and the tab visible. */
new IntersectionObserver(([en]) => hold("hidden", !en.isIntersecting), { threshold: 0.4 }).observe(G.root);
document.addEventListener("visibilitychange", () => hold("tab", document.hidden));
G.reduced.addEventListener?.("change", galleryArm);
window.addEventListener("resize", galleryIndicator);
G.hold.add("hidden");
requestAnimationFrame(galleryIndicator);
