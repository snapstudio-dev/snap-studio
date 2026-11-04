"use strict";
/* Segmented controls (pills) and the language flags.

   As on the slice sheet, each control enhances a <select> that stays,
   hidden, the source of truth: a pick goes through setSelect() (a
   bubbling "change", heard by the select's own listeners), and the
   control follows the select — a change event, a `.value =` from code,
   options refilled or translated, `disabled`. */

/* Segments as buttons (.seg-btn, role=radio). `items`: { value, label,
   on, disabled, sub, title }; `key`: the data attribute holding the value;
   `icon(value)`: markup before the label; `roving`: one Tab stop, the
   chosen segment. */
function segHtml(items, { key = "v", cls = "", icon = null, roving = false } = {}) {
  return items
    .map((it) => {
      const on = !!it.on;
      return `<button type="button" class="seg-btn${cls ? " " + cls : ""}${on ? " on" : ""}" role="radio" aria-checked="${on}" data-${key}="${esc(it.value)}"${roving ? ` tabindex="${on ? 0 : -1}"` : ""}${it.disabled ? " disabled" : ""}${it.title ? ` title="${esc(it.title)}"` : ""}>${icon ? icon(it.value) : ""}${it.label ? `<span>${esc(it.label)}</span>` : ""}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</button>`;
    })
    .join("");
}

/* Radio keys in a group of segments: arrows (and Home/End) move and
   choose, as in a native radio group. */
function segKeys(box, pick) {
  box.addEventListener("keydown", (e) => {
    const row = [...box.querySelectorAll(".seg-btn")];
    const j = swMove(row, row.indexOf(document.activeElement), e.key);
    if (j < 0) return;
    e.preventDefault();
    row[j].focus();
    pick(row[j]);
  });
}

/* A select as a segmented control, placed after it. `icons`: SVG by
   value, or a function of it; `subs`: a line under each label, by value
   (catalog keys); `cls`: classes of the group ("compact", "cards" for
   vertical radio cards); `labelOf(value, text)`: the segment's words
   (default: the option's text); `titleOf(value)`: its tooltip; `name()`:
   the group's name for screen readers (default: the select's, or its
   row's title). Returns { render, box }. */
function segmented(sel, { icons = null, subs = null, cls = "", labelOf = null, titleOf = null, name = null } = {}) {
  if (typeof sel === "string") sel = $(sel);
  if (!sel || sel._seg) return sel?._seg;
  const box = document.createElement("div");
  box.className = `seg seg-for${cls ? " " + cls : ""}`;
  box.setAttribute("role", "radiogroup");
  sel.after(box);
  sel.classList.add("hidden");
  const row = sel.closest(".grow-row");
  const label = () => (name ? name() : sel.getAttribute("aria-label") || sel.title || (row?.querySelector(".k > span") || row?.querySelector(".k"))?.textContent || "");
  const render = () => {
    const items = segItems(
      [...sel.options].map((o) => ({ value: o.value, label: labelOf ? labelOf(o.value, o.text) : o.text, disabled: o.disabled })),
      sel.value
    ).map((it) => ({ ...it, sub: subs?.[it.value] ? tr(subs[it.value]) : "", title: titleOf ? titleOf(it.value) : "" }));
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.v : null;
    const icon = typeof icons === "function" ? icons : icons ? (v) => icons[v] || "" : null;
    box.innerHTML = segHtml(items, { icon, roving: true, cls: cls.includes("cards") ? "seg-card" : "" });
    box.setAttribute("aria-label", label().trim());
    if (sel.disabled) box.setAttribute("aria-disabled", "true");
    else box.removeAttribute("aria-disabled");
    box.querySelectorAll(".seg-btn").forEach((b) => (b.disabled ||= sel.disabled));
    if (focused != null) box.querySelector(`[data-v="${CSS.escape(focused)}"]`)?.focus();
  };
  const pick = (b) => {
    if (!b || b.disabled) return;
    setSelect(sel, b.dataset.v);
    render();
  };
  box.addEventListener("click", (e) => pick(e.target.closest(".seg-btn")));
  segKeys(box, pick);
  segFollow(sel, render);
  render();
  return (sel._seg = { render, box });
}

/* Calls `render` whenever the select may show something else: its change
   event, a value set by code, its options refilled or translated, its
   `disabled`. */
function segFollow(sel, render) {
  sel.addEventListener("change", render);
  const value = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(sel, "value", {
    configurable: true,
    get() {
      return value.get.call(this);
    },
    set(v) {
      value.set.call(this, v);
      render();
    },
  });
  new MutationObserver(render).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
}

/* ------------------------------------------------------------ languages */

/* The language pickers: flags with the language's own name, side by side;
   beyond SEG_FLAG_MAX languages a button opening the list. */
function flagSelect(sel) {
  if (sel._seg) return sel._seg;
  if (segFlagMode(sel.options.length) === "pills") {
    return segmented(sel, {
      cls: "seg-flags",
      name: () => tr("lang.label"),
      icons: (code) => `<i class="seg-flag">${segFlag(code)}</i>`,
    });
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn seg-flag-btn";
  btn.setAttribute("aria-haspopup", "dialog");
  sel.after(btn);
  sel.classList.add("hidden");
  const render = () => {
    const o = sel.selectedOptions[0];
    btn.innerHTML = `<i class="seg-flag">${segFlag(sel.value)}</i><span>${esc(o?.text || "")}</span><span class="sw-caret">▾</span>`;
    btn.disabled = sel.disabled;
    btn.setAttribute("aria-label", `${tr("lang.label")}: ${o?.text || ""}`);
  };
  btn.addEventListener("click", () =>
    openPicker(btn, {
      sections: [{ label: tr("lang.label"), items: [...sel.options].map((o) => ({ value: o.value, label: o.text, flag: o.value })) }],
      value: sel.value,
      placeholder: tr("lang.search"),
      onPick: (v) => setSelect(sel, v),
    })
  );
  segFollow(sel, render);
  render();
  return (sel._seg = { render, box: btn });
}

document.querySelectorAll("select[data-lang-picker]").forEach(flagSelect);
