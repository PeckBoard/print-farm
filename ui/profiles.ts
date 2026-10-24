// Profiles tab: browse Orca presets by kind + vendor (incl. User) with
// search; a preset's detail shows its resolved values; system presets can be
// duplicated as User presets; User presets get a typed editor (GET
// profiles/fields) with overridden-vs-inherited state, Rename / Delete, and
// an Advanced JSON view of `own`. Routes: FARM_SETTINGS_API.md.

import { h, btn, toast, errText, confirmDialog, openModal, field, select, icon, clear } from "./dom";
import { get, post, put, del, ApiError } from "./api";
import { loadVendors, loadProfileItems, resetUserProfiles } from "./state";
import { matchesQuery } from "./format";
import {
  Kind,
  KIND_LABEL,
  LIST_KIND,
  Profile,
  ProfileListItem,
  FieldDef,
  OrcaValue,
  PLATE_TEMP_KEY,
  HOT_PLATES,
  LOW_BED_C,
  clone,
  deepEqual,
  toOrca,
  fromOrca,
  fieldError,
  parseOwnJson,
  presetNameError,
} from "./settingsModel";
import { segmented, switchToggle, numberInput, errorSlot } from "./widgets";

export interface ProfilesView {
  el: HTMLElement;
  show(): void;
}

const LIST_MAX = 400;
const fieldsCache = new Map<Kind, Promise<FieldDef[]>>();

function loadFields(kind: Kind): Promise<FieldDef[]> {
  let p = fieldsCache.get(kind);
  if (!p) {
    p = get<{ fields: FieldDef[] }>(`profiles/fields?kind=${kind}`).then((r) => r.fields || []);
    p.catch(() => fieldsCache.delete(kind));
    fieldsCache.set(kind, p);
  }
  return p;
}

const profilePath = (kind: Kind, name: string) => `profiles/${kind}/${encodeURIComponent(name)}`;

/// Plate → { first, other } field defs, for the bed-temperature table.
function plateRows(fields: FieldDef[]): { plate: string; first?: FieldDef; other?: FieldDef }[] {
  const out: { plate: string; first?: FieldDef; other?: FieldDef }[] = [];
  for (const [plate, key] of Object.entries(PLATE_TEMP_KEY)) {
    const other = fields.find((f) => f.key === key);
    const first = fields.find((f) => f.key === key + "_initial_layer");
    if (first || other) out.push({ plate, first, other });
  }
  return out;
}

export function profilesView(): ProfilesView {
  let kind: Kind = "filament";
  let vendor = "";
  let vendors: string[] = [];
  let items: ProfileListItem[] = [];
  let listLoading = true;
  let listError: string | null = null;
  let query = "";
  let selected: string | null = null;
  let listSeq = 0;
  let detailSeq = 0;
  // The open User-preset editor, if any (to guard unsaved edits).
  let editor: { dirty(): boolean } | null = null;

  // ── left: filters + list ──
  const kindSeg = segmented<Kind>(
    "Preset kind",
    (["machine", "filament", "process"] as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
    kind,
    async (k) => {
      if (!(await leaveEditor())) return kindSeg.set(kind);
      kind = k;
      selected = null;
      renderDetail(null);
      loadList();
    },
  );
  const vendorSel = select("pp-vendor", [{ value: "", label: "Loading vendors…" }], "");
  vendorSel.disabled = true;
  vendorSel.addEventListener("change", async () => {
    if (!(await leaveEditor())) {
      vendorSel.value = vendor;
      return;
    }
    vendor = vendorSel.value;
    selected = null;
    renderDetail(null);
    loadList();
  });
  const search = h("input", { type: "search", id: "pp-q", placeholder: "Search presets…", autocomplete: "off", spellcheck: "false", "aria-label": "Search presets", "aria-controls": "pp-list" }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (list.querySelector(".prst[data-name]") as HTMLElement | null)?.focus();
    }
  });
  const count = h("div", { class: "pcount", "aria-live": "polite" });
  const list = h("div", { class: "presets", role: "listbox", id: "pp-list", "aria-label": "Presets" });
  const left = h(
    "div",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Presets" }), btn(null, { icon: "refresh", cls: "ghost sm", aria: "Refresh presets", onClick: () => loadList(true) })),
    h(
      "div",
      { class: "panel-body pfilters" },
      kindSeg.el,
      field("Vendor", vendorSel, { forId: "pp-vendor" }).el,
      h("div", { class: "searchbox" }, icon("search"), search),
      count,
    ),
    list,
  );
  const right = h("div", { class: "panel pdetail", "aria-live": "polite" });
  const el = h("section", { "aria-label": "Profiles", class: "profiles" }, h("div", { class: "pgrid" }, left, right));
  kindSeg.el.classList.add("seg-full");

  async function leaveEditor(): Promise<boolean> {
    if (!editor?.dirty()) return true;
    return confirmDialog({ title: "Discard unsaved changes?", body: "This User preset has changes that aren't saved.", confirm: "Discard changes", danger: true, cancel: "Keep editing" });
  }

  // ── list ──
  async function loadList(refresh = false) {
    const my = ++listSeq;
    listLoading = true;
    listError = null;
    renderList();
    try {
      if (!vendors.length || refresh) {
        vendors = await loadVendors(refresh);
        vendorSel.replaceChildren(...vendors.map((v) => h("option", { value: v, text: v === "User" ? "User (your presets)" : v })));
        vendorSel.disabled = !vendors.length;
        if (!vendor || vendors.indexOf(vendor) < 0) vendor = vendors.indexOf("BBL") >= 0 ? "BBL" : vendors[0] || "";
        vendorSel.value = vendor;
      }
      if (refresh || vendor === "User") resetUserProfiles();
      const got = vendor ? await loadProfileItems(LIST_KIND[kind], vendor) : [];
      if (my !== listSeq) return;
      items = got;
      listLoading = false;
    } catch (e) {
      if (my !== listSeq) return;
      listLoading = false;
      listError = errText(e);
    }
    renderList();
  }

  function renderList() {
    clear(list);
    if (listLoading) {
      count.textContent = "Loading…";
      for (let i = 0; i < 6; i++) list.appendChild(h("div", { class: "prst" }, h("div", { class: "skel", style: { height: "12px", width: 50 + ((i * 17) % 40) + "%" } })));
      return;
    }
    if (listError) {
      count.textContent = "";
      list.appendChild(h("div", { class: "empty small" }, h("p", { text: "Couldn't load presets: " + listError })));
      return;
    }
    if (!vendors.length) {
      count.textContent = "";
      list.appendChild(h("div", { class: "empty small" }, h("p", { text: "No OrcaSlicer profiles on this host yet — Print Farm installs them automatically." })));
      return;
    }
    const shown = query.trim() ? items.filter((x) => matchesQuery(x.name, query)) : items;
    count.textContent = `${shown.length} ${KIND_LABEL[kind].toLowerCase()} preset${shown.length === 1 ? "" : "s"}${query.trim() ? " match" : ""}` + (shown.length > LIST_MAX ? ` — showing the first ${LIST_MAX}, refine the search` : "");
    if (!shown.length) {
      list.appendChild(
        h(
          "div",
          { class: "empty small" },
          h("p", {
            text: query.trim()
              ? "No presets match that search."
              : vendor === "User"
                ? `No User ${KIND_LABEL[kind].toLowerCase()} presets yet. Open a system preset and choose “Duplicate as User preset”.`
                : `${vendor} has no ${KIND_LABEL[kind].toLowerCase()} presets.`,
          }),
        ),
      );
      return;
    }
    for (const it of shown.slice(0, LIST_MAX)) {
      const on = it.name === selected;
      const row = h(
        "div",
        { class: "prst" + (on ? " active" : ""), role: "option", tabindex: "0", "aria-selected": on ? "true" : "false", "data-name": it.name, title: it.name },
        h("span", { class: "nm", text: it.name }),
        it.user || vendor === "User" ? h("span", { class: "badge user", text: "User" }) : null,
      );
      row.addEventListener("click", () => pick(it.name));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick(it.name);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const sib = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
          if (sib) sib.focus();
          else if (e.key === "ArrowUp") search.focus();
        }
      });
      list.appendChild(row);
    }
  }

  async function pick(name: string) {
    if (name === selected) return;
    if (!(await leaveEditor())) return;
    selected = name;
    for (const r of Array.from(list.querySelectorAll<HTMLElement>(".prst[data-name]"))) {
      const on = r.dataset.name === name;
      r.classList.toggle("active", on);
      r.setAttribute("aria-selected", on ? "true" : "false");
    }
    loadDetail(name);
    // Phone: the detail sits below the list.
    if (window.innerWidth <= 860) right.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // ── detail ──
  function renderDetail(content: Node[] | null) {
    editor = null;
    clear(right);
    if (!content) {
      right.append(
        h(
          "div",
          { class: "empty small pempty" },
          h("div", { class: "ico" }, icon("layers")),
          h("h3", { text: "Pick a preset" }),
          h("p", { text: "See every value it resolves to. Duplicate a system preset to make your own User preset, then edit it here." }),
        ),
      );
      return;
    }
    right.append(...content);
  }

  async function loadDetail(name: string) {
    const my = ++detailSeq;
    renderDetail([
      h("div", { class: "panel-head" }, h("div", { class: "skel", style: { height: "16px", width: "55%" } })),
      h("div", { class: "panel-body" }, h("div", { class: "skel", style: { height: "60px" } }), h("div", { class: "skel", style: { height: "220px" } })),
    ]);
    try {
      const [p, fields] = await Promise.all([get<Profile>(profilePath(kind, name) + (vendor ? "?vendor=" + encodeURIComponent(vendor) : "")), loadFields(kind).catch(() => [] as FieldDef[])]);
      if (my !== detailSeq) return;
      // The chain may not resolve (missing parent): show what we have.
      p.resolved = p.resolved || {};
      let parent: Record<string, OrcaValue> | null = null;
      if (p.user && p.inherits) {
        parent = await get<Profile>(profilePath(kind, p.inherits))
          .then((x) => x.resolved || null)
          .catch(() => null);
        if (my !== detailSeq) return;
      }
      showProfile(p, fields, parent);
    } catch (e) {
      if (my !== detailSeq) return;
      renderDetail([
        h("div", { class: "panel-head" }, h("h3", { text: name })),
        h("div", { class: "panel-body" }, h("div", { class: "banner bad", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Couldn't load this preset" }), h("p", { text: errText(e) })))),
      ]);
    }
  }

  function showProfile(p: Profile, fields: FieldDef[], parent: Record<string, OrcaValue> | null) {
    const user = !!p.user;
    const acts = h("div", { class: "row pacts" });
    if (user) {
      acts.append(
        btn("Duplicate", { cls: "sm", icon: "plus", onClick: () => duplicate(p) }),
        btn("Rename", { cls: "sm", icon: "edit", onClick: () => rename(p) }),
        btn("Delete", { cls: "sm danger", icon: "trash", onClick: () => remove(p) }),
      );
    } else acts.append(btn("Duplicate as User preset", { cls: "primary sm", icon: "plus", onClick: () => duplicate(p) }));

    const head = h(
      "div",
      { class: "panel-head phead" },
      h("div", { class: "ptitle" }, h("h3", { text: p.name, title: p.name }), h("div", { class: "row tight" }, h("span", { class: "badge" + (user ? " user" : ""), text: user ? "User preset" : "System preset" }), !user && p.vendor ? h("span", { class: "badge", text: p.vendor }) : null)),
      acts,
    );
    const meta = h("div", { class: "pmeta" });
    if (p.inherits)
      meta.append(
        h("span", { class: "muted", text: "Inherits " }),
        h("button", {
          type: "button",
          class: "linkbtn",
          text: p.inherits,
          title: "Show the parent preset",
          onclick: async () => {
            if (!(await leaveEditor())) return;
            selected = p.inherits;
            loadDetail(p.inherits!);
            renderList();
          },
        }),
      );
    if (user && p.path) meta.append(h("span", { class: "mono path", text: p.path, title: p.path }));
    if (p.resolve_error)
      meta.append(h("div", { class: "banner warn slim", role: "status", style: { flexBasis: "100%" } }, icon("warn"), h("div", { class: "grow" }, h("p", { text: "Couldn't resolve the inherits chain: " + p.resolve_error }))));

    if (!user) {
      const body = h(
        "div",
        { class: "panel-body" },
        meta.childNodes.length ? meta : null,
        h("div", { class: "banner info slim", role: "note" }, icon("info"), h("div", { class: "grow" }, h("p", { text: "System presets are read-only. Duplicate it as a User preset to change values — the copy inherits everything else from this one." }))),
        fields.length ? typedView(p, fields, null, null) : null,
        resolvedTable(p.resolved),
      );
      renderDetail([head, body]);
      return;
    }
    const ue = userEditor(p, fields, parent, meta);
    renderDetail([head, ...ue.nodes]);
    editor = { dirty: ue.dirty };
  }

  // ── typed form (read-only for system presets, editable for User) ──
  interface Ed {
    own: Record<string, OrcaValue>;
    parent: Record<string, OrcaValue> | null;
    /// A value changed; `resetKey` = that field was reset (repaint + focus it).
    onChange(resetKey?: string): void;
    errors: Map<string, string>;
  }

  /// Renders the grouped typed fields. `ed` = editable state (User preset).
  function typedView(p: Profile, fields: FieldDef[], ed: Ed | null, focusKey: string | null): HTMLElement {
    const wrap = h("div", { class: "pform" + (ed ? "" : " ro") });
    const plates = kind === "filament" ? plateRows(fields) : [];
    const plateKeys = new Set(plates.flatMap((r) => [r.first?.key, r.other?.key]).filter(Boolean) as string[]);
    const groups: { name: string; fields: FieldDef[] }[] = [];
    let plateGroupAt = -1;
    for (const f of fields) {
      if (plateKeys.has(f.key)) {
        if (plateGroupAt < 0) {
          plateGroupAt = groups.length;
          groups.push({ name: "\u0000plates", fields: [] });
        }
        continue;
      }
      const g = f.group || "General";
      let grp = groups.find((x) => x.name === g);
      if (!grp) groups.push((grp = { name: g, fields: [] }));
      grp.fields.push(f);
    }
    const base = (k: string) => (ed ? (ed.parent ? ed.parent[k] : p.resolved[k]) : p.resolved[k]);
    const valueOf = (k: string) => (ed && k in ed.own ? ed.own[k] : ed ? base(k) : p.resolved[k]);

    for (const g of groups) {
      if (g.name === "\u0000plates") {
        wrap.appendChild(plateTable(plates, ed, valueOf, base));
        continue;
      }
      const fs = h("fieldset", { class: "pgroup" }, h("legend", { text: g.name }));
      for (const f of g.fields) fs.appendChild(fieldRow(f, ed, valueOf, base));
      wrap.appendChild(fs);
    }
    if (focusKey) setTimeout(() => (wrap.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"] input, [data-key="${CSS.escape(focusKey)}"] select`) || null)?.focus(), 0);
    return wrap;
  }

  function idFor(key: string) {
    return "pe-" + key.replace(/[^a-z0-9_]/gi, "_");
  }

  /// One typed control. `ed` null → read-only text.
  function control(f: FieldDef, ed: Ed | null, valueOf: (k: string) => OrcaValue | undefined, base: (k: string) => OrcaValue | undefined) {
    const id = idFor(f.key);
    const text = fromOrca(f, valueOf(f.key));
    const err = errorSlot();
    const set = (t: string) => {
      if (!ed) return;
      const e = fieldError(f, t);
      if (e) ed.errors.set(f.key, e);
      else ed.errors.delete(f.key);
      err.set(e);
      if (e) focusEl.setAttribute("aria-invalid", "true");
      else focusEl.removeAttribute("aria-invalid");
      ed.own[f.key] = toOrca(f, t, ed.own[f.key] ?? base(f.key));
      ed.onChange();
    };
    let ctl: HTMLElement;
    let focusEl: HTMLElement;
    if (!ed) {
      const shown = valueOf(f.key) === undefined ? "—" : f.type === "bool" ? (text === "1" ? "On" : "Off") : f.type === "enum" ? f.options?.find((o) => o.value === text)?.label || text : text + (f.type === "percent" ? "%" : f.unit ? " " + f.unit : "");
      ctl = h("span", { class: "rov", id, text: shown });
      focusEl = ctl;
    } else if (f.type === "bool") {
      const t = switchToggle(id, "", text === "1", (v) => set(v ? "1" : "0"));
      t.el.classList.add("bare");
      ctl = t.el;
      focusEl = t.input;
    } else if (f.type === "enum") {
      const opts = (f.options || []).slice();
      if (text && !opts.some((o) => o.value === text)) opts.unshift({ value: text, label: text + " (current)" });
      const s = select(id, opts, text, (v) => set(v));
      ctl = s;
      focusEl = s;
    } else {
      const n = numberInput(id, { unit: f.type === "percent" ? "%" : f.unit, min: f.min, max: f.max, step: f.type === "int" ? "1" : "any", value: text });
      n.input.addEventListener("input", () => set(n.input.value));
      ctl = n.el;
      focusEl = n.input;
      if (f.min != null || f.max != null) n.input.title = `${f.min ?? "…"} – ${f.max ?? "…"}${f.type === "percent" ? "%" : f.unit ? " " + f.unit : ""}`;
    }
    return { id, ctl, focusEl, err };
  }

  function resetBtn(f: FieldDef, ed: Ed, label: string) {
    const b = h("button", { type: "button", class: "rst", title: "Reset to inherited value", "aria-label": `Reset ${label} to the inherited value` }, icon("refresh")) as HTMLButtonElement;
    b.addEventListener("click", () => {
      delete ed.own[f.key];
      ed.errors.delete(f.key);
      ed.onChange(f.key);
    });
    return b;
  }

  function fieldRow(f: FieldDef, ed: Ed | null, valueOf: (k: string) => OrcaValue | undefined, base: (k: string) => OrcaValue | undefined): HTMLElement {
    const c = control(f, ed, valueOf, base);
    const over = !!ed && f.key in ed.own;
    const row = h(
      "div",
      { class: "prow2" + (over ? " ovr" : ""), "data-key": f.key },
      h("label", { class: "plabel", for: c.id }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: f.label }), over ? h("span", { class: "sr", text: " (overridden)" }) : null),
      h("div", { class: "pctl" }, c.ctl),
      ed ? resetBtn(f, ed, f.label) : h("span"),
      c.err.el,
    );
    if (ed) {
      // Typing in an inherited field makes it an override (shown at once).
      c.focusEl.addEventListener("input", () => row.classList.add("ovr"));
      c.focusEl.addEventListener("change", () => row.classList.add("ovr"));
      const e = ed.errors.get(f.key);
      if (e) c.err.set(e);
    }
    return row;
  }

  function plateTable(rows: ReturnType<typeof plateRows>, ed: Ed | null, valueOf: (k: string) => OrcaValue | undefined, base: (k: string) => OrcaValue | undefined): HTMLElement {
    const fs = h("fieldset", { class: "pgroup" }, h("legend", { text: "Bed temperature by plate" }));
    const tbl = h("table", { class: "btable" });
    tbl.appendChild(h("thead", null, h("tr", null, h("th", { scope: "col", text: "Plate" }), h("th", { scope: "col", text: "First layer" }), h("th", { scope: "col", text: "Other layers" }))));
    const tb = h("tbody");
    for (const r of rows) {
      const cell = (f: FieldDef | undefined, which: string) => {
        if (!f) return h("td", { class: "muted", text: "—" });
        const c = control(f, ed, valueOf, base);
        const over = !!ed && f.key in ed.own;
        const label = `${r.plate}, ${which}`;
        c.focusEl.setAttribute("aria-label", label + " bed temperature");
        const td = h("td", { class: "bcell" + (over ? " ovr" : ""), "data-key": f.key }, h("div", { class: "bwrap" }, h("span", { class: "dot", "aria-hidden": "true" }), c.ctl, ed ? resetBtn(f, ed, label) : null), c.err.el);
        const warnLow = () => {
          const t = Number(fromOrca(f, valueOf(f.key)));
          const low = HOT_PLATES.indexOf(r.plate) >= 0 && isFinite(t) && t > 0 && t < LOW_BED_C;
          td.classList.toggle("low", low);
          td.title = low ? `${t} °C is unusually low for a ${r.plate}` : "";
        };
        warnLow();
        if (ed) {
          c.focusEl.addEventListener("input", () => {
            td.classList.add("ovr");
            warnLow();
          });
          const e = ed.errors.get(f.key);
          if (e) c.err.set(e);
        }
        return td;
      };
      tb.appendChild(h("tr", null, h("th", { scope: "row", text: r.plate }), cell(r.first, "first layer"), cell(r.other, "other layers")));
    }
    tbl.appendChild(tb);
    fs.append(h("div", { class: "btable-wrap" }, tbl), h("p", { class: "hint", text: "The slicer uses the row for the plate installed on the printer (or picked when slicing)." }));
    return fs;
  }

  function resolvedTable(resolved: Record<string, OrcaValue>): HTMLElement {
    const keys = Object.keys(resolved).sort();
    const filter = h("input", { type: "search", placeholder: "Filter keys…", "aria-label": "Filter resolved values", autocomplete: "off" }) as HTMLInputElement;
    const tb = h("tbody");
    const paint = () => {
      clear(tb);
      const q = filter.value.trim();
      for (const k of keys) {
        const v = resolved[k];
        const s = Array.isArray(v) ? v.join(", ") : String(v);
        if (q && !matchesQuery(k + " " + s, q)) continue;
        tb.appendChild(h("tr", null, h("td", { class: "k mono", text: k }), h("td", { class: "v mono", text: s })));
      }
    };
    filter.addEventListener("input", paint);
    const d = h("details", { class: "rtable" }, h("summary", { text: `All resolved values (${keys.length})` }), h("div", { class: "stack tight" }, filter, h("div", { class: "rtable-wrap" }, h("table", { class: "ftable" }, tb))));
    d.addEventListener("toggle", () => d.open && !tb.childNodes.length && paint());
    return d;
  }

  // ── User preset editor ──
  function userEditor(p: Profile, fields: FieldDef[], parent: Record<string, OrcaValue> | null, meta: HTMLElement): { nodes: Node[]; dirty: () => boolean } {
    let saved = clone(p.own || {});
    let mode: "form" | "json" = "form";
    let saving = false;
    const ed: Ed = { own: clone(saved), parent, errors: new Map(), onChange: () => {} };
    const host = h("div", { class: "stack" });
    const countEl = h("span", { class: "muted" });
    const jsonErr = errorSlot();
    const ta = h("textarea", { class: "mono json", id: "pe-json", spellcheck: "false", rows: 16, "aria-label": "Overrides as JSON", "aria-describedby": "pe-json-hint" }) as HTMLTextAreaElement;
    const status = h("span", { class: "reason", "aria-live": "polite" });
    const discardBtn = btn("Discard", { icon: "refresh" });
    const saveBtn = btn("Save preset", { cls: "primary", icon: "check" });
    const bar = h("div", { class: "savebar inpanel" }, status, h("div", { class: "grow" }), discardBtn, saveBtn);
    const modeSeg = segmented<"form" | "json">(
      "Editor",
      [
        { value: "form", label: "Form" },
        { value: "json", label: "Advanced (JSON)" },
      ],
      "form",
      (m) => switchMode(m),
    );
    const known = new Set(fields.map((f) => f.key));

    const jsonState = (): { own: Record<string, OrcaValue> } | { error: string } => (mode === "json" ? parseOwnJson(ta.value) : { own: ed.own });
    const isDirty = () => {
      const s = jsonState();
      return "error" in s ? true : !deepEqual(s.own, saved);
    };

    function paint(focusKey: string | null = null) {
      clear(host);
      if (mode === "json") {
        host.append(
          h("p", { class: "reason", id: "pe-json-hint", text: "Only this preset's own overrides — everything else is inherited. Values are Orca's on-disk text (arrays for per-extruder keys)." }),
          ta,
          jsonErr.el,
        );
        return;
      }
      const extra = Object.keys(ed.own).filter((k) => !known.has(k));
      host.append(
        h(
          "div",
          { class: "legendline" },
          h("span", { class: "lg ovr" }, h("span", { class: "dot", "aria-hidden": "true" }), "Overridden here"),
          h("span", { class: "lg" }, h("span", { class: "dot", "aria-hidden": "true" }), parent ? "Inherited" : "Inherited (parent not found — showing resolved values)"),
          countEl,
        ),
      );
      if (fields.length) host.append(typedView(p, fields, ed, focusKey));
      else host.append(h("div", { class: "banner warn slim" }, icon("warn"), h("div", { class: "grow" }, h("p", { text: "The typed field list isn't available — use Advanced (JSON)." }))));
      if (extra.length)
        host.append(
          h("p", { class: "reason", text: `Also overridden (edit in Advanced): ${extra.slice(0, 12).join(", ")}${extra.length > 12 ? ` and ${extra.length - 12} more` : ""}.` }),
        );
    }

    function switchMode(m: "form" | "json") {
      if (m === mode) return;
      if (m === "json") {
        ta.value = JSON.stringify(ed.own, null, 2);
        jsonErr.set(null);
        mode = "json";
        paint();
        ta.focus();
      } else {
        const r = parseOwnJson(ta.value);
        if ("error" in r) {
          jsonErr.set(r.error);
          ta.setAttribute("aria-invalid", "true");
          modeSeg.set("json");
          ta.focus();
          return;
        }
        ed.own = r.own;
        ed.errors.clear();
        for (const f of fields) if (f.key in ed.own) {
          const e = fieldError(f, fromOrca(f, ed.own[f.key]));
          if (e) ed.errors.set(f.key, e);
        }
        mode = "form";
        paint();
      }
      sync();
    }
    ta.addEventListener("input", () => {
      const r = parseOwnJson(ta.value);
      jsonErr.set("error" in r ? r.error : null);
      if ("error" in r) ta.setAttribute("aria-invalid", "true");
      else ta.removeAttribute("aria-invalid");
      sync();
    });

    ed.onChange = (resetKey?: string) => {
      if (resetKey) paint(resetKey);
      sync();
    };

    function sync() {
      const dirty = isDirty();
      const n = Object.keys(ed.own).length;
      countEl.textContent = `${n} override${n === 1 ? "" : "s"}`;
      const s = jsonState();
      const bad = "error" in s ? 1 : ed.errors.size;
      saveBtn.disabled = saving || !dirty || bad > 0;
      discardBtn.disabled = saving || !dirty;
      bar.classList.toggle("dirty", dirty);
      status.textContent = saving
        ? "Saving…"
        : "error" in s
          ? "Fix the JSON to save."
          : bad
            ? `Fix ${bad} highlighted value${bad === 1 ? "" : "s"} to save.`
            : dirty
              ? "Unsaved changes"
              : "No unsaved changes";
    }

    discardBtn.onclick = () => {
      ed.own = clone(saved);
      ed.errors.clear();
      ta.value = JSON.stringify(ed.own, null, 2);
      jsonErr.set(null);
      ta.removeAttribute("aria-invalid");
      paint();
      sync();
    };
    saveBtn.onclick = async () => {
      const s = jsonState();
      if ("error" in s) {
        jsonErr.set(s.error);
        return;
      }
      saving = true;
      sync();
      try {
        const r = await put<Profile>(profilePath(kind, p.name), { own: s.own });
        saved = clone(r.own || s.own);
        ed.own = clone(saved);
        p.resolved = r.resolved || p.resolved;
        if (mode === "json") ta.value = JSON.stringify(ed.own, null, 2);
        saving = false;
        toast(`Saved ${p.name}.`, "ok");
        paint();
      } catch (e) {
        saving = false;
        const f = e instanceof ApiError && typeof e.body?.field === "string" ? (e.body.field as string) : null;
        if (f && mode === "form" && known.has(f)) {
          ed.errors.set(f, errText(e));
          paint(f);
        } else if (mode === "json") jsonErr.set(errText(e));
        else toast("Couldn't save: " + errText(e), "bad");
      }
      sync();
    };

    paint();
    sync();
    const body = h(
      "div",
      { class: "panel-body" },
      meta.childNodes.length ? meta : null,
      h("div", { class: "row between" }, h("p", { class: "subhead", text: "Values" }), modeSeg.el),
      host,
      resolvedTable(p.resolved),
    );
    return { nodes: [body, bar], dirty: isDirty };
  }

  // ── duplicate / rename / delete ──
  async function userNames(): Promise<string[]> {
    if (vendors.indexOf("User") < 0) return [];
    return loadProfileItems(LIST_KIND[kind], "User")
      .then((xs) => xs.map((x) => x.name))
      .catch(() => []);
  }

  function nameDialog(o: { title: string; label: string; value: string; confirm: string; current?: string; note?: string; submit: (name: string) => Promise<void> }) {
    const m = openModal(o.title, { small: true });
    const input = h("input", { type: "text", id: "pe-name", autocomplete: "off", spellcheck: "false", maxlength: "120" }) as HTMLInputElement;
    input.value = o.value;
    const f = field(o.label, input, { forId: "pe-name", hint: o.note });
    const ok = btn(o.confirm, { cls: "primary" });
    const reason = h("span", { class: "reason" });
    let taken: string[] = [];
    let busy = false;
    let touched = false;
    const check = () => {
      const e = presetNameError(input.value, taken, o.current);
      f.setError(touched ? e : null);
      ok.disabled = busy || !!e || input.value.trim() === o.current;
      reason.textContent = busy ? "Working…" : "";
      return !e;
    };
    userNames().then((n) => {
      taken = n;
      check();
    });
    input.addEventListener("input", () => {
      touched = true;
      check();
    });
    const go = async () => {
      touched = true;
      if (!check() || ok.disabled) return;
      busy = true;
      check();
      try {
        await o.submit(input.value.trim());
        m.close();
      } catch (e) {
        busy = false;
        f.setError(e instanceof ApiError && (e.status === 409 || e.body?.error === "exists") ? "A preset with this name already exists (system or User) — pick another." : errText(e));
        ok.disabled = false;
        reason.textContent = "";
      }
    };
    ok.onclick = go;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
    m.body.append(f.el);
    m.foot.append(reason, btn("Cancel", { onClick: () => m.close() }), ok);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    check();
  }

  async function afterUserChange(name: string | null) {
    resetUserProfiles();
    if (vendors.indexOf("User") < 0) vendors = await loadVendors(true);
    vendor = name ? "User" : vendor;
    vendorSel.replaceChildren(...vendors.map((v) => h("option", { value: v, text: v === "User" ? "User (your presets)" : v })));
    vendorSel.value = vendor;
    query = "";
    search.value = "";
    selected = name;
    await loadList();
    if (name) {
      loadDetail(name);
      list.querySelector<HTMLElement>(`.prst[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "nearest" });
    } else renderDetail(null);
  }

  function duplicate(p: Profile) {
    nameDialog({
      title: p.user ? "Duplicate preset" : "Duplicate as User preset",
      label: "Name",
      value: `${p.name} (copy)`,
      confirm: "Create preset",
      note: p.user ? "A copy with the same overrides." : `Inherits every value from “${p.name}”; you then change only what you need.`,
      submit: async (name) => {
        if (!(await leaveEditor())) throw new Error("Save or discard your changes first.");
        await post<Profile>("profiles", { kind, name, inherits: p.user ? p.inherits : p.name, own: p.user ? clone(p.own || {}) : {} });
        toast(`Created User preset “${name}”.`, "ok");
        await afterUserChange(name);
      },
    });
  }

  function rename(p: Profile) {
    nameDialog({
      title: "Rename preset",
      label: "New name",
      value: p.name,
      current: p.name,
      confirm: "Rename",
      note: editor?.dirty() ? "Unsaved changes are kept out of the rename — save them first if you want them." : undefined,
      submit: async (name) => {
        await put<Profile>(profilePath(kind, p.name), { name, own: p.own || {} });
        toast(`Renamed to “${name}”.`, "ok");
        editor = null;
        await afterUserChange(name);
      },
    });
  }

  async function remove(p: Profile) {
    const ok = await confirmDialog({
      title: `Delete ${p.name}?`,
      body: "The User preset is removed from OrcaSlicer's user presets on this host. Printers or slices that name it fall back to their other defaults.",
      confirm: "Delete preset",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(profilePath(kind, p.name));
      toast(`Deleted ${p.name}.`, "ok");
      editor = null;
      await afterUserChange(null);
    } catch (e) {
      toast("Couldn't delete: " + errText(e), "bad");
    }
  }

  renderDetail(null);
  let loaded = false;
  return {
    el,
    show() {
      if (!loaded) {
        loaded = true;
        loadList();
      }
    },
  };
}
