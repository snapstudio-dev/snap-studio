"use strict";
/* Snappy's tools over what only the page holds (src-tauri/src/snappy_tools/):
   Prepare's plate, the Files view's folders, Explore's tabs, Create's
   sheets, Settings' fields. Each is done as the page's own controls do it.
   A tool that changes something has a `<name>_check` here too, which checks
   its arguments and words its confirmation card; the action runs once the
   user said yes. Paths never leave the page: files and folders go by name.
   Loaded after snappy.js, whose "snappy-ui" listener calls SNAPPY_ACTIONS. */

const snappyRound = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const snappyFail = (error) => ({ error });

/* ------------------------------------------------------------ Prepare's plate */

function snappyPlateObjects() {
  return {
    bed_mm: [PR.bed.w, PR.bed.d],
    objects: PR.objects.map((o) => {
      const b = groupBox([o]);
      const heads = prHeads(o);
      return {
        id: o.id,
        name: o.name,
        position_mm: o.pos.map((v) => snappyRound(v)),
        size_mm: [snappyRound(b.x1 - b.x0), snappyRound(b.y1 - b.y0)],
        rotation_deg: o.rot.map((v) => snappyRound(v)),
        scale_percent: o.scale.map((s) => snappyRound(s * 100)),
        on_plate: bedState(o) !== "out",
        colors: prColors(o).map((ext) => ({ color: ext, head: heads[ext]?.h ?? null })),
      };
    }),
  };
}

const SNAPPY_PLATE_ACTIONS = ["arrange", "orient", "duplicate", "remove", "center", "reset_rotation", "split", "put_on_bed", "move", "rotate", "scale", "set_head", "colours_by", "tower"];

/* The objects an edit is about: the ids given, or the whole plate. */
function snappyPlateTargets(args) {
  if (!Array.isArray(args.objects) || !args.objects.length) return PR.objects;
  const list = PR.objects.filter((o) => args.objects.includes(o.id));
  return list.length === args.objects.length ? list : null;
}

function snappyPlateCheck(args) {
  const a = args?.action;
  if (!SNAPPY_PLATE_ACTIONS.includes(a)) return snappyFail("Unknown plate action: " + a);
  if (!PR.objects.length) return snappyFail("Prepare's plate is empty.");
  const list = snappyPlateTargets(args);
  if (!list) return snappyFail("Some of these objects are not on Prepare's plate: read plate_objects again.");
  const num = (v) => typeof v === "number" && isFinite(v);
  if (a === "move" && !(num(args.dx) || num(args.dy))) return snappyFail("move needs dx and/or dy, in mm.");
  if (a === "rotate" && !(Array.isArray(args.rotation) && args.rotation.length === 3 && args.rotation.every(num))) return snappyFail("rotate needs rotation: [x, y, z] in degrees.");
  if (a === "scale" && !(num(args.scale) && args.scale >= 1 && args.scale <= 1000)) return snappyFail("scale is a percent, from 1 to 1000.");
  if (a === "colours_by" && !["object", "colour"].includes(args.by)) return snappyFail("colours_by needs by: object or colour.");
  if (a === "tower" && typeof args.on !== "boolean") return snappyFail("tower needs on: true or false.");
  if (a === "tower" && args.on && prTowerState().reason) return snappyFail("The prime tower cannot be turned on for this plate now.");
  if (a === "set_head") {
    if (!Number.isInteger(args.head) || args.head < 0 || args.head >= headsCount(headsActive())) return snappyFail("No such head.");
    if (!list.every((o) => prColors(o).includes(args.color))) return snappyFail("Not every object has that color: see plate_objects.");
  }
  const params = {
    dx: snappyRound(args.dx || 0),
    dy: snappyRound(args.dy || 0),
    x: args.rotation?.[0],
    y: args.rotation?.[1],
    z: args.rotation?.[2],
    pct: args.scale,
    color: args.color,
    head: "T" + args.head,
    by: tr(args.by === "colour" ? "prepare.assoc.colour" : "prepare.assoc.object"),
    state: tr(args.on ? "snappy.ask.on" : "snappy.ask.off"),
  };
  const what = list === PR.objects ? tr("snappy.plate.all") : list.map((o) => o.name).join(", ");
  return { card: tr("snappy.plate.card", { action: tr("snappy.plate." + a, params), objects: what }), list };
}

/* As Prepare's tools do it, the plate shown; one undo step each. */
async function snappyPlateEdit(args) {
  const c = snappyApproved(args) || snappyPlateCheck(args);
  if (c.error) return c;
  if ((window.currentView || "files") !== "prepare") switchView("prepare");
  const ids = c.list.map((o) => o.id);
  const refresh = () => {
    prSchedule();
    prSave();
    prRenderInspector();
  };
  prSelect(ids, false);
  switch (args.action) {
    case "arrange": prArrange(); break;
    case "orient": await prOrient(c.list === PR.objects); break;
    case "duplicate": prDuplicate(); break;
    case "remove": prRemoveSelection(); break;
    case "center": prCenterSelection(); break;
    case "reset_rotation": prResetRotation(); break;
    case "split": await prSplit(); break;
    case "put_on_bed": prPutOnBed(ids); break;
    case "move": prMoveSelection(args.dx || 0, args.dy || 0); break;
    case "rotate":
      prRemember();
      for (const o of c.list) o.rot = args.rotation.map(normDeg);
      refresh();
      break;
    case "scale":
      prRemember();
      for (const o of c.list) o.scale = [args.scale / 100, args.scale / 100, args.scale / 100];
      refresh();
      break;
    case "set_head":
      for (const o of c.list) prSetHead(o, args.color, args.head);
      break;
    case "colours_by":
      prAssocApply(args.by);
      break;
    case "tower":
      prTowerSetOn(args.on);
      break;
  }
  return { done: args.action, objects: PR.objects.length };
}

function snappyPlateAddCheck({ file }) {
  const f = snappyLocalFile(state.view_files, file);
  if (f.error) return f;
  if (!/\.(3mf|stl)$/i.test(f.name)) return snappyFail("Only 3MF and STL files go on the plate.");
  return { card: tr("snappy.plate.add", { file: f.name }), path: f.path };
}

async function snappyPlateAdd(args) {
  const c = snappyApproved(args) || snappyPlateAddCheck(args);
  if (c.error) return c;
  switchView("prepare");
  await prepareAddFile(c.path);
  return { added: args.file, objects: PR.objects.length };
}

/* ------------------------------------------------------------ the Files view */

function snappyFilesFolders() {
  return { shown: state.dir ? baseName(state.dir) : null, recent: state.recents.map(baseName) };
}

async function snappyFilesOpenFolder({ folder }) {
  const found = state.recents.filter((d) => baseName(d) === folder);
  if (found.length !== 1) return snappyFail(found.length ? `Several folders are named “${folder}”.` : `No folder named “${folder}”: see files_folders.`);
  switchView("files");
  await openDir(found[0]);
  return { shown: folder, files: state.view_files.length };
}

/* ------------------------------------------------------------ Explore */

function snappyExploreState() {
  const name = (t) => t.title || LIB.sites.find((s) => s.id === t.site)?.name || "";
  const shown = LIB.tabs.find((t) => t.id === LIB.active);
  return { sites: LIB.sites.map((s) => s.name), tabs: LIB.tabs.map(name), shown: LIB.visible && shown ? name(shown) : null };
}

async function snappyExploreOpen({ site, url }) {
  switchView("library");
  if (url) {
    await openFavorite({ url });
    return { shown: url };
  }
  const s = LIB.sites.find((x) => x.name.toLowerCase() === String(site || "").toLowerCase());
  if (!s) return snappyFail(`No site named “${site}”: see explore_state.`);
  showSite(s);
  return { shown: s.name };
}

function snappyExploreFavAdd() {
  if (!LIB.visible || !LIB.tabs.some((t) => t.id === LIB.active)) return snappyFail("Explore shows no page to add.");
  $("lib-fav").click();
  return { added: true };
}

/* ------------------------------------------------------------ Create */

async function snappyCreateOpen({ id }) {
  switchView("ia");
  await iaRefresh();
  await iaOpen(id);
  return { shown: true };
}

/* As the New object sheet does, with its defaults; its message says why
   when it cannot. */
async function snappyCreateNew({ prompt }) {
  switchView("ia");
  iaNew();
  $("ia-from-model").checked = false;
  $("ia-prompt").value = prompt || "";
  await iaCreate();
  if (!$("iamodal").classList.contains("hidden") && !$("iamodal").classList.contains("closing")) {
    const why = $("ia-msg").textContent;
    closeSheet($("iamodal"));
    return snappyFail(why || "The conversation could not start.");
  }
  return { created: true };
}

/* ------------------------------------------------------------ Settings */

/* Settings that stay the user's own: the anonymous count is a consent,
   and Snappy does not switch itself off. */
const SNAPPY_SETTINGS_KEPT = new Set(["set-analytics", "set-snappy-on"]);

function snappySettingFields() {
  return [...document.querySelectorAll("#view-settings .set-pane")].flatMap((pane) =>
    [...pane.querySelectorAll("input[id], select[id]")]
      .filter((el) => !SNAPPY_SETTINGS_KEPT.has(el.id) && ["checkbox", "range", "number", "text", "select-one"].includes(el.type))
      .map((el) => ({ el, pane }))
  );
}

function snappySettingOf({ el, pane }) {
  const row = el.closest(".grow-row, .row, label, .group");
  const label = row?.querySelector(".k > span, .k")?.textContent.trim() || el.getAttribute("aria-label") || el.id;
  const out = { key: el.id, label, section: pane.querySelector(".set-title")?.textContent.trim() || "" };
  if (el.type === "checkbox") out.value = el.checked;
  else if (el.tagName === "SELECT") {
    out.value = el.value;
    out.choices = [...el.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
  } else if (el.type === "range" || el.type === "number") {
    Object.assign(out, { value: +el.value, min: +el.min, max: +el.max, step: +el.step || 1 });
  } else out.value = el.value;
  return out;
}

/* The display's choices are buttons, not fields (settings.js): mode,
   theme, accent. Listed and set by their buttons. */
const SNAPPY_DISPLAY = {
  "display.mode": { box: "disp-mode", attr: "modePick", label: "display.mode" },
  "display.theme": { box: "disp-themes", attr: "themePick", label: "display.theme" },
  "display.accent": { box: "disp-accents", attr: "accent", label: "display.accent" },
};

function snappyDisplayOf(key) {
  const d = SNAPPY_DISPLAY[key];
  const buttons = [...$(d.box).querySelectorAll("button")].filter((b) => b.dataset[d.attr]);
  const name = (b) => (b.querySelector(".disp-name")?.textContent || b.getAttribute("aria-label") || b.textContent || b.dataset[d.attr]).trim();
  return {
    key,
    label: tr(d.label),
    section: tr("settings.display"),
    value: buttons.find((b) => b.classList.contains("on"))?.dataset[d.attr] ?? null,
    choices: buttons.map((b) => ({ value: b.dataset[d.attr], label: name(b) })),
    buttons,
  };
}

function snappySettingsList() {
  const display = Object.keys(SNAPPY_DISPLAY).map((k) => {
    const { buttons, ...rest } = snappyDisplayOf(k);
    return rest;
  });
  return { settings: [...display, ...snappySettingFields().map(snappySettingOf)] };
}

function snappySettingsCheck({ setting, value }) {
  if (SNAPPY_DISPLAY[setting]) {
    const d = snappyDisplayOf(setting);
    const i = d.choices.findIndex((c) => c.value === String(value) || c.label === value);
    if (i < 0) return snappyFail(`${setting}: “${value}” is not one of its choices.`);
    return { card: tr("snappy.ask.setting_set", { label: d.label, value: d.choices[i].label }), button: d.buttons[i] };
  }
  const f = snappySettingFields().find((x) => x.el.id === setting);
  if (!f) return snappyFail(`No setting “${setting}”: see settings_list.`);
  const s = snappySettingOf(f);
  let v, shown;
  if (f.el.type === "checkbox") {
    v = snappyBool(value);
    if (v == null) return snappyFail(`${setting} is true or false.`);
    shown = tr(v ? "common.yes" : "common.no");
  } else if (s.choices) {
    const c = s.choices.find((x) => x.value === String(value)) || s.choices.find((x) => x.label === value);
    if (!c) return snappyFail(`${setting}: “${value}” is not one of its choices.`);
    v = c.value;
    shown = c.label;
  } else if (f.el.type === "range" || f.el.type === "number") {
    v = Number(value);
    if (!isFinite(v) || v < s.min || v > s.max) return snappyFail(`${setting} goes from ${s.min} to ${s.max}.`);
    shown = String(v);
  } else {
    v = String(value);
    shown = v;
  }
  return { card: tr("snappy.ask.setting_set", { label: s.label, value: shown }), field: f, value: v };
}

/* As by hand: the field's own handlers save and apply it. */
function snappySettingsSet(args) {
  const c = snappyApproved(args) || snappySettingsCheck(args);
  if (c.error) return c;
  if (c.button) {
    c.button.click();
    return { set: args.setting };
  }
  const el = c.field.el;
  if (el.type === "checkbox") el.checked = c.value;
  else el.value = c.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { set: el.id };
}

/* ------------------------------------------------------------ the app */

const SNAPPY_APP_ACTIONS = ["check_update", "install_update", "welcome", "recheck_ai", "clear_cache", "reset_display", "engine_install", "engine_remove"];

function snappyAppCheck({ action }) {
  if (!SNAPPY_APP_ACTIONS.includes(action)) return snappyFail("Unknown action: " + action);
  if (action === "install_update" && !UP.found) return snappyFail("No update was found: check first.");
  return { card: tr("snappy.app." + action) };
}

/* As Settings' buttons do; a confirmation the app would ask is the card's. */
async function snappyApp(args) {
  const c = snappyApproved(args) || snappyAppCheck(args);
  if (c.error) return c;
  switch (args.action) {
    case "check_update":
      await upCheck(true);
      return { update: UP.found ? { version: UP.found.version } : null, status: $("up-status").textContent };
    case "install_update":
      await upInstall();
      return { installing: true };
    case "welcome":
      welcomeOpen();
      return { shown: true };
    case "recheck_ai":
      await aiCheck(true);
      return { checked: true, ready: aiAllowed() };
    case "clear_cache":
      return { freed: await invoke("clear_cache") };
    case "reset_display":
      $("disp-reset").click();
      return { reset: true };
    case "engine_install":
      await engInstall({ silent: true });
      return { engine: ENG.status };
    case "engine_remove":
      ENG.status = await invoke("engine_remove");
      engPaint();
      return { engine: ENG.status };
  }
}

/* ------------------------------------------------------------ printers */

/* A few seconds of the network search; the printers found and not added,
   by name and model, never by address. */
async function snappyDiscover() {
  await discoverStart();
  await new Promise((r) => setTimeout(r, 5000));
  const found = [...DISC.items.values()].filter((f) => !discKnown(f)).map((f) => ({ name: f.name, model: discModel(f) }));
  if (!DISC.view) discoverStop();
  return { found, error: DISC.error || undefined };
}

const snappyPrinter = (name) => P.list.find((p) => p.name.toLowerCase() === String(name || "").toLowerCase());

function snappyPrinterCheck(a) {
  if (a.action === "add") {
    const f = [...DISC.items.values()].find((x) => x.name === a.found && !discKnown(x));
    if (!f) return snappyFail(`No printer “${a.found}” found and not added: run printers_discover first.`);
    return { card: tr("snappy.ask.printer_add", { name: a.name || f.name }), found: f };
  }
  const p = snappyPrinter(a.printer);
  if (!p) return snappyFail(`No printer named “${a.printer}”.`);
  if (a.action === "rename" && !a.name?.trim()) return snappyFail("rename needs name.");
  if (a.action === "model" && !a.model?.trim()) return snappyFail("model needs model.");
  if (!["rename", "model", "remove"].includes(a.action)) return snappyFail("Unknown action: " + a.action);
  return { card: tr("snappy.ask.printer_" + a.action, { printer: p.name, name: a.name, model: a.model }), printer: p };
}

/* As the printer sheet saves it: the address stays the app's. */
async function snappyPrinterManage(a) {
  const c = snappyApproved(a) || snappyPrinterCheck(a);
  if (c.error) return c;
  if (a.action === "remove") P.list = await invoke("printer_remove", { id: c.printer.id });
  else {
    const printer =
      a.action === "add"
        ? { id: "", name: a.name || c.found.name, ...discAddr(c.found), model: discModel(c.found), note: "" }
        : { ...c.printer, ...(a.action === "rename" ? { name: a.name.trim() } : { model: a.model.trim() }) };
    P.list = await invoke("printer_save", { printer });
  }
  await prnLoad();
  return { done: a.action };
}

/* A printer's page, and its camera. */
async function snappyPrinterOpen({ printer, tab = "status", camera }) {
  const p = snappyPrinter(printer);
  if (!p) return snappyFail(`No printer named “${printer}”.`);
  if (tab === "files") pflShow(p.id);
  else if (tab === "control") ctlOpen(p.id);
  else if (tab === "bed_mesh") await maintShow(p.id, "level");
  else if (tab === "maintenance") await maintShow(p.id, "care");
  else {
    P.sel = p.id;
    prnRenderDetail();
    switchView("printers");
  }
  if (camera === "on") await camStart(p.id);
  else if (camera === "off") camStop();
  else if (camera === "pin") {
    await camStart(p.id);
    camPin(true);
  }
  return { shown: p.name };
}

/* ------------------------------------------------------------ slicing */

function snappySaveProfileCheck({ name }) {
  if (!snappySheetOpen()) return snappyFail("The slice sheet is closed: open it with open_slice_sheet.");
  if (!String(name || "").trim()) return snappyFail("A name is needed.");
  return { card: tr("snappy.ask.save_profile", { name: name.trim() }) };
}

/* As the sheet's Save does, named as asked; its own message says why not. */
async function snappySaveProfile(args) {
  const c = snappyApproved(args) || snappySaveProfileCheck(args);
  if (c.error) return c;
  advSaveOpen();
  $("advsave-name").value = args.name.trim();
  await advSaveGo();
  if (!$("advsave").classList.contains("hidden") && !$("advsave").classList.contains("closing")) {
    const why = $("advsave-msg").textContent;
    closeSheet($("advsave"));
    return snappyFail(why || "Not saved.");
  }
  return { saved: args.name.trim() };
}

function snappyPreviewCheck({ action }) {
  if (!SL.preview) return snappyFail("No slice preview is open.");
  if (!["save", "edit", "close"].includes(action)) return snappyFail("Unknown action: " + action);
  return { card: tr("snappy.ask.preview_" + action) };
}

async function snappyPreview(args) {
  const c = snappyApproved(args) || snappyPreviewCheck(args);
  if (c.error) return c;
  if (args.action === "save") await savePreview();
  else if (args.action === "edit") editInPrepare();
  else closeViewer();
  return { done: args.action };
}

/* ------------------------------------------------------------ local files */

async function snappyLocalOpen({ file, action }) {
  const f = snappyLocalFile(state.view_files, file);
  if (f.error) return f;
  if (action === "reveal") await invoke("reveal", { path: f.path });
  else if (action === "open") await invoke("open_file", { path: f.path });
  else if (action === "analyze") return await invoke("analyze", { path: f.path });
  else return snappyFail("Unknown action: " + action);
  return { done: action };
}

function snappyLocalAiCheck({ file, prompt }) {
  const f = snappyLocalFile(state.view_files, file);
  if (f.error) return f;
  if (!/\.(3mf|stl)$/i.test(f.name)) return snappyFail("Only a 3MF or STL can be changed with the AI.");
  if (!String(prompt || "").trim()) return snappyFail("Say what to change.");
  return { card: tr("snappy.ask.file_ai", { file: f.name, prompt }), path: f.path, file: state.files.find((x) => x.path === f.path) };
}

/* As Edit with AI does: the sheet with the request, started. */
async function snappyLocalAi(args) {
  const c = snappyApproved(args) || snappyLocalAiCheck(args);
  if (c.error) return c;
  iaStart(c.file || state.files.find((x) => x.path === c.path));
  $("ia-prompt").value = args.prompt;
  await iaCreate();
  if (!$("iamodal").classList.contains("hidden") && !$("iamodal").classList.contains("closing")) {
    const why = $("ia-msg").textContent;
    closeSheet($("iamodal"));
    return snappyFail(why || "The conversation could not start.");
  }
  return { created: true };
}

/* The Files view's order and filter, as its menu and search field. */
function snappyFilesView({ sort, descending, search }) {
  switchView("files");
  if (sort) state.sort = sort;
  if (typeof descending === "boolean") state.asc = !descending;
  if (sort || typeof descending === "boolean") {
    save();
    applyView();
    syncHead();
  }
  if (typeof search === "string") {
    $("search").value = search;
    $("search").dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { shown: state.view_files.length };
}

/* ------------------------------------------------------------ Explore */

const snappyTab = (title) =>
  title ? LIB.tabs.find((t) => (t.title || "").toLowerCase() === String(title).toLowerCase()) : LIB.tabs.find((t) => t.id === LIB.active);

async function snappyExploreTab({ action, tab }) {
  const t = snappyTab(tab);
  if (!t) return snappyFail(tab ? `No tab “${tab}”: see explore_state.` : "Explore shows no tab.");
  if (action === "close") closeTab(t.id);
  else if (action === "browser") await invoke("plugin:opener|open_url", { url: t.url });
  else if (["back", "forward", "reload"].includes(action)) await invoke("lib_command", { id: t.id, what: action });
  else return snappyFail("Unknown action: " + action);
  return { done: action };
}

const snappySite = (name) => LIB.sites.find((x) => x.name.toLowerCase() === String(name || "").toLowerCase());

function snappySiteCheck({ action, site }) {
  const s = snappySite(site);
  if (!s) return snappyFail(`No site named “${site}”: see explore_state.`);
  if (!["logout", "pin", "unpin"].includes(action)) return snappyFail("Unknown action: " + action);
  if (action === "logout" && !LIB.tabs.some((t) => t.site === s.id)) return snappyFail(`Open ${s.name} in Explore first: signing out goes through its tab.`);
  return { card: tr("snappy.ask.site_" + action, { site: s.name }), site: s };
}

async function snappySiteAction(args) {
  const c = snappyApproved(args) || snappySiteCheck(args);
  if (c.error) return c;
  if (args.action === "logout") {
    const t = LIB.tabs.find((x) => x.site === c.site.id);
    return { cookies: await invoke("lib_logout", { id: t.id, site: c.site.id }) };
  }
  if (LIB.pins.has(c.site.id) !== (args.action === "pin")) togglePin(c.site.id);
  return { done: args.action };
}

/* ------------------------------------------------------------ the table */

/* Only the card's text goes back for a check. */
/* What a card named, kept under a token until its action runs: the action
   then works on what the user approved (that file, that printer), not on
   whatever bears the same name by then (snappy_tools/common.rs passes the
   token back). Forgotten after the approval's own wait. */
const SNAP_APPROVED = new Map();
const snappyCardOnly = (fn) => (args) => {
  const c = fn(args || {});
  if (c.error) return { error: c.error };
  const token = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  SNAP_APPROVED.set(token, c);
  setTimeout(() => SNAP_APPROVED.delete(token), 20 * 60 * 1000);
  return { card: c.card, token };
};

/* The approved card's target for this run, if any (used once). */
function snappyApproved(args) {
  const c = args?._token && SNAP_APPROVED.get(args._token);
  if (!c) return null;
  SNAP_APPROVED.delete(args._token);
  return c;
}

const SNAPPY_ACTIONS = {
  plate_objects: snappyPlateObjects,
  plate_edit_check: snappyCardOnly(snappyPlateCheck),
  plate_edit: snappyPlateEdit,
  plate_add_check: snappyCardOnly(snappyPlateAddCheck),
  plate_add: snappyPlateAdd,
  files_folders: snappyFilesFolders,
  files_open_folder: snappyFilesOpenFolder,
  explore_state: snappyExploreState,
  explore_open: snappyExploreOpen,
  explore_fav_add: snappyExploreFavAdd,
  create_open: snappyCreateOpen,
  create_new: snappyCreateNew,
  settings_list: snappySettingsList,
  settings_set_check: snappyCardOnly(snappySettingsCheck),
  settings_set: snappySettingsSet,
  app_action_check: snappyCardOnly(snappyAppCheck),
  app_action: snappyApp,
  printers_discover: snappyDiscover,
  printer_manage_check: snappyCardOnly(snappyPrinterCheck),
  printer_manage: snappyPrinterManage,
  printer_open: snappyPrinterOpen,
  slice_save_profile_check: snappyCardOnly(snappySaveProfileCheck),
  slice_save_profile: snappySaveProfile,
  preview_action_check: snappyCardOnly(snappyPreviewCheck),
  preview_action: snappyPreview,
  local_file_open: snappyLocalOpen,
  local_file_ai_check: snappyCardOnly(snappyLocalAiCheck),
  local_file_ai: snappyLocalAi,
  files_view: snappyFilesView,
  explore_tab: snappyExploreTab,
  explore_site_check: snappyCardOnly(snappySiteCheck),
  explore_site: snappySiteAction,
  create_refresh: async () => (await iaRefresh(), { ok: true }),
};
