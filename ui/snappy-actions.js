"use strict";
/* Snappy's tools over what only the page holds (src-tauri/src/snappy_actions.rs):
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

const SNAPPY_PLATE_ACTIONS = ["arrange", "orient", "duplicate", "remove", "center", "reset_rotation", "split", "put_on_bed", "move", "rotate", "scale", "set_head"];

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
  };
  const what = list === PR.objects ? tr("snappy.plate.all") : list.map((o) => o.name).join(", ");
  return { card: tr("snappy.plate.card", { action: tr("snappy.plate." + a, params), objects: what }), list };
}

/* As Prepare's tools do it, the plate shown; one undo step each. */
async function snappyPlateEdit(args) {
  const c = snappyPlateCheck(args);
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
  const c = snappyPlateAddCheck(args);
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

function snappySettingsList() {
  return { settings: snappySettingFields().map(snappySettingOf) };
}

function snappySettingsCheck({ setting, value }) {
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
  const c = snappySettingsCheck(args);
  if (c.error) return c;
  const el = c.field.el;
  if (el.type === "checkbox") el.checked = c.value;
  else el.value = c.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { set: el.id };
}

/* ------------------------------------------------------------ the table */

/* Only the card's text goes back for a check. */
const snappyCardOnly = (fn) => (args) => {
  const c = fn(args || {});
  return c.error ? { error: c.error } : { card: c.card };
};

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
};
