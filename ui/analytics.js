"use strict";
/* The anonymous usage count (analytics.rs, docs/privacy.md): its step,
   shown by the welcome assistant or the first-launch notice (intros.js),
   and the switch in Settings › Application. Nothing is sent before its
   step is answered; a build without an Aptabase key has no step. */

const AN = { status: null };
const AN_DOC = "https://github.com/kameka22/snap-studio/blob/main/docs/privacy.md";

async function anStatus() {
  AN.status = await invoke("analytics_status").catch(() => null);
  anSettingsPaint();
  return AN.status;
}

/* The anonymous count's step (its badge, what is and is never sent, its
   switch): one build for the welcome assistant and the first-launch
   notice. Built again on a language change; the switch keeps its state. */
const AN_ICON_SENT = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
const AN_ICON_NEVER = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A8 8 0 0 1 4 12m8 8a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20"/></svg>';

function anCountBuild(host, { titleId = "" } = {}) {
  const on = host.querySelector("[data-an-on]")?.checked;
  host.innerHTML = `
    <div class="w-badge" style="--c: #30D158"><svg viewBox="0 0 24 24"><path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z"/></svg></div>
    <h1${titleId ? ` id="${titleId}"` : ""}>${esc(tr("an.title"))}</h1>
    <p class="w-lead">${esc(tr("an.why"))}</p>
    <ul class="w-features">
      <li>${AN_ICON_SENT}<span><b>${esc(tr("an.sent_k"))}</b> ${esc(tr("an.sent"))}</span></li>
      <li>${AN_ICON_NEVER}<span><b>${esc(tr("an.never_k"))}</b> ${esc(tr("an.never"))}</span></li>
    </ul>
    <label class="grow-row w-switch">
      <span class="k">${esc(tr("an.switch"))}</span>
      <input type="checkbox" class="sw" role="switch" data-an-on />
    </label>
    <p class="w-note">${esc(tr("an.where"))} <a href="#" class="w-link" data-an-doc>${esc(tr("an.more"))}</a></p>`;
  host.querySelector("[data-an-on]").checked = on ?? AN.status?.enabled !== false;
}

/* Its switch, as left. */
const anCountOn = (host) => host.querySelector("[data-an-on]").checked;

/* Whether this build can send: the step is asked only then. */
const anAvailable = () => !!AN.status?.available;

/* The step answered, the switch as left; nothing is sent before. */
async function anAnswer(enabled) {
  AN.status = await invoke("analytics_answer", { enabled }).catch(() => AN.status);
  anSettingsPaint();
}

/* Settings › Application: the same choice, at once; greyed out in a build
   that cannot send. */
function anSettingsPaint() {
  const box = $("set-analytics");
  if (!box) return;
  const st = AN.status;
  box.disabled = !st?.available;
  box.checked = !!st?.available && !!st.enabled;
  $("set-analytics-sub").textContent = tr(st?.available ? "settings.analytics.sub" : "settings.analytics.na");
}

$("set-analytics")?.addEventListener("change", async (e) => {
  AN.status = await invoke("analytics_set", { enabled: e.target.checked }).catch(() => AN.status);
  anSettingsPaint();
});
// The link is built with its step (anCountBuild): one listener for all.
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("[data-an-doc]")) return;
  e.preventDefault();
  invoke("plugin:opener|open_url", { url: AN_DOC }).catch((err) => toast(String(err), true));
});
window.addEventListener("langchange", anSettingsPaint);
anStatus();
