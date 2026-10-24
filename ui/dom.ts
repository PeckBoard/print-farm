// Tiny DOM toolkit for the page: element builder, icons, toasts, modal +
// confirm dialog, and a searchable combobox. Data is always rendered with
// textContent; innerHTML is used only for the static icon SVGs below.

import { matchesQuery } from "./format";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k in el && typeof v !== "string") (el as any)[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: (Child | Child[])[]) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function clear(el: Node) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ── icons (lucide paths) ───────────────────────────────────────────────────

const P: Record<string, string> = {
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  camoff: '<path d="M2 2l20 20M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5"/><path d="M14.1 14.1A3 3 0 0 1 9.9 9.9"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  slice: '<path d="M3 7h18M3 12h18M3 17h18"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  ext: '<path d="M7 17 17 7M8 7h9v9"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
};

export function icon(name: string): SVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML =
    '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (P[name] || "") +
    "</svg>";
  return wrap.firstChild as SVGElement;
}

export function btn(label: string | null, opts: { icon?: string; cls?: string; onClick?: (e: MouseEvent) => void; title?: string; disabled?: boolean; aria?: string; type?: string } = {}): HTMLButtonElement {
  const b = h("button", {
    type: opts.type || "button",
    class: "btn " + (opts.cls || ""),
    title: opts.title,
    "aria-label": opts.aria,
    disabled: opts.disabled,
  });
  if (opts.icon) b.appendChild(icon(opts.icon));
  if (label) b.appendChild(document.createTextNode(label));
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

// ── toasts ─────────────────────────────────────────────────────────────────

let toastHost: HTMLElement | null = null;

export function toast(msg: string, tone: "ok" | "bad" | "info" = "info", ms = tone === "bad" ? 7000 : 3500) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastHost);
  }
  const close = btn(null, { icon: "x", cls: "ghost sm", aria: "Dismiss" });
  const t = h("div", { class: "toast " + tone }, icon(tone === "bad" ? "warn" : tone === "ok" ? "check" : "info"), h("div", { class: "grow", text: msg }), close);
  const kill = () => t.remove();
  close.onclick = kill;
  toastHost.appendChild(t);
  setTimeout(kill, ms);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── modal ──────────────────────────────────────────────────────────────────

export interface ModalHandle {
  close(): void;
  body: HTMLElement;
  foot: HTMLElement;
  root: HTMLElement;
}

/// Open a modal dialog. Esc / backdrop click close it; focus is trapped and
/// restored to the opener afterwards.
export function openModal(title: string, opts: { small?: boolean; onClose?: () => void } = {}): ModalHandle {
  const opener = document.activeElement as HTMLElement | null;
  const titleId = "m" + Math.random().toString(36).slice(2);
  const body = h("div", { class: "modal-body" });
  const foot = h("div", { class: "modal-foot" });
  const closeBtn = btn(null, { icon: "x", cls: "ghost sm", aria: "Close" });
  const modal = h(
    "div",
    { class: "modal" + (opts.small ? " sm" : ""), role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h("div", { class: "modal-head" }, h("h2", { id: titleId, text: title }), closeBtn),
    body,
    foot,
  );
  const backdrop = h("div", { class: "backdrop" }, modal);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
    opener?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Let an open combobox close first.
      if (document.querySelector(".listbox")) return;
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      const f = Array.from(modal.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")).filter(
        (x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null,
      );
      if (!f.length) return;
      const first = f[0],
        last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  closeBtn.onclick = close;
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
  setTimeout(() => {
    const first = modal.querySelector<HTMLElement>(".modal-body input, .modal-body select, .modal-foot .btn.primary, .modal-foot .btn.danger");
    (first || closeBtn).focus();
  }, 0);
  return { close, body, foot, root: modal };
}

/// A confirm dialog; resolves true only on the confirm button.
export function confirmDialog(o: { title: string; body: string | Node; confirm: string; danger?: boolean; cancel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal(o.title, { small: true, onClose: () => resolve(result) });
    m.body.appendChild(typeof o.body === "string" ? h("p", { text: o.body }) : o.body);
    const ok = btn(o.confirm, {
      cls: o.danger ? "danger solid" : "primary",
      onClick: () => {
        result = true;
        m.close();
      },
    });
    m.foot.append(btn(o.cancel || "Cancel", { onClick: () => m.close() }), ok);
    setTimeout(() => ok.focus(), 0);
  });
}

// ── combobox ───────────────────────────────────────────────────────────────

export interface Combo {
  el: HTMLElement;
  input: HTMLInputElement;
  setOptions(opts: string[]): void;
  setValue(v: string): void;
  value(): string;
  setDisabled(reason: string | null): void;
}

/// Searchable single-select combobox. The value is always one of the options
/// (or "") — typed text that matches nothing reverts on blur.
export function combobox(o: { id: string; placeholder?: string; options?: string[]; value?: string; onChange?: (v: string) => void; allowEmpty?: boolean; emptyLabel?: string }): Combo {
  let options = o.options || [];
  let value = o.value || "";
  let open = false;
  let hi = -1;
  let seekCurrent = false;
  let shown: string[] = [];
  const listId = o.id + "-list";
  const input = h("input", {
    type: "text",
    id: o.id,
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    autocomplete: "off",
    spellcheck: "false",
    placeholder: o.placeholder || "Search…",
  }) as HTMLInputElement;
  input.value = value;
  const list = h("div", { class: "listbox", role: "listbox", id: listId });
  const el = h("div", { class: "combo" }, input, h("span", { class: "caret" }, icon("down")));

  const place = () => {
    const r = input.getBoundingClientRect();
    list.style.left = r.left + "px";
    list.style.width = Math.max(r.width, 220) + "px";
    const below = window.innerHeight - r.bottom;
    if (below < 200 && r.top > below) {
      list.style.top = "";
      list.style.bottom = window.innerHeight - r.top + 4 + "px";
    } else {
      list.style.bottom = "";
      list.style.top = r.bottom + 4 + "px";
    }
  };
  const render = (q: string) => {
    clear(list);
    shown = (q && q !== value ? options.filter((x) => matchesQuery(x, q)) : options).slice(0, 300);
    // The current value stays reachable even past the cap (User presets sit
    // after a vendor's few hundred system ones).
    if (value && shown.indexOf(value) < 0 && options.indexOf(value) >= 0 && (!q || q === value || matchesQuery(value, q))) shown.push(value);
    if (o.allowEmpty && !q) shown = [""].concat(shown);
    // Opening highlights the current value where it actually sits.
    if (seekCurrent) {
      seekCurrent = false;
      hi = Math.max(0, shown.indexOf(value));
    }
    if (!shown.length) list.appendChild(h("div", { class: "none", text: options.length ? "No matches" : "No options" }));
    shown.forEach((opt, i) => {
      const d = h("div", {
        class: "opt" + (opt === value ? " cur" : ""),
        role: "option",
        id: listId + "-" + i,
        "aria-selected": i === hi ? "true" : "false",
        text: opt || o.emptyLabel || "— none —",
      });
      d.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(opt);
      });
      list.appendChild(d);
    });
    if (hi >= 0) {
      input.setAttribute("aria-activedescendant", listId + "-" + hi);
      list.children[hi]?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const show = () => {
    if (input.disabled) return;
    if (!open) {
      open = true;
      document.body.appendChild(list);
      input.setAttribute("aria-expanded", "true");
      seekCurrent = true;
    }
    place();
    render(input.value);
  };
  const hide = () => {
    if (!open) return;
    open = false;
    list.remove();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    hi = -1;
  };
  const pick = (v: string) => {
    value = v;
    input.value = v;
    input.removeAttribute("aria-invalid");
    hide();
    o.onChange?.(v);
  };
  input.addEventListener("focus", () => input.select());
  input.addEventListener("click", show);
  input.addEventListener("input", () => {
    hi = 0;
    show();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const d = e.key === "ArrowDown" ? 1 : -1;
      hi = Math.max(0, Math.min(shown.length - 1, hi + d));
      render(input.value);
    } else if (e.key === "Enter") {
      if (open && hi >= 0 && shown[hi] !== undefined) {
        e.preventDefault();
        pick(shown[hi]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        input.value = value;
        hide();
      }
    } else if (e.key === "Tab") {
      hide();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      hide();
      if (input.value !== value) {
        const exact = options.find((x) => x.toLowerCase() === input.value.trim().toLowerCase());
        if (exact !== undefined) pick(exact);
        else if (!input.value.trim() && o.allowEmpty) pick("");
        else input.value = value;
      }
    }, 120);
  });
  window.addEventListener("resize", () => open && place());
  document.addEventListener("scroll", () => open && place(), true);

  return {
    el,
    input,
    setOptions(opts) {
      options = opts;
      if (open) render(input.value);
    },
    setValue(v) {
      value = v;
      input.value = v;
    },
    value: () => value,
    setDisabled(reason) {
      input.disabled = !!reason;
      if (reason) {
        input.placeholder = reason;
        hide();
      } else input.placeholder = o.placeholder || "Search…";
    },
  };
}

/// Labelled form field wrapper with an inline error slot.
export function field(label: string, control: HTMLElement, opts: { hint?: string; forId?: string } = {}): { el: HTMLElement; setError(msg: string | null): void } {
  const err = h("div", { class: "field-error", role: "alert" });
  err.hidden = true;
  const el = h("label", { class: "f", for: opts.forId }, h("span", { text: label }), control, opts.hint ? h("span", { class: "hint", text: opts.hint }) : null, err);
  return {
    el,
    setError(msg) {
      err.hidden = !msg;
      err.textContent = msg || "";
      const inp = control.matches("input,select") ? control : control.querySelector("input,select");
      if (inp) {
        if (msg) inp.setAttribute("aria-invalid", "true");
        else inp.removeAttribute("aria-invalid");
      }
    },
  };
}

export function select(id: string, opts: { value: string; label: string; disabled?: boolean }[], value: string, onChange?: (v: string) => void): HTMLSelectElement {
  const s = h("select", { id }) as HTMLSelectElement;
  for (const o of opts) s.appendChild(h("option", { value: o.value, text: o.label, disabled: o.disabled }));
  s.value = value;
  if (onChange) s.addEventListener("change", () => onChange(s.value));
  return s;
}
