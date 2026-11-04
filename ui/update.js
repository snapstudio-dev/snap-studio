"use strict";
/* Application updates.

   At launch (when the Settings box is ticked) and on demand — Settings
   button, Snap Studio menu — Rust queries the latest GitHub release. A new
   version: a sheet offers to install it; the package is downloaded, its
   signature checked, then the app restarts. */

const UP = {
  found: null,
  checking: false,
  installing: false,
  /* Status line shown in Settings, as a key and its parameters. */
  status: ["update.never", {}],
  prefs: { auto: true, last: null, ...storedObject("snapstudio.update") },
};

const UP_RELEASES = "https://github.com/kameka22/snap-studio/releases/latest";

function upSave() {
  localStorage.setItem("snapstudio.update", JSON.stringify(UP.prefs));
}

function upStatus(key = UP.status[0], params = UP.status[1]) {
  UP.status = [key, params];
  const when = UP.prefs.last ? " · " + tr("update.checked_on", { date: fmtDate(UP.prefs.last / 1000) }) : "";
  $("up-status").textContent = tr(key, params) + when;
}

/* `manual`: asked by the user, who expects an answer even when everything is
   up to date; at launch, stay silent unless there is a new version. */
async function upCheck(manual) {
  if (UP.checking || UP.installing) return;
  UP.checking = true;
  $("up-check").disabled = true;
  $("up-status").textContent = tr("update.checking");
  try {
    const r = await invoke("update_check");
    UP.prefs.last = Date.now();
    upSave();
    UP.found = r;
    upBadge();
    $("up-check").textContent = tr(r ? "common.show" : "settings.update_check");
    if (r) {
      upStatus("update.available", { version: r.version });
      // On its own, the sheet opens once per version; the badge stays.
      if (manual || UP.prefs.offered !== r.version) {
        UP.prefs.offered = r.version;
        upSave();
        upOpen();
      }
    } else {
      upStatus("update.uptodate");
      if (manual) toast(tr("update.uptodate"));
    }
  } catch (e) {
    upStatus("update.failed");
    if (manual) toast(tr("update.failed_err", { err: e }), true);
  } finally {
    UP.checking = false;
    $("up-check").disabled = false;
  }
}

/* Beside Settings: an arrow and the new version, while one is waiting. */
function upBadge() {
  const b = $("side-update");
  b.classList.toggle("hidden", !UP.found);
  b.querySelector("b").textContent = UP.found?.version || "";
}
$("side-update").addEventListener("click", (e) => {
  e.stopPropagation();
  upOpen();
});

function upOpen() {
  const r = UP.found;
  if (!r) return;
  $("u-sub").textContent = tr("update.sub", { version: r.version, current: r.current });
  $("u-notes").textContent = r.notes || tr("update.no_notes");
  $("u-progress").classList.add("hidden");
  $("u-msg").textContent = r.installable ? "" : tr("update.manual");
  $("u-go").textContent = tr(r.installable ? "update.install" : "update.open_page");
  $("u-go").disabled = false;
  $("u-later").disabled = false;
  openSheet($("umodal"));
}

/* A slice or an upload in progress would be lost on restart. */
const upBusy = () => Boolean(SL.job || SL.sending);

async function upInstall() {
  const r = UP.found;
  if (!r || UP.installing) return;
  if (!r.installable) {
    invoke("plugin:opener|open_url", { url: UP_RELEASES }).catch((e) => toast(String(e), true));
    closeSheet($("umodal"));
    return;
  }
  UP.installing = true;
  $("u-go").disabled = true;
  $("u-later").disabled = true;
  while (upBusy()) {
    $("u-msg").textContent = tr("update.wait_busy");
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  $("u-msg").textContent = tr("update.downloading");
  $("u-progress").classList.remove("hidden");
  $("u-progress").firstElementChild.style.width = "2%";
  try {
    // On success the app restarts: this call never returns.
    await invoke("update_install");
  } catch (e) {
    UP.installing = false;
    $("u-progress").classList.add("hidden");
    $("u-msg").textContent = tr("update.install_failed", { err: e });
    $("u-go").disabled = false;
    $("u-later").disabled = false;
    // Rust consumed the update: a new check finds it again.
    UP.found = null;
    upBadge();
    $("up-check").textContent = tr("settings.update_check");
    upCheck(false);
  }
}

listen("update-progress", (e) => {
  const { done, total } = e.payload;
  if (!total) {
    $("u-msg").textContent = tr("update.downloading_n", { done: fmtSize(done) });
    return;
  }
  const pct = Math.min(100, (done / total) * 100);
  $("u-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
  $("u-msg").textContent = pct >= 100
    ? tr("update.installing")
    : tr("update.downloading_of", { done: fmtSize(done), total: fmtSize(total) });
});

$("u-go").addEventListener("click", upInstall);
$("u-later").addEventListener("click", () => {
  if (!UP.installing) closeSheet($("umodal"));
});
$("umodal").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !UP.installing) closeSheet($("umodal"));
});
$("up-check").addEventListener("click", () => {
  // A version already found: reopen the sheet rather than ask again.
  if (UP.found) upOpen();
  else upCheck(true);
});
$("up-auto").addEventListener("change", () => {
  UP.prefs.auto = $("up-auto").checked;
  upSave();
});
onMenu("app", (what) => {
  if (what === "update") {
    if (UP.found) upOpen();
    else upCheck(true);
  }
});

window.addEventListener("langchange", () => {
  if (!UP.checking) upStatus();
  $("up-check").textContent = tr(UP.found ? "common.show" : "settings.update_check");
  if (UP.found && !$("umodal").classList.contains("hidden") && !UP.installing) upOpen();
});

(async () => {
  $("up-auto").checked = UP.prefs.auto;
  upStatus();
  $("up-version").textContent = await invoke("app_version").catch(() => "—");
  // Let the app finish starting before going to the network.
  // No update sheet over the welcome assistant.
  if (UP.prefs.auto) setTimeout(() => !W.open && upCheck(false), 3000);
  // An app left open for days still hears of new versions.
  setInterval(() => UP.prefs.auto && !W.open && upCheck(false), 6 * 3600 * 1000);
})();
