"use strict";
/* Visual picker: a list of settings chosen from pictures.

   As the head pickers (slice-ui.js swatchSelect), it enhances a <select>
   that stays, hidden, the source of truth: a field-like button shows the
   chosen option's picture and words, and opens a grid of cards (openGrid),
   each with its picture, its name and a line on what it does. A pick goes
   through setSelect(); the button follows the select (segFollow). A
   disabled option is shown, not pickable: the value a list does not offer. */

/* An icon (slice-icons.js), the "?" one when there is none. */
const vpIcon = (svg) => `<span class="vp-ico">${svg || SLICE_ICON_UNKNOWN}</span>`;

/* `icons(value)`: the picture's markup; `desc(value)`: its explanation;
   `label`: the field's name; `columns`: of the grid; `note()`: a line
   under it (the profile's value). Returns { refresh, close }. */
function visualSelect(sel, { icons, desc = () => "", label = "", columns = 3, note = () => "" } = {}) {
  const key = sel.dataset.k || sel.id;
  let btn = sel.nextElementSibling;
  if (!btn?.classList.contains("vp-trigger")) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "field vp-trigger";
    btn.dataset.vp = key;
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    sel.after(btn);
  }
  sel.classList.add("hidden");
  const items = () => [...sel.options].map((o) => ({ value: o.value, label: o.text, disabled: o.disabled }));
  const refresh = () => {
    const o = sel.selectedOptions[0] || sel.options[0];
    btn.disabled = sel.disabled;
    if (!o) return (btn.innerHTML = "");
    btn.innerHTML = `${vpIcon(icons(o.value))}<span class="vp-lbl">${esc(o.text)}</span><span class="sw-caret">▾</span>`;
    btn.setAttribute("aria-label", `${label || tr("vp.choose")}: ${o.text}`);
  };
  btn.onclick = () => {
    if (PK.anchor === btn && !$("picker").classList.contains("hidden")) return closePicker(true);
    openGrid(btn, {
      items: items(),
      value: sel.value,
      popCls: "vp-pop",
      gridCls: "vp-grid",
      optCls: "vp-opt",
      columns,
      head: label,
      label: label || tr("vp.choose"),
      note: note(),
      title: (e) => [e.label, desc(e.value)].filter(Boolean).join(" — "),
      renderItem: (e) => `${vpIcon(icons(e.value))}<b>${esc(e.label)}</b>${desc(e.value) ? `<small>${esc(desc(e.value))}</small>` : ""}<i class="vp-check" aria-hidden="true">✓</i>`,
      onPick: (v) => {
        setSelect(sel, v);
        // The panel may have been drawn again: its new button takes the focus.
        if (!btn.isConnected) requestAnimationFrame(() => document.querySelector(`.vp-trigger[data-vp="${CSS.escape(key)}"]`)?.focus());
      },
    });
  };
  segFollow(sel, refresh);
  refresh();
  return { refresh, close: () => PK.anchor === btn && closePicker() };
}
