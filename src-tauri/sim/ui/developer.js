"use strict";
/* Settings › Developer: simulated printers. Only in a development build
   with the simulator (Cargo feature `sim`): src-tauri/src/sim/mod.rs adds
   this script to the main window, after `window.SIM` (the simulation's
   status); nothing of it is in ui/, so a release bundle has none of it.
   English only, by design: no tr(), no translation keys.

   Turning simulation on or off, the scenario, the printers and the time
   factor are saved in the dev-only sim.json and take effect at the
   restart that follows. Faults and spools act on the running printers. */
(() => {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const listen = (ev, f) => window.__TAURI__.event.listen(ev, f);
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const STYLE = `
.sim-pill { margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: #c62828; color: #fff;
  font-size: 10px; font-weight: 700; letter-spacing: .06em; line-height: 16px; white-space: nowrap; }
.sim-badge { display: inline-block; margin: 0 6px 0 4px; padding: 0 5px; border-radius: 4px; background: rgba(198, 40, 40, .14);
  color: #c62828; font-size: 9px; font-weight: 700; letter-spacing: .05em; line-height: 15px; vertical-align: middle; }
/* The sidebar is narrow: the short form there, the name stays readable. */
.side-item .sim-badge { flex: none; margin: 0 4px; padding: 0 3px; font-size: 0; letter-spacing: 0; line-height: 13px; }
.side-item .sim-badge::before { content: "SIM"; font-size: 8px; }
.dev-pane .dev-printer { padding: 10px 12px; display: grid; gap: 8px; }
.dev-pane .dev-printer + .dev-printer { border-top: 1px solid var(--card-border); }
.dev-pane .dev-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.dev-pane .dev-line input[type="text"] { flex: 1; min-width: 140px; }
.dev-pane .dev-line input[type="number"] { width: 64px; }
.dev-pane .dev-spool { display: inline-flex; align-items: center; gap: 4px; }
.dev-pane .dev-spool input[type="color"] { width: 26px; height: 22px; padding: 0; border: none; background: none; }
.dev-pane .dev-muted { color: var(--text-2, #888); font-size: 11px; }
.dev-pane .dev-err { color: var(--danger, #c62828); font-size: 12px; }
.dev-pane .dev-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 12px; }
.dev-pane .dev-faults { font-size: 11px; color: #c62828; }
.dev-pane .set-sub { font-size: 12px; font-weight: 600; margin: 18px 4px 6px; opacity: .7; }
`;

  const STATES = [
    ["idle", "Idle"],
    ["printing", "Printing"],
    ["paused", "Paused"],
    ["error", "Last print failed"],
    ["klippy_shutdown", "Klipper shut down"],
  ];
  const FAULT_ARGS = {
    disconnect: [["secs", "seconds", 30]],
    unreachable: [["secs", "seconds (0: until cleared)", 60]],
    slow: [["ms", "ms per answer", 3000]],
    klippy_shutdown: [["message", "message", ""]],
    klippy_error: [["message", "message", ""]],
    runout: [["head", "head", 0]],
    upload_fail: [["at", "% of the file", 50]],
    start_refused: [["message", "message", ""]],
    print_error: [["message", "message", ""]],
  };

  const D = { data: null, cfg: null, printers: [], edited: false, error: "" };
  let pane = null;

  /* ------------------------------------------------------------ badges */

  function pill() {
    if (!window.SIM?.on || document.querySelector(".sim-pill")) return;
    const brand = document.querySelector(".side-brand");
    if (!brand) return;
    const p = document.createElement("span");
    p.className = "sim-pill";
    p.textContent = window.SIM.pill;
    p.title = `Simulated printers: ${window.SIM.scenario || ""}${window.SIM.speed > 1 ? ` at x${window.SIM.speed}` : ""}`;
    brand.appendChild(p);
  }

  /* A printer saved meanwhile may be a simulated one: the list comes back
     from the backend, the sidebar gets its badges. */
  let refreshing = false;
  async function refreshStatus() {
    if (refreshing) return;
    refreshing = true;
    try {
      window.SIM = await invoke("sim_status");
      for (const el of document.querySelectorAll("#side-printers > .side-item[data-id]")) {
        if (window.SIM.printers.includes(el.dataset.id) && !el.querySelector(".sim-badge")) {
          el.querySelector(".lbl")?.insertAdjacentHTML("afterend", `<span class="sim-badge">${h(window.SIM.label)}</span>`);
        }
      }
    } finally {
      refreshing = false;
    }
  }

  /* ------------------------------------------------------------ section */

  async function load(scenario) {
    try {
      D.data = await invoke("sim_config", scenario ? { scenario } : {});
      D.error = "";
    } catch (e) {
      D.error = String(e);
      if (!D.data) return;
    }
    if (!scenario) {
      D.cfg = { ...D.data.config };
      D.edited = !!D.data.config.printers;
    } else {
      D.cfg.scenario = scenario;
      D.edited = false;
    }
    D.printers = structuredClone(D.data.printers);
    render();
  }

  const isBuiltIn = (name) => D.data.scenarios.some((s) => s.name === name);

  function render() {
    if (!pane || !D.data) return;
    const st = D.data.status;
    const c = D.cfg;
    const running = st.on
      ? `Running: ${h(st.scenario)} at x${st.speed}${st.from_env ? " (from SNAP_SIM, which wins over these settings)" : ""}.`
      : "Not running: the app uses your own printers.";
    const scenOpts = D.data.scenarios
      .map((s) => `<option value="${h(s.name)}"${s.name === c.scenario ? " selected" : ""}>${h(s.name)} (${s.printers} printer${s.printers > 1 ? "s" : ""})</option>`)
      .join("") + `<option value="__file"${isBuiltIn(c.scenario) ? "" : " selected"}>Scenario file…</option>`;
    const desc = D.data.scenarios.find((s) => s.name === c.scenario)?.description || "A scenario file of the same shape as src-tauri/sim/scenarios/*.json.";
    const factors = D.data.factors.map((f) => `<option value="${f}"${f === c.speed ? " selected" : ""}>x${f}</option>`).join("");
    const changed = JSON.stringify({ on: c.on, scenario: c.scenario, speed: c.speed, printers: D.edited ? D.printers : null }) !==
      JSON.stringify({ on: D.data.config.on, scenario: D.data.config.scenario, speed: D.data.config.speed, printers: D.data.config.printers });
    const go = c.on ? (st.on ? "Apply and restart" : "Restart in simulation") : st.on ? "Leave simulation" : "Apply";
    pane.innerHTML = `<div class="settings-page dev-pane">
      <h2 class="set-title">Developer</h2>
      <div class="group">
        <label class="grow-row"><span class="k">Simulated printers
          <span class="sub">Runs the app on simulated Snapmaker U1 printers instead of your own, with its own printer data, emptied at each launch. Your printers and their records are not touched. The app restarts.</span></span>
          <input type="checkbox" class="sw" role="switch" data-dev="on"${c.on ? " checked" : ""} /></label>
        <div class="grow-row"><span class="k">Scenario<span class="sub">${h(desc)}</span></span><select data-dev="scenario">${scenOpts}</select></div>
        ${isBuiltIn(c.scenario) ? "" : `<div class="grow-row"><span class="k">Scenario file</span><input type="text" data-dev="file" value="${h(c.scenario === "__file" ? "" : c.scenario)}" placeholder="/path/to/scenario.json" style="flex: 2" /></div>`}
        <div class="grow-row"><span class="k">Time factor<span class="sub">Simulated time runs this much faster. A print always lasts at least 2 minutes, for the queue to see it end.</span></span><select data-dev="speed">${factors}</select></div>
        <div class="grow-row"><span class="k dev-muted">${running}${st.error ? `<br><span class="dev-err">${h(st.error)}</span>` : ""}</span></div>
      </div>
      <h3 class="set-sub">Simulated printers${D.edited ? " (edited)" : ""}</h3>
      <div class="group">${D.printers.map(printerRow).join("")}
        <div class="dev-actions">
          ${D.edited ? `<button class="btn small" data-dev="reset">Back to the scenario's printers</button>` : ""}
          <button class="btn small" data-dev="add">Add a printer</button>
        </div>
      </div>
      ${D.error ? `<div class="dev-err">${h(D.error)}</div>` : ""}
      <div class="dev-actions"><button class="btn primary" data-dev="apply"${changed ? "" : " disabled"}>${h(go)}</button></div>
      ${st.on && D.data.running.length ? faultsGroup() : ""}
    </div>`;
  }

  function printerRow(p, i) {
    const spools = [0, 1, 2, 3]
      .map((n) => {
        const s = (p.spools || [])[n] || { type: "", color: "#ffffff", present: false };
        const kinds = ["", ...D.data.materials];
        const sel = kinds.map((k) => `<option value="${h(k)}"${k === (s.present === false ? "" : s.type) ? " selected" : ""}>${k ? h(k) : "Empty"}</option>`).join("");
        return `<span class="dev-spool">T${n}<select data-spool-type="${i}:${n}">${sel}</select><input type="color" data-spool-color="${i}:${n}" value="${h(s.color || "#ffffff")}" /></span>`;
      })
      .join("");
    const states = STATES.map(([v, l]) => `<option value="${v}"${v === (p.start || "idle") ? " selected" : ""}>${l}</option>`).join("");
    const busy = p.start === "printing" || p.start === "paused";
    return `<div class="dev-printer">
      <div class="dev-line"><input type="text" data-p-name="${i}" value="${h(p.name)}" /><span class="dev-muted">${h(p.hostname)} · ${h(p.serial)}</span>
        <button class="btn small danger" data-p-remove="${i}">Remove</button></div>
      <div class="dev-line">At launch <select data-p-start="${i}">${states}</select>
        ${busy ? `at <input type="number" min="0" max="99" data-p-progress="${i}" value="${Math.round((p.progress || 0) * 100)}" /> %` : ""}</div>
      <div class="dev-line">${spools}</div>
    </div>`;
  }

  function faultsGroup() {
    const rows = D.data.running
      .map((r) => `<div class="grow-row"><span class="k">${h(r.name)}<span class="sub">127.0.0.1:${r.port} · ${h(r.state)}${r.klippy !== "ready" ? ` · Klipper ${h(r.klippy)}` : ""}</span>
        ${r.faults.length ? `<span class="dev-faults">${r.faults.map(h).join(", ")}</span>` : ""}</span>
        <button class="btn small" data-clear="${h(r.id)}"${r.faults.length ? "" : " disabled"}>Clear faults</button></div>`)
      .join("");
    const printers = D.data.running.map((r) => `<option value="${h(r.id)}">${h(r.name)}</option>`).join("");
    const faults = D.data.faults.map((f) => `<option value="${f}">${f.replaceAll("_", " ")}</option>`).join("");
    const kinds = D.data.materials.map((k) => `<option value="${h(k)}">${h(k)}</option>`).join("");
    return `<h3 class="set-sub">Faults and spools</h3>
      <div class="group">${rows}
        <div class="grow-row"><span class="k">Inject a fault<span class="sub" data-dev="fault-args"></span></span>
          <select data-dev="fault-printer">${printers}</select><select data-dev="fault">${faults}</select>
          <button class="btn small" data-dev="inject">Inject</button></div>
        <div class="grow-row"><span class="k">Load a spool<span class="sub">Ends a runout; the spool check sees the change.</span></span>
          <select data-dev="spool-printer">${printers}</select>
          <select data-dev="spool-head"><option value="0">T0</option><option value="1">T1</option><option value="2">T2</option><option value="3">T3</option></select>
          <select data-dev="spool-type">${kinds}</select><input type="color" data-dev="spool-color" value="#d93a2b" />
          <button class="btn small" data-dev="spool">Load</button></div>
      </div>`;
  }

  /* The parameters of the fault picked. */
  function faultArgs() {
    const box = pane?.querySelector('[data-dev="fault-args"]');
    if (!box) return;
    const f = pane.querySelector('[data-dev="fault"]').value;
    box.innerHTML = (FAULT_ARGS[f] || [])
      .map(([k, label, v]) => `${h(label)} <input ${typeof v === "number" ? 'type="number"' : 'type="text"'} data-arg="${k}" value="${h(v)}" style="width: ${typeof v === "number" ? 70 : 160}px" />`)
      .join(" ") || "No parameter.";
  }

  function edit() {
    D.edited = true;
    render();
  }

  async function onChange(e) {
    const t = e.target;
    const dev = t.dataset.dev;
    if (t.dataset.arg != null || dev === "fault-printer" || dev?.startsWith("spool-")) return;
    if (dev === "on") D.cfg.on = t.checked;
    else if (dev === "speed") D.cfg.speed = +t.value;
    else if (dev === "scenario") {
      if (t.value === "__file") {
        D.cfg.scenario = "__file";
        return render();
      }
      return load(t.value);
    } else if (dev === "file") {
      if (t.value.trim()) return load(t.value.trim());
    } else if (dev === "fault") return faultArgs();
    else if (t.dataset.pName != null) {
      D.printers[+t.dataset.pName].name = t.value.trim() || D.printers[+t.dataset.pName].name;
      return edit();
    } else if (t.dataset.pStart != null) {
      const p = D.printers[+t.dataset.pStart];
      p.start = t.value;
      if ((p.start === "printing" || p.start === "paused") && !p.print) {
        p.files ||= [];
        if (!p.files.length) p.files.push({ name: "Calibration_Cube.gcode", tools: [0], minutes: 24, layers: 100 });
        p.print = p.files[0].name;
        p.progress = p.progress || 0.3;
      }
      return edit();
    } else if (t.dataset.pProgress != null) {
      D.printers[+t.dataset.pProgress].progress = Math.min(99, Math.max(0, +t.value || 0)) / 100;
      return edit();
    } else if (t.dataset.spoolType != null || t.dataset.spoolColor != null) {
      const [i, n] = (t.dataset.spoolType ?? t.dataset.spoolColor).split(":").map(Number);
      const p = D.printers[i];
      p.spools ||= [];
      while (p.spools.length <= n) p.spools.push({ type: "", color: "#ffffff", vendor: "Generic", sub_type: "", present: false, official: false });
      const s = p.spools[n];
      if (t.dataset.spoolType != null) {
        s.type = t.value;
        s.present = !!t.value;
        s.vendor = t.value ? s.vendor || "Generic" : "";
      } else s.color = t.value;
      return edit();
    }
    render();
  }

  async function onClick(e) {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const dev = b.dataset.dev;
    try {
      if (dev === "add") {
        // A number no printer has: after a removal, the count could repeat one.
        const taken = D.printers.map((p) => +(/^sim-extra-(\d+)$/.exec(p.id)?.[1] || 0));
        const n = Math.max(D.printers.length, ...taken) + 1;
        const names = ["Kilo", "Lima", "Mike", "November", "Oscar", "Papa"];
        D.printers.push(await invoke("sim_new_printer", { n, name: `Sim U1 ${names[(n - 1) % names.length]}` }));
        return edit();
      }
      if (b.dataset.pRemove != null) {
        D.printers.splice(+b.dataset.pRemove, 1);
        return edit();
      }
      if (dev === "reset") return load(D.cfg.scenario);
      if (dev === "apply") {
        b.disabled = true;
        if (D.cfg.scenario === "__file") throw new Error("Pick a scenario file first.");
        await invoke("sim_set", { config: { ...D.cfg, printers: D.edited ? D.printers : null } });
        return;
      }
      if (dev === "inject") {
        const fault = { fault: pane.querySelector('[data-dev="fault"]').value };
        for (const i of pane.querySelectorAll("[data-arg]")) {
          if (i.value === "") continue;
          fault[i.dataset.arg] = i.type === "number" ? +i.value : i.value;
        }
        await invoke("sim_fault", { printer: pane.querySelector('[data-dev="fault-printer"]').value, fault });
        return load().then(faultArgs);
      }
      if (b.dataset.clear) {
        await invoke("sim_fault", { printer: b.dataset.clear, fault: { fault: "clear" } });
        return load().then(faultArgs);
      }
      if (dev === "spool") {
        const type = pane.querySelector('[data-dev="spool-type"]').value;
        await invoke("sim_spool", {
          printer: pane.querySelector('[data-dev="spool-printer"]').value,
          head: +pane.querySelector('[data-dev="spool-head"]').value,
          spool: { type, color: pane.querySelector('[data-dev="spool-color"]').value, vendor: "Generic", sub_type: "", present: true, official: false },
        });
        return load().then(faultArgs);
      }
    } catch (err) {
      D.error = String(err?.message || err);
      render();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    pill();
    if (typeof settingsAddPane !== "function") return;
    pane = document.createElement("div");
    pane.innerHTML = '<div class="settings-page dev-pane"><h2 class="set-title">Developer</h2></div>';
    pane.addEventListener("change", onChange);
    pane.addEventListener("click", onClick);
    settingsAddPane({
      cat: "developer",
      label: "Developer",
      color: "#FF3B30",
      icon: '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 4 12l4.6-4.6L7.2 6 1.2 12l6 6zm6.8 0L20 12l-4.6-4.6L16.8 6l6 6-6 6zM13.9 4l1.9.5-5.7 15.5-1.9-.5z"/></svg>',
      pane,
      onShow: () => load().then(faultArgs),
    });
    if (window.SIM?.on) {
      listen("printer-status", (e) => {
        if (!window.SIM.printers.includes(e.payload?.id)) refreshStatus();
      });
    }
  });
})();
