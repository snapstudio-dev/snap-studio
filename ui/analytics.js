"use strict";
/* The anonymous usage count (analytics.rs, docs/privacy.md): the notice
   at first launch and the switch in Settings › Application.

   The notice opens once, when this build can send and it was never
   answered: for a new user after the welcome assistant, for an existing
   one at the first launch of a version that has it (welcome.js calls
   analyticsNotice). Its switch is on; "Got it", Escape or closing keep the
   switch as it is. Nothing is sent before it is answered. */

const AN = { status: null, open: false };
const AN_DOC = "https://github.com/kameka22/snap-studio/blob/main/docs/privacy.md";

async function anStatus() {
  AN.status = await invoke("analytics_status").catch(() => null);
  anSettingsPaint();
  return AN.status;
}

/* Opens the notice if this build can send and it was never answered. */
async function analyticsNotice() {
  const st = AN.status || (await anStatus());
  if (!st?.available || st.noticed || AN.open) return;
  AN.open = true;
  $("an-switch").checked = st.enabled;
  const modal = $("anmodal");
  openSheet(modal);
  requestAnimationFrame(() => $("an-ok").focus());
  const done = async () => {
    if (!AN.open) return;
    AN.open = false;
    modal.onkeydown = $("an-ok").onclick = null;
    closeSheet(modal);
    AN.status = await invoke("analytics_answer", { enabled: $("an-switch").checked }).catch(() => AN.status);
    anSettingsPaint();
  };
  $("an-ok").onclick = done;
  modal.onkeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };
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
document.querySelectorAll("[data-an-doc]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: AN_DOC }).catch((err) => toast(String(err), true));
  })
);
window.addEventListener("langchange", anSettingsPaint);
anStatus();
