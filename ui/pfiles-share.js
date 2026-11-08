"use strict";
/* Sharing a printer's file (print file or timelapse).

   The sheet shows what is shared, then the ways: the system's share menu
   (AirDrop, Messages, Mail… — macOS), a QR code for a phone on the same
   network, the file on the clipboard, Save As. The file is fetched from
   the printer once, on the first choice (share.rs keeps the copy). */

/* `gen` counts the sheet's openings and closings: an action started on a
   file the sheet has since left must not act on it. */
const PFS = { file: null, pid: null, local: new Map(), caps: null, timer: 0, until: 0, busy: false, gen: 0 };

const pfsLocalKey = (f) => `${PFS.pid}|${pflKey(f)}|${f.modified}`;

/* What is shared, under its title: kind, length (videos), size, date. */
function pfsSub(f) {
  const video = f.root !== "gcodes";
  const d = video ? PFL.durations.get(pflKey(f)) : null;
  return [tr(video ? "share.kind.video" : "share.kind.file"), d ? pflClock(d) : "", fmtSize(f.size), f.modified ? fmtDate(f.modified) : ""]
    .filter(Boolean)
    .join(" · ");
}

async function pfsOpen(f) {
  if (!f) return;
  PFS.gen++;
  pfsBusy(false);
  PFS.file = f;
  PFS.pid = PFL.pid;
  if (!PFS.caps) PFS.caps = await invoke("share_caps").catch(() => ({ native: false, copy: false }));
  const video = f.root !== "gcodes";
  $("pfs-title").textContent = tr("share.title", { name: pflName(f.path) });
  $("pfs-sub").textContent = pfsSub(f);
  $("pfs-icon").innerHTML = video ? PFL_ICON_FILM : PFL_ICON_FILE;
  const th = $("pfs-thumb");
  const src = pflThumb(f);
  th.classList.add("hidden");
  $("pfs-icon").classList.remove("hidden");
  if (src) {
    th.onload = () => {
      th.classList.remove("hidden");
      $("pfs-icon").classList.add("hidden");
    };
    th.onerror = () => th.classList.add("hidden");
    th.src = src;
  }
  // What this system can do.
  document.querySelector('#pfs-grid [data-share="native"]').classList.toggle("hidden", !PFS.caps.native);
  document.querySelector('#pfs-grid [data-share="copy"]').classList.toggle("hidden", !PFS.caps.copy);
  pfsShowGrid();
  pfsMsg("");
  openSheet($("pfshare"));
  requestAnimationFrame(() => document.querySelector("#pfs-grid .pfs-tile:not(.hidden)")?.focus());
}

function pfsMsg(text, cls = "") {
  $("pfs-msg").textContent = text;
  $("pfs-msg").className = "pf-test" + (cls ? " " + cls : "");
}

function pfsBusy(on) {
  PFS.busy = on;
  document.querySelectorAll("#pfs-grid .pfs-tile").forEach((b) => (b.disabled = on));
}

/* The local copy of `f`: fetched from the printer the first time. */
async function pfsLocal(f, pid) {
  const key = pfsLocalKey(f);
  if (PFS.local.has(key)) return PFS.local.get(key);
  pfsMsg(tr("share.fetching"), "busy");
  const path = await invoke("share_fetch", { printerId: pid, root: f.root, path: f.path, modified: f.modified || 0 });
  PFS.local.set(key, path);
  pfsMsg("");
  return path;
}

async function pfsDo(kind, tile) {
  if (PFS.busy || !PFS.file) return;
  // The file and printer of this action: the sheet may show another one
  // by the time the fetch ends (closed with Escape, opened on a second
  // file), and that one must not be shared under this one's title.
  const { file: f, pid, gen } = PFS;
  pfsBusy(true);
  try {
    const path = await pfsLocal(f, pid);
    if (gen !== PFS.gen) return;
    if (kind === "native") {
      // The menu opens under the tile.
      const r = tile.getBoundingClientRect();
      await invoke("share_native", { path, x: r.left + r.width / 2, y: r.bottom });
    } else if (kind === "copy") {
      await invoke("share_copy", { path });
      pfsMsg(tr("share.copied"), "ok");
    } else if (kind === "save") {
      const name = f.path.split("/").pop();
      const dest = await window.__TAURI__.dialog.save({ defaultPath: name }).catch(() => null);
      if (dest) {
        await invoke("share_save", { path, dest });
        pfsMsg(tr("share.saved", { name: dest.split(/[\\/]/).pop() }), "ok");
      }
    } else if (kind === "qr") {
      const s = await invoke("share_qr_start", { path, printerId: PFS.pid });
      pfsShowQr(s);
    }
  } catch (e) {
    console.warn("share", String(e.message || e));
    pfsMsg(errNoUrl(e.message || e), "err");
  } finally {
    pfsBusy(false);
  }
}

/* ------------------------------------------------------------ QR code */

function pfsShowGrid() {
  clearInterval(PFS.timer);
  $("pfs-grid").classList.remove("hidden");
  $("pfs-qr").classList.add("hidden");
}

function pfsShowQr(s) {
  // The SVG comes from the app (share.rs), not from the printer.
  $("pfs-code").innerHTML = s.svg;
  $("pfs-url").textContent = s.url;
  $("pfs-grid").classList.add("hidden");
  $("pfs-qr").classList.remove("hidden");
  pfsMsg("");
  PFS.until = Date.now() + s.seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((PFS.until - Date.now()) / 1000));
    $("pfs-left").textContent = left ? tr("share.qr.left", { time: pflClock(left) }) : tr("share.qr.expired");
    if (!left) clearInterval(PFS.timer);
  };
  clearInterval(PFS.timer);
  tick();
  PFS.timer = setInterval(tick, 1000);
  $("pfs-qrback").focus();
}

function pfsStopQr() {
  clearInterval(PFS.timer);
  invoke("share_qr_stop").catch(() => {});
}

function pfsClose() {
  PFS.gen++; // an action still fetching ends without acting
  pfsStopQr();
  closeSheet($("pfshare"));
}

/* ------------------------------------------------------------ events */

$("pfs-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-share]");
  if (b && !b.disabled) pfsDo(b.dataset.share, b);
});
$("pfs-qrback").addEventListener("click", () => {
  pfsStopQr();
  pfsShowGrid();
});
$("pfs-close").addEventListener("click", pfsClose);
$("pfshare").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    pfsClose();
  }
});
window.addEventListener("langchange", () => {
  if (!$("pfshare").classList.contains("hidden") && PFS.file) {
    $("pfs-title").textContent = tr("share.title", { name: pflName(PFS.file.path) });
    $("pfs-sub").textContent = pfsSub(PFS.file);
  }
});
