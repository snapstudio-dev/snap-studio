"use strict";
/* Feature introductions: what a version brings that needs a word and a
   choice (Snappy, the anonymous count, the next ones). One entry each in
   INTROS, in the order shown; nothing else to add for a new one but its
   entry and its texts.

   - A new user meets them in the welcome assistant (welcome.js), as its
     steps after the AI: every one available, applied when it closes.
   - A user who had the app before meets those not seen yet in the
     first-launch notice, below, at the first launch of a version that
     brings them; nothing follows the welcome assistant.

   An entry:
   - id;
   - available(): whether it has a place now (a build without an Aptabase
     key has no count to ask about);
   - seen(): whether it was answered already;
   - build(host, { notice }): the step's content, in the welcome
     assistant's look (w-badge, w-features, w-switch); built again on a
     language change, keeping the choice made; its title's id is
     `${host.id}-title`;
   - enter(host): the choice as things are now, when first shown;
   - apply(host): the choice applied, the entry marked seen;
   - summary(host): optional, the welcome summary's row, [ok, title, sub]
     (ok: true, false, or null for "later").

   `SNAP_PREVIEW_NOTICES=1` (debug builds, lib.rs notices_preview) shows
   the notice at every start with every entry, applying nothing. */

const INTROS = [
  {
    id: "snappy",
    available: () => true,
    seen: () => snappyIntroduced(),
    build: (host, { notice }) => snappyIntroBuild(host, { kicker: notice, titleId: host.id + "-title" }),
    enter: (host) => {
      // Snappy needs the AI: without it, its switch is locked off and says
      // why; its own setting stays for when the AI comes back.
      const noAi = typeof aiChoice === "function" && aiChoice() === "off";
      snappyIntroSet(host, SNAP.enabled && !noAi, noAi);
    },
    apply: (host) => {
      const sw = host.querySelector("[data-snappy-on]");
      if (!sw.disabled && sw.checked !== SNAP.enabled) snappySetEnabled(sw.checked);
      snappyIntroDone();
    },
    summary: (host) => {
      const on = host.querySelector("[data-snappy-on]").checked;
      return [on ? true : null, "Snappy", tr(on ? "snappy.intro.sum_on" : "welcome.sum.ai.later")];
    },
  },
  {
    id: "analytics",
    available: () => anAvailable(),
    seen: () => !!AN.status?.noticed,
    build: (host) => anCountBuild(host, { titleId: host.id + "-title" }),
    enter: (host) => (host.querySelector("[data-an-on]").checked = AN.status?.enabled !== false),
    apply: (host) => anAnswer(anCountOn(host)),
  },
];

/* An entry's step, empty until built. */
function introSection(entry, prefix) {
  const s = document.createElement("section");
  s.className = "w-step";
  s.id = `${prefix}-${entry.id}`;
  s.dataset.intro = entry.id;
  return s;
}

/* Shown for the first time: built, and its choice as things are now. */
function introShow(entry, host, { notice = false } = {}) {
  entry.build(host, { notice });
  if (!host.dataset.entered) {
    host.dataset.entered = "1";
    entry.enter(host);
  }
}

/* ------------------------------------------------------------ the notice */

/* The first-launch notice: the welcome assistant's track, dots and
   buttons, with the entries not seen yet. */
const NT = { open: false, list: [], at: 0, preview: false };

function ntShow() {
  const steps = [...$("nt-track").children];
  steps.forEach((el, i) => {
    el.classList.toggle("on", i === NT.at);
    el.inert = i !== NT.at;
  });
  $("nt-track").style.transform = `translateX(${-100 * NT.at}%)`;
  $("nt-dots").innerHTML = NT.list.length > 1 ? NT.list.map((_, i) => `<i class="${i === NT.at ? "on" : ""}"></i>`).join("") : "";
  $("nt-back").classList.toggle("invisible", NT.at === 0);
  $("nt-ok").textContent = tr(NT.at < NT.list.length - 1 ? "common.continue" : "an.ok");
  document.querySelector("#ntmodal .nt-card").setAttribute("aria-labelledby", `${steps[NT.at].id}-title`);
}

/* Opens the notice with the entries not seen yet; none, nothing opens. */
async function launchNotices() {
  if (NT.open) return;
  await (AN.status || anStatus());
  NT.preview = await invoke("notices_preview").catch(() => false);
  NT.list = introsFor("notice", INTROS, { preview: NT.preview });
  if (!NT.list.length) return;
  NT.open = true;
  NT.at = 0;
  const track = $("nt-track");
  track.innerHTML = "";
  for (const entry of NT.list) {
    const host = introSection(entry, "nt");
    track.appendChild(host);
    introShow(entry, host, { notice: true });
  }
  const modal = $("ntmodal");
  ntShow();
  openSheet(modal);
  requestAnimationFrame(() => $("nt-ok").focus());
  const done = () => {
    if (!NT.open) return;
    NT.open = false;
    modal.onkeydown = $("nt-ok").onclick = $("nt-back").onclick = null;
    closeSheet(modal);
    if (NT.preview) return;
    NT.list.forEach((entry, i) => entry.apply(track.children[i]));
  };
  $("nt-ok").onclick = () => {
    if (NT.at < NT.list.length - 1) {
      NT.at++;
      ntShow();
    } else done();
  };
  $("nt-back").onclick = () => {
    NT.at = Math.max(0, NT.at - 1);
    ntShow();
  };
  // Escape or closing: the choices as they are.
  modal.onkeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };
}

window.addEventListener("langchange", () => {
  if (!NT.open) return;
  NT.list.forEach((entry, i) => entry.build($("nt-track").children[i], { notice: true }));
  ntShow();
});
