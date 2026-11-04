"use strict";
/* Number steppers: ‹ 0,2 › instead of the native up and down arrows.

   As the other controls, a stepper enhances an <input type="number"> that
   stays the source of truth: a step sets its value and sends "input" (a
   held button repeats) then "change" once, which its own listeners hear.
   A double-click on the value — or Enter on it — shows the input itself to
   type a value; Enter or leaving it keeps it, Esc puts the old one back.
   The stepper follows the input: a `.value =` from code, `disabled`. */

const ST_LESS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5"/></svg>';
const ST_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6.5 15 12l-5.5 5.5"/></svg>';

/* The value as shown: in the language's numbers; "—" when empty. */
const stShown = (v) => (String(v ?? "").trim() === "" || isNaN(+v) ? "—" : fmtNum(+v, { maximumFractionDigits: 4 }));

function numStepper(input) {
  if (input._st) return input._st;
  const box = document.createElement("span");
  box.className = "nstep";
  input.before(box);
  box.innerHTML = `<button type="button" class="nstep-b" data-dir="-1" tabindex="-1">${ST_LESS}</button><span class="nstep-v" role="spinbutton" tabindex="0"></span><button type="button" class="nstep-b" data-dir="1" tabindex="-1">${ST_MORE}</button>`;
  const [less, val, more] = box.children;
  less.after(input);
  input.after(val);
  // What finds this stepper again once its panel is drawn anew.
  const key = input.dataset.k || input.dataset.spdRow || input.id;
  if (key) box.dataset.st = key;
  const opts = () => ({ step: input.step || 1, min: input.min, max: input.max });
  const name = () => input.getAttribute("aria-label") || input.closest(".grow-row")?.querySelector(".k")?.firstChild?.textContent?.trim() || "";
  const render = () => {
    const v = input.value;
    val.textContent = stShown(v);
    val.title = tr("nstep.edit");
    val.setAttribute("aria-label", name());
    if (String(v).trim() !== "" && !isNaN(+v)) val.setAttribute("aria-valuenow", v);
    else val.removeAttribute("aria-valuenow");
    for (const [a, k] of [["aria-valuemin", "min"], ["aria-valuemax", "max"]]) input[k] !== "" ? val.setAttribute(a, input[k]) : val.removeAttribute(a);
    less.setAttribute("aria-label", tr("nstep.less"));
    more.setAttribute("aria-label", tr("nstep.more"));
    less.disabled = input.disabled || !stCan(v, -1, opts());
    more.disabled = input.disabled || !stCan(v, 1, opts());
    box.classList.toggle("disabled", input.disabled);
    val.tabIndex = input.disabled ? -1 : 0;
  };
  // A step: the value at once ("input"), then "change" when done.
  const step = (dir) => {
    input.value = stStep(input.value, dir, opts());
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const commit = (focus) => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // The panel may have been drawn anew: the same part of its new stepper
    // takes the focus.
    if (!box.isConnected && key) {
      requestAnimationFrame(() => {
        const nb = document.querySelector(`.nstep[data-st="${CSS.escape(key)}"]`);
        (focus === "value" ? nb?.querySelector(".nstep-v") : nb?.querySelector(`.nstep-b[data-dir="${focus}"]`) || nb?.querySelector(".nstep-v"))?.focus();
      });
    }
  };
  // Held, a button repeats; released, the value is kept.
  let timer = null, held = false;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (held) {
      held = false;
      commit(document.activeElement?.dataset?.dir || "value");
    }
  };
  for (const b of [less, more]) {
    b.addEventListener("pointerdown", (e) => {
      if (b.disabled || e.button !== 0) return;
      e.preventDefault();
      b.focus({ preventScroll: true });
      held = true;
      step(+b.dataset.dir);
      const again = (wait) => (timer = setTimeout(() => {
        if (b.disabled) return stop();
        step(+b.dataset.dir);
        again(70);
      }, wait));
      again(400);
    });
    // A click from the keyboard (no pointer): one step.
    b.addEventListener("click", (e) => {
      if (e.detail !== 0 || b.disabled) return;
      step(+b.dataset.dir);
      commit(b.dataset.dir);
    });
  }
  box.addEventListener("pointerup", stop);
  box.addEventListener("pointerleave", stop);
  box.addEventListener("pointercancel", stop);
  // Typing a value.
  let before = null;
  const edit = () => {
    if (input.disabled) return;
    before = input.value;
    box.classList.add("editing");
    input.focus();
    input.select();
  };
  const leave = () => {
    box.classList.remove("editing");
    before = null;
  };
  val.addEventListener("dblclick", edit);
  val.addEventListener("keydown", (e) => {
    const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (k && !input.disabled) {
      e.preventDefault();
      if (stCan(input.value, k, opts())) {
        step(k);
        commit("value");
      }
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      edit();
    }
  });
  // Once typed, the focus goes back to the value — the new stepper's when
  // the change drew the panel anew.
  let back = false;
  const refocus = () =>
    requestAnimationFrame(() => (box.isConnected ? val : document.querySelector(`.nstep[data-st="${CSS.escape(key)}"] .nstep-v`))?.focus());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      back = true;
      input.blur();
    } else if (e.key === "Escape" && before != null) {
      // Esc gives the old value back, without closing the sheet.
      e.preventDefault();
      e.stopPropagation();
      input.value = before;
      leave();
      val.focus();
    }
  });
  input.addEventListener("blur", () => {
    if (!box.classList.contains("editing")) return;
    leave();
    render();
    if (back) refocus();
    back = false;
  });
  input.addEventListener("change", () => box.isConnected && render());
  input.addEventListener("input", render);
  // A value set by code, `disabled` changed: the stepper follows.
  const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return value.get.call(this);
    },
    set(v) {
      value.set.call(this, v);
      render();
    },
  });
  new MutationObserver(render).observe(input, { attributes: true, attributeFilter: ["disabled", "min", "max", "step"] });
  render();
  return (input._st = { render, box });
}

/* Every number field of a container, as steppers. */
function steppersIn(root) {
  root?.querySelectorAll('input[type="number"].num').forEach(numStepper);
}
