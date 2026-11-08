"use strict";
/* AI setup: what the AI needs, mode by mode, and how to install it.

   The user says how they want to use the AI — in a sandbox, on this Mac,
   both, or not now (`state.aiModes`). The checks (setup.rs) say which modes
   are ready. A mode is offered only when it is both chosen and ready: that
   is `aiAllowed()`, which the AI tab and Files ask.

   The same pieces serve the welcome assistant's step and Settings → AI.
   Nothing is installed from here: each missing item says how. */

const AIS = {
  report: null,
  /* The check in flight, shared by whoever asks meanwhile. */
  pending: null,
};

/* The choice: "container" (the Sandbox side), "local", "both" or "off".
   Not chosen yet (an older install, the assistant skipped) counts as
   "both": every ready mode stays usable. */
const aiChoice = () => state.aiModes || "both";

/* The Sandbox side's engine: Claude Code's built-in sandbox or yolobox
   (ai-logic.js). Decided once, at the first start that needs it, from
   what was used before: a yolobox user keeps yolobox. */
const AI_OS = /Windows/i.test(navigator.userAgent) ? "windows" : /Mac/i.test(navigator.userAgent) ? "macos" : "linux";
const aiSandbox = () => (AI_SANDBOXES.includes(state.aiSandbox) ? state.aiSandbox : "builtin");
AIS.init = (async () => {
  const list = await invoke("ia_list").catch(() => []);
  AIS.containers = (list || []).filter((c) => c.engine === "container").length;
  if (AI_SANDBOXES.includes(state.aiSandbox)) return;
  state.aiSandbox = aiSandboxDefault({ saved: state.aiSandbox, aiModes: state.aiModes, containerConversations: AIS.containers, os: AI_OS });
  save();
})();

/* What the Sandbox choice uses, in words (welcome, Settings). */
const aiSandboxSub = () => (aiSandbox() === "yolobox" ? "welcome.ai.container.sub" : "welcome.ai.sandbox.sub");

/* Another sandbox for new conversations; the existing ones keep theirs. */
function aiSetSandbox(sandbox) {
  if (!AI_SANDBOXES.includes(sandbox) || sandbox === state.aiSandbox) return;
  state.aiSandbox = sandbox;
  save();
  // Checked again with the new scope, after a check already under way.
  (AIS.pending || Promise.resolve()).then(() => aiCheck(true));
  window.dispatchEvent(new Event("aichange"));
}

/* yolobox and its engines are only checked when they matter: chosen, or
   holding a conversation. */
const aiYoloboxScope = () =>
  aiSandbox() === "yolobox" || AIS.containers > 0 || (typeof IA !== "undefined" && (IA.list || []).some((c) => c.engine === "container"));

function aiSetChoice(choice) {
  state.aiModes = choice;
  save();
  window.dispatchEvent(new Event("aichange"));
}

const aiWanted = (choice = aiChoice()) => aiWantedFor(choice, aiSandbox());

/* The modes a conversation may use now. */
function aiAllowed() {
  const r = AIS.report;
  if (!r) return [];
  return aiWanted().filter((m) => r.ready[m]);
}

/* A conversation's engine is usable: its side chosen, its engine ready. */
const aiEngineReady = (engine) => !!AIS.report?.ready[engine] && aiWantedFor(aiChoice(), aiSandbox()).map(aiSide).includes(aiSide(engine));

/* Runs the checks; `force` runs them again even if a report exists. */
function aiCheck(force = false) {
  if (AIS.pending) return AIS.pending;
  if (AIS.report && !force) return Promise.resolve(AIS.report);
  AIS.pending = AIS.init
    .then(() => invoke("ai_check", { scope: { yolobox: aiYoloboxScope() } }))
    .then((r) => (AIS.report = r))
    .catch((e) => {
      toast(String(e), true);
      return AIS.report;
    })
    .finally(() => {
      // Cleared first: a view redrawn on "aichange" no longer shows the
      // check as running, even when it failed.
      AIS.pending = null;
      window.dispatchEvent(new Event("aichange"));
    });
  return AIS.pending;
}

/* Why the AI cannot be used, in one line; null when it can. */
function aiBlockedReason() {
  if (aiChoice() === "off") return tr("ais.reason.off");
  if (!AIS.report) return tr("ais.checking");
  if (aiAllowed().length) return null;
  return tr("ais.reason.missing");
}

/* Settings, on the AI category. */
function aiOpenSettings() {
  switchView("settings");
  if (typeof setCategory === "function") setCategory("ai", false);
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-ai-settings]")) aiOpenSettings();
});

/* The first check runs in the background soon after launch: Files' "Edit
   with AI" needs to know. */
setTimeout(() => aiCheck(), 1500);

/* ------------------------------------------------------------ checklist */

const AIS_LINKS = {
  claude: "https://docs.claude.com/en/docs/claude-code/setup",
  yolobox: "https://github.com/finbarr/yolobox",
  docker: "https://www.docker.com/products/docker-desktop/",
  orbstack: "https://orbstack.dev",
  podman: "https://podman.io",
  python: "https://www.python.org/downloads/",
  sandboxing: "https://code.claude.com/docs/en/sandboxing",
};

const AIS_MODULES = ["trimesh", "manifold3d", "numpy"];

/* Rows to show for the chosen modes: the modules are folded into one. */
const AIS_HOST = ["local", "sandbox"];
function aisRows(report, choice) {
  const wanted = aiWanted(choice);
  const rows = [];
  for (const it of report.items) {
    if (!it.modes.some((m) => wanted.includes(m))) continue;
    if (AIS_MODULES.includes(it.key)) continue;
    rows.push({ ...it });
  }
  if (wanted.some((m) => AIS_HOST.includes(m))) {
    const mods = report.items.filter((i) => AIS_MODULES.includes(i.key));
    const missing = mods.filter((i) => i.state !== "ok");
    const skipped = mods.every((i) => i.state === "skipped");
    rows.push({
      key: "modules",
      modes: AIS_HOST,
      state: skipped ? "skipped" : missing.length ? "missing" : "ok",
      detail: missing.length && !skipped ? missing.map((i) => i.key).join(", ") : null,
      // Python's error for a module that is there but does not import (a
      // library it lacks, a build for another Python); "No module named"
      // is what "missing" already says.
      errors: missing.filter((i) => i.detail && !/^ModuleNotFoundError: No module named '?\w+'?$/.test(i.detail)).map((i) => `${i.key}: ${i.detail}`),
    });
  }
  return rows;
}

/* The line beside an item's name. */
function aisStatus(row, report) {
  const d = row.detail;
  switch (row.state) {
    case "ok":
      if (row.key === "runtime") return tr("ais.runtime.running", { name: aisRuntimeName(d) });
      if (row.key === "sandbox_account") return tr("ais.sandbox_account.ok");
      return d || tr("ais.ok");
    case "missing":
      if (row.key === "modules" && d) return tr("ais.modules.missing", { list: d });
      return tr("ais.missing");
    case "too_old":
      return tr("ais.too_old", { found: d, min: report.min_claude });
    case "stopped":
      return tr("ais.stopped", { name: (d || "").split(", ").map(aisRuntimeName).join(", ") });
    case "signed_out":
      return tr("ais.signed_out");
    case "skipped":
      return tr(row.key === "modules" ? "ais.modules.after_python" : "ais.account.after_claude");
    case "unsupported":
      return tr("ais.unsupported");
    case "info":
      return tr("ais.image.info");
  }
  return "";
}

const aisRuntimeName = (n) => ({ docker: "Docker", podman: "Podman", container: "container (Apple)" }[n] || n);

/* What to do about an item: text, commands to copy, links. */
function aisHelp(row, report) {
  const os = report.os;
  const cmd = (c) => ({ cmd: c });
  const link = (url, label) => ({ url, label });
  switch (`${row.key}:${row.state}`) {
    case "claude:missing":
      return {
        text: tr("ais.help.claude"),
        items: [cmd(os === "windows" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash"), link(AIS_LINKS.claude, tr("ais.link.claude"))],
      };
    case "claude:too_old":
      return { text: tr("ais.help.claude_update"), items: [cmd("claude update")] };
    case "account:signed_out":
      return { text: tr("ais.help.account"), items: [cmd("claude auth login"), { action: "auth", label: tr("auth.title") + "…" }] };
    case "yolobox:missing":
      return { text: tr("ais.help.yolobox"), items: [link(AIS_LINKS.yolobox, tr("ais.link.yolobox"))] };
    case "runtime:missing":
      return {
        text: tr(os === "macos" ? "ais.help.runtime_mac" : "ais.help.runtime"),
        items:
          os === "macos"
            ? [link(AIS_LINKS.docker, "Docker Desktop"), link(AIS_LINKS.orbstack, "OrbStack"), link(AIS_LINKS.podman, "Podman")]
            : [link("https://docs.docker.com/engine/install/", "Docker Engine"), link(AIS_LINKS.podman, "Podman")],
      };
    case "runtime:stopped": {
      const names = (row.detail || "").split(", ");
      const items = [];
      if (names.includes("docker") && os === "macos") items.push(cmd("open -a Docker"));
      if (names.includes("podman")) items.push(cmd("podman machine start"));
      if (names.includes("container")) items.push(cmd("container system start"));
      return { text: tr("ais.help.runtime_stopped"), items };
    }
    case "runtime:unsupported":
      return { text: tr("ais.help.unsupported"), items: [] };
    case "builtin:unsupported":
      return { text: tr("ais.help.builtin_unsupported"), items: [] };
    case "seatbelt:missing":
      return { text: tr("ais.help.seatbelt"), items: [link(AIS_LINKS.sandboxing, tr("ais.link.sandboxing"))] };
    case "bwrap:missing":
    case "socat:missing":
      // Installed is all the check sees; AppArmor may still stop bwrap.
      return {
        text: tr("ais.help.bwrap"),
        items: [cmd("sudo apt-get install bubblewrap socat"), cmd("sudo dnf install bubblewrap socat"), cmd("sudo pacman -S bubblewrap socat"), link(AIS_LINKS.sandboxing, tr("ais.link.apparmor"))],
      };
    case "python:missing":
      return {
        text: tr("ais.help.python"),
        items:
          os === "macos"
            ? [cmd("xcode-select --install"), cmd("brew install python"), link(AIS_LINKS.python, "python.org")]
            : os === "windows"
              ? [link(AIS_LINKS.python, "python.org")]
              : [cmd("sudo apt install python3 python3-pip"), link(AIS_LINKS.python, "python.org")],
      };
    case "modules:missing":
      return {
        text: tr(report.python_managed ? "ais.help.modules_managed" : "ais.help.modules"),
        items: [
          ...(row.errors || []).map((e) => ({ note: e })),
          cmd(
            `python3 -m pip install --user${report.python_managed ? " --break-system-packages" : ""} ${AIS_MODULES.join(" ")}`
          ),
          // A Python newer than manifold3d's wheels builds it, which needs TBB.
          ...(os === "macos" ? [{ note: tr("ais.help.modules_tbb") }, cmd("brew install tbb")] : []),
        ],
      };
  }
  return null;
}

const AIS_MARK = { ok: "✓", info: "·", signed_out: "!", skipped: "·" };
const aisMark = (s) => AIS_MARK[s] || "✕";
/* Row classes, prefixed: `.info` and `.warn` already style other things. */
const aisKind = (s) => "ais-" + (s === "ok" ? "ok" : s === "info" || s === "skipped" ? "note" : s === "signed_out" ? "todo" : "bad");

/* Groups: what both modes need, then each mode. */
function aisGroups(rows, choice) {
  const wanted = aiWanted(choice);
  const both = rows.filter((r) => wanted.every((m) => r.modes.includes(m)) && wanted.length > 1);
  const rest = rows.filter((r) => !both.includes(r));
  if (wanted.length < 2) return [{ title: null, rows }];
  return [
    { title: tr("ais.group.common"), rows: both },
    // The Sandbox side: the built-in sandbox or the container, as chosen.
    ...wanted.filter((m) => m !== "local").map((m) => ({ title: tr("ais.group.container"), rows: rest.filter((r) => r.modes.includes(m)), mode: m })),
    { title: tr("ais.group.local"), rows: rest.filter((r) => r.modes.includes("local")), mode: "local" },
  ];
}

/* The checklist for a choice, into `box`. */
function aiRenderChecks(box, choice = aiChoice()) {
  const r = AIS.report;
  box.classList.add("ais-checks");
  if (aiWanted(choice).length === 0) {
    box.innerHTML = `<p class="ais-note">${esc(tr("ais.off_note"))}</p>`;
    return;
  }
  if (!r || AIS.pending) {
    box.innerHTML = `<p class="ais-note ais-spin">${esc(tr("ais.checking"))}</p>`;
    return;
  }
  const wanted = aiWanted(choice);
  const ready = wanted.filter((m) => r.ready[m]);
  const rows = aisRows(r, choice);
  const todo = rows.filter((x) => x.state !== "ok" && x.state !== "info").length;
  const head = ready.length
    ? tr("ais.head.ready", { modes: ready.map((m) => tr("ais.mode." + m)).join(" · ") })
    : tr("ais.head.todo", { n: todo });
  let html = `<div class="ais-head ${ready.length ? "ok" : "bad"}">${esc(head)}</div>`;
  for (const g of aisGroups(rows, choice)) {
    if (!g.rows.length) continue;
    if (g.title) {
      const tag = g.mode ? `<span class="ais-tag ${r.ready[g.mode] ? "ok" : "bad"}">${esc(tr(r.ready[g.mode] ? "ais.tag.ready" : "ais.tag.blocked"))}</span>` : "";
      html += `<div class="ais-group">${esc(g.title)}${tag}</div>`;
    }
    for (const row of g.rows) {
      const help = row.state === "ok" ? null : aisHelp(row, r);
      html += `<div class="ais-row ${aisKind(row.state)}">
        <span class="ais-mark">${aisMark(row.state)}</span>
        <span class="ais-name">${esc(tr("ais.item." + row.key))}</span>
        <span class="ais-status">${esc(aisStatus(row, r))}</span>
        ${help ? `<div class="ais-help"><p>${esc(help.text)}</p>${help.items
          .map((h) =>
            h.note
              ? `<p>${esc(h.note)}</p>`
              : h.cmd
              ? `<div class="ais-cmd"><code>${esc(h.cmd)}</code><button class="btn small" data-copy="${esc(h.cmd)}">${esc(tr("ais.copy"))}</button></div>`
              : h.url
                ? `<button class="w-link" data-url="${esc(h.url)}">${esc(h.label)} ↗</button>`
                : `<button class="btn small" data-action="${esc(h.action)}">${esc(h.label)}</button>`
          )
          .join("")}</div>` : ""}
      </div>`;
    }
  }
  box.innerHTML = html;
}

/* Copy, links and actions of every checklist, wherever it is shown. */
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".ais-checks [data-copy], .ais-checks [data-url], .ais-checks [data-action]");
  if (!b) return;
  if (b.dataset.copy) {
    await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
    const was = b.textContent;
    b.textContent = tr("ais.copied");
    setTimeout(() => (b.textContent = was), 1200);
  } else if (b.dataset.url) {
    invoke("plugin:opener|open_url", { url: b.dataset.url }).catch((err) => toast(String(err), true));
  } else if (b.dataset.action === "auth") {
    authOpen();
  }
});

/* The account window may have signed Claude in: check again when it closes. */
window.addEventListener("authchange", () => aiCheck(true));
