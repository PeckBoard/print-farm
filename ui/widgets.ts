// Small form controls shared by the Settings, printer settings, Profiles and
// Slice views: switch toggle, segmented choice, number-with-unit input, chip.

import { h, icon } from "./dom";

export interface Toggle {
  el: HTMLElement;
  input: HTMLInputElement;
  value(): boolean;
  set(v: boolean): void;
}

/// An on/off switch (a real checkbox with role="switch", so Space toggles it
/// and screen readers announce on/off). `desc` is a one-line explanation.
export function switchToggle(id: string, label: string, checked: boolean, onChange?: (v: boolean) => void, desc?: string): Toggle {
  const input = h("input", { type: "checkbox", id, role: "switch", class: "sw-in", checked }) as HTMLInputElement;
  const descId = desc ? id + "-desc" : undefined;
  if (descId) input.setAttribute("aria-describedby", descId);
  input.addEventListener("change", () => onChange?.(input.checked));
  const el = h(
    "label",
    { class: "switch", for: id },
    input,
    h("span", { class: "sw-track", "aria-hidden": "true" }, h("span", { class: "sw-knob" })),
    h("span", { class: "sw-text" }, h("span", { class: "sw-label", text: label }), desc ? h("span", { class: "sw-desc", id: descId, text: desc }) : null),
  );
  return {
    el,
    input,
    value: () => input.checked,
    set(v) {
      input.checked = v;
    },
  };
}

export interface Seg<T extends string> {
  el: HTMLElement;
  value(): T;
  set(v: T): void;
  setDisabled(d: boolean): void;
}

/// A segmented single choice (the control panel's `.seg` look). Arrow keys
/// move between the options; the chosen one carries aria-pressed.
export function segmented<T extends string>(label: string, items: { value: T; label: string }[], value: T, onChange?: (v: T) => void): Seg<T> {
  let cur = value;
  const el = h("div", { class: "seg", role: "group", "aria-label": label });
  const bs = items.map((it) => {
    const b = h("button", { type: "button", text: it.label, "aria-pressed": "false" }) as HTMLButtonElement;
    b.addEventListener("click", () => pick(it.value, true));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const i = items.findIndex((x) => x.value === it.value);
      const n = items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
      pick(n.value, true);
      bs[items.indexOf(n)].focus();
    });
    el.appendChild(b);
    return b;
  });
  const sync = () => items.forEach((it, i) => bs[i].setAttribute("aria-pressed", it.value === cur ? "true" : "false"));
  const pick = (v: T, user: boolean) => {
    if (v === cur && user) return;
    cur = v;
    sync();
    if (user) onChange?.(v);
  };
  sync();
  return {
    el,
    value: () => cur,
    set: (v) => pick(v, false),
    setDisabled(d) {
      bs.forEach((b) => (b.disabled = d));
    },
  };
}

/// A number input with a unit suffix inside the box ("°C", "mm", "%").
export function numberInput(id: string, opts: { unit?: string; min?: number; max?: number; step?: string; placeholder?: string; value?: string; label?: string } = {}): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input", {
    type: "number",
    id,
    inputmode: "decimal",
    min: opts.min != null ? String(opts.min) : undefined,
    max: opts.max != null ? String(opts.max) : undefined,
    step: opts.step || "any",
    placeholder: opts.placeholder,
    "aria-label": opts.label,
  }) as HTMLInputElement;
  input.value = opts.value ?? "";
  const el = h("div", { class: "unit-in" + (opts.unit ? " has-unit" : "") }, input, opts.unit ? h("span", { class: "unit", "aria-hidden": "true", text: opts.unit }) : null);
  return { el, input };
}

/// A removable chip (`onRemove` → an × button labelled for screen readers).
export function chip(text: string, onRemove?: () => void, opts: { mono?: boolean; tone?: "ok" | "off" } = {}): HTMLElement {
  const c = h("span", { class: "chip" + (opts.mono ? " mono" : "") + (opts.tone ? " " + opts.tone : "") });
  if (opts.tone) c.appendChild(icon(opts.tone === "ok" ? "check" : "x"));
  c.appendChild(h("span", { text }));
  if (onRemove) {
    const x = h("button", { type: "button", class: "chip-x", "aria-label": "Remove " + text, title: "Remove" }, icon("x")) as HTMLButtonElement;
    x.addEventListener("click", onRemove);
    c.appendChild(x);
  }
  return c;
}

/// Inline error slot (FieldError look) for a control that isn't wrapped by
/// dom.field — e.g. a cell of the bed-temperature table.
export function errorSlot(): { el: HTMLElement; set(msg: string | null): void } {
  const el = h("div", { class: "field-error", role: "alert" });
  el.hidden = true;
  return {
    el,
    set(msg) {
      el.hidden = !msg;
      el.textContent = msg || "";
    },
  };
}
