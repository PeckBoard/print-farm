// Settings tab: farm-wide slicing + monitoring defaults (GET/PUT
// farm-settings, FARM_SETTINGS_API.md). One draft, a sticky save bar with
// dirty state, inline field errors, Reset back to what's saved.

import { h, btn, toast, errText, field, select, combobox, icon } from "./dom";
import { put, ApiError } from "./api";
import { state, loadFarmSettings, setFarmSettings, loadVendors, loadProfileItems } from "./state";
import {
  FarmSettings,
  BrimMode,
  clone,
  deepEqual,
  diffTop,
  validateFarm,
  withFarmDefaults,
  plateOptions,
  materialOptions,
  qualityOptions,
  hmsError,
  normalizeHms,
  numOrNull,
} from "./settingsModel";
import { switchToggle, segmented, numberInput, chip, errorSlot } from "./widgets";

export interface SettingsView {
  el: HTMLElement;
  show(): void;
  /// Unsaved changes? (main asks before leaving the tab.)
  dirty(): boolean;
}

const INTERVALS: [number, string][] = [
  [15, "Every 15 seconds"],
  [30, "Every 30 seconds"],
  [60, "Every minute"],
  [120, "Every 2 minutes"],
  [300, "Every 5 minutes"],
  [600, "Every 10 minutes"],
];

/// Vendors whose process presets feed the quality list: the user's own, BBL,
/// and any vendor a configured printer's default preset starts with.
async function qualityPresets(): Promise<string[]> {
  const vendors = await loadVendors();
  const want = new Set<string>();
  if (vendors.indexOf("User") >= 0) want.add("User");
  if (vendors.indexOf("BBL") >= 0) want.add("BBL");
  for (const p of state.printers) {
    const pp = p.orca_printer_profile || "";
    if (/^Bambu Lab /.test(pp)) continue;
    const v = vendors.find((x) => x !== "User" && pp.toLowerCase().startsWith(x.toLowerCase() + " "));
    if (v) want.add(v);
  }
  if (!want.size && vendors.length) want.add(vendors[0]);
  const lists = await Promise.all([...want].map((v) => loadProfileItems("process", v).catch(() => [])));
  return lists.flat().map((x) => x.name);
}

async function filamentTypes(): Promise<(string | undefined)[]> {
  const vendors = await loadVendors();
  const src = ["OrcaFilamentLibrary", "User"].filter((v) => vendors.indexOf(v) >= 0);
  const lists = await Promise.all(src.map((v) => loadProfileItems("filament", v).catch(() => [])));
  return lists.flat().map((x) => x.filament_type);
}

export function settingsView(): SettingsView {
  const body = h("div", { class: "setgrid" });
  const banner = h("div");
  const status = h("span", { class: "reason", "aria-live": "polite" });
  const resetBtn = btn("Reset", { icon: "refresh", title: "Discard unsaved changes" });
  const saveBtn = btn("Save settings", { cls: "primary", icon: "check" });
  const bar = h("div", { class: "savebar", role: "region", "aria-label": "Save farm settings" }, status, h("div", { class: "grow" }), resetBtn, saveBtn);
  const el = h(
    "section",
    { "aria-label": "Farm settings", class: "settings" },
    h("div", { class: "section-head" }, h("h2", { text: "Farm settings" }), h("span", { class: "reason", text: "Defaults for every printer and slice — a printer's own settings and the slice form override them." })),
    banner,
    body,
    bar,
  );

  let saved: FarmSettings | null = null;
  let draft: FarmSettings | null = null;
  let saving = false;
  // Server-side validation errors by field, until that field changes.
  let serverErr: Record<string, string> = {};
  const setters: Record<string, (msg: string | null) => void> = {};

  function skeleton() {
    body.replaceChildren(
      ...[0, 1, 2, 3].map(() =>
        h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("div", { class: "skel", style: { height: "14px", width: "40%" } })), h("div", { class: "panel-body" }, h("div", { class: "skel", style: { height: "120px" } }))),
      ),
    );
    bar.hidden = true;
  }

  async function load() {
    skeleton();
    banner.replaceChildren();
    try {
      saved = await loadFarmSettings(true);
    } catch (e) {
      body.replaceChildren();
      banner.replaceChildren(
        h(
          "div",
          { class: "banner bad", role: "alert" },
          icon("warn"),
          h("div", { class: "grow" }, h("b", { text: "Couldn't load the farm settings" }), h("p", { text: errText(e) }), h("div", { class: "row" }, btn("Try again", { cls: "sm", icon: "refresh", onClick: load }))),
        ),
      );
      return;
    }
    draft = clone(saved);
    render();
  }

  function panel(title: string, desc: string | null, ...children: (Node | null)[]) {
    return h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: title })),
      h("div", { class: "panel-body" }, desc ? h("p", { class: "reason pdesc", text: desc }) : null, ...children),
    );
  }

  function render() {
    if (!draft) return;
    const d = draft;
    for (const k of Object.keys(setters)) delete setters[k];
    bar.hidden = false;

    // ── slicing defaults ──
    const plate = select("fs-plate", plateOptions(d.plate_type).map((p) => ({ value: p, label: p })), d.plate_type, (v) => {
      d.plate_type = v;
      changed("plate_type");
    });
    const plateF = field("Plate type", plate, { forId: "fs-plate", hint: "The build plate installed on most printers. Picks the filament preset's bed temperature for that plate." });
    setters.plate_type = plateF.setError;

    const material = select("fs-material", materialOptions([], d.material).map((m) => ({ value: m, label: m })), d.material, (v) => {
      d.material = v;
      changed("material");
    });
    const materialF = field("Default material", material, { forId: "fs-material", hint: "Used to pick a filament preset when a printer has none set." });
    setters.material = materialF.setError;
    filamentTypes()
      .then((types) => {
        const opts = materialOptions(types, d.material);
        material.replaceChildren(...opts.map((m) => h("option", { value: m, text: m })));
        material.value = d.material;
      })
      .catch(() => {});

    const quality = combobox({
      id: "fs-quality",
      placeholder: "Search quality presets…",
      value: d.quality,
      options: qualityOptions([], d.quality),
      onChange: (v) => {
        d.quality = v;
        changed("quality");
      },
    });
    const qualityF = field("Default quality", quality.el, { forId: "fs-quality", hint: "Process preset family, matched to each printer (e.g. 0.20mm Standard @BBL X1C)." });
    setters.quality = qualityF.setError;
    qualityPresets()
      .then((names) => quality.setOptions(qualityOptions(names, d.quality)))
      .catch(() => {});

    const brimW = numberInput("fs-brim-w", { unit: "mm", min: 0.1, max: 50, step: "0.5", value: String(d.brim.width_mm), label: "Brim width" });
    const brimErr = errorSlot();
    setters["brim.width_mm"] = (m) => {
      brimErr.set(m);
      if (m) brimW.input.setAttribute("aria-invalid", "true");
      else brimW.input.removeAttribute("aria-invalid");
    };
    const syncBrim = () => {
      brimW.input.disabled = d.brim.mode !== "mm";
      brimW.input.title = d.brim.mode === "mm" ? "" : "Only used with a fixed width (mm)";
    };
    const brimSeg = segmented<BrimMode>(
      "Brim",
      [
        { value: "off", label: "Off" },
        { value: "auto", label: "Auto" },
        { value: "mm", label: "Fixed width" },
      ],
      d.brim.mode,
      (v) => {
        d.brim.mode = v;
        // Auto also uses the width: never leave a half-typed one behind.
        if (v !== "mm" && !(d.brim.width_mm > 0 && d.brim.width_mm <= 50)) {
          d.brim.width_mm = saved?.brim.width_mm ?? 5;
          brimW.input.value = String(d.brim.width_mm);
        }
        syncBrim();
        changed("brim");
        if (v === "mm") brimW.input.focus();
      },
    );
    brimW.input.addEventListener("input", () => {
      const n = numOrNull(brimW.input.value);
      d.brim.width_mm = n === null ? NaN : n;
      changed("brim.width_mm");
    });
    syncBrim();
    const brimRow = h(
      "div",
      { class: "f" },
      h("span", { class: "flabel", id: "fs-brim-l", text: "Brim" }),
      h("div", { class: "row brim-row" }, brimSeg.el, h("div", { class: "brim-w" }, brimW.el)),
      h("span", { class: "hint", text: "Auto lets OrcaSlicer add a brim where a part needs one." }),
      brimErr.el,
    );
    brimSeg.el.setAttribute("aria-labelledby", "fs-brim-l");

    const arrange = switchToggle("fs-arrange", "Auto-arrange", d.auto_arrange, (v) => ((d.auto_arrange = v), changed("auto_arrange")), "Lay parts out on the plate before slicing.");
    const orient = switchToggle("fs-orient", "Auto-orient", d.auto_orient, (v) => ((d.auto_orient = v), changed("auto_orient")), "Rotate parts to the orientation OrcaSlicer prefers.");

    // ── bed temperature override ──
    const bt = d.bed_temp_override;
    let btOn = bt.first_layer !== null || bt.other_layers !== null;
    const first = numberInput("fs-bed-first", { unit: "°C", min: 0, max: 130, step: "1", value: bt.first_layer == null ? "" : String(bt.first_layer), placeholder: "Preset" });
    const other = numberInput("fs-bed-other", { unit: "°C", min: 0, max: 130, step: "1", value: bt.other_layers == null ? "" : String(bt.other_layers), placeholder: "Preset" });
    const firstF = field("First layer", first.el, { forId: "fs-bed-first" });
    const otherF = field("Other layers", other.el, { forId: "fs-bed-other" });
    setters["bed_temp_override.first_layer"] = firstF.setError;
    setters["bed_temp_override.other_layers"] = otherF.setError;
    // Remember typed values while the override is off, so toggling back
    // doesn't lose them.
    const readBt = () => {
      bt.first_layer = btOn ? numOrNull(first.input.value) : null;
      bt.other_layers = btOn ? numOrNull(other.input.value) : null;
    };
    const syncBt = () => {
      first.input.disabled = other.input.disabled = !btOn;
    };
    const btToggle = switchToggle(
      "fs-bed-on",
      "Override the bed temperature",
      btOn,
      (v) => {
        btOn = v;
        syncBt();
        readBt();
        changed("bed_temp_override");
        if (v) first.input.focus();
      },
      "Off = each filament preset's temperature for the installed plate. Leave a field blank to keep the preset's value for it.",
    );
    first.input.addEventListener("input", () => (readBt(), changed("bed_temp_override.first_layer")));
    other.input.addEventListener("input", () => (readBt(), changed("bed_temp_override.other_layers")));
    syncBt();

    // ── printing ──
    const confirm = switchToggle(
      "fs-confirm",
      "Confirm before starting a print",
      d.confirm_before_start,
      (v) => ((d.confirm_before_start = v), changed("confirm_before_start")),
      "Agent-started prints wait on the Farm tab until you press Start.",
    );

    // ── monitoring ──
    const ivOpts = INTERVALS.slice();
    if (!ivOpts.some(([s]) => s === d.monitoring.snapshot_interval_s)) ivOpts.push([d.monitoring.snapshot_interval_s, `Every ${d.monitoring.snapshot_interval_s} s`]);
    const interval = select("fs-interval", ivOpts.map(([s, l]) => ({ value: String(s), label: l })), String(d.monitoring.snapshot_interval_s), (v) => {
      d.monitoring.snapshot_interval_s = Number(v);
      changed("monitoring");
    });
    const intervalF = field("Camera snapshots", interval, { forId: "fs-interval", hint: "How often each printer's camera image is refreshed while it prints." });

    const chips = h("div", { class: "chips", role: "list", "aria-label": "Ignored HMS codes" });
    const hmsIn = h("input", { type: "text", id: "fs-hms", class: "mono", placeholder: "XXXX_XXXX_XXXX_XXXX", autocomplete: "off", spellcheck: "false", "aria-label": "HMS code to ignore", "aria-describedby": "fs-hms-hint" }) as HTMLInputElement;
    const hmsErr = errorSlot();
    const addHms = () => {
      const err = hmsError(hmsIn.value, d.monitoring.ignored_hms);
      hmsErr.set(err);
      if (err) {
        hmsIn.setAttribute("aria-invalid", "true");
        hmsIn.focus();
        return;
      }
      hmsIn.removeAttribute("aria-invalid");
      d.monitoring.ignored_hms.push(normalizeHms(hmsIn.value)!);
      hmsIn.value = "";
      paintChips();
      changed("monitoring");
      hmsIn.focus();
    };
    hmsIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addHms();
      }
    });
    hmsIn.addEventListener("input", () => {
      if (hmsErr.el.hidden) return;
      hmsErr.set(null);
      hmsIn.removeAttribute("aria-invalid");
    });
    const paintChips = () => {
      chips.replaceChildren(
        ...(d.monitoring.ignored_hms.length
          ? d.monitoring.ignored_hms.map((c, i) => {
              const ch = chip(
                c,
                () => {
                  d.monitoring.ignored_hms.splice(i, 1);
                  paintChips();
                  changed("monitoring");
                  // Keep focus in the list (next chip's ×, else the input).
                  ((chips.querySelectorAll<HTMLElement>(".chip-x")[Math.min(i, d.monitoring.ignored_hms.length - 1)] as HTMLElement) || hmsIn).focus();
                },
                { mono: true },
              );
              ch.setAttribute("role", "listitem");
              return ch;
            })
          : [h("span", { class: "muted chips-none", text: "None — every HMS error is reported." })]),
      );
    };
    paintChips();
    const hmsBlock = h(
      "div",
      { class: "f" },
      h("label", { class: "flabel", for: "fs-hms", text: "Ignored HMS codes" }),
      chips,
      h("div", { class: "row nowrap" }, hmsIn, btn("Add", { icon: "plus", onClick: addHms })),
      h("span", { class: "hint", id: "fs-hms-hint", text: "Bambu health codes that are noise on your printers (shown in the printer's error list as XXXX_XXXX_XXXX_XXXX)." }),
      hmsErr.el,
    );
    const autoPause = switchToggle(
      "fs-autopause",
      "Pause on a detected failure",
      d.monitoring.auto_pause_on_failure,
      (v) => ((d.monitoring.auto_pause_on_failure = v), changed("monitoring")),
      "Pause the print when the printer reports a serious error that isn't ignored.",
    );

    body.replaceChildren(
      h(
        "div",
        { class: "setcol" },
        panel("Slicing defaults", null, plateF.el, h("div", { class: "grid2" }, materialF.el, qualityF.el), brimRow, h("div", { class: "switches" }, arrange.el, orient.el)),
        panel("Bed temperature", "Normally the filament preset sets the bed temperature for the installed plate.", btToggle.el, h("div", { class: "grid2" }, firstF.el, otherF.el)),
      ),
      h("div", { class: "setcol" }, panel("Monitoring", null, intervalF.el, hmsBlock, autoPause.el), panel("Printing", null, confirm.el)),
    );
    sync();
  }

  function changed(key: string) {
    // A field the server rejected is cleared once the user edits it.
    const top = key.split(".")[0];
    for (const k of Object.keys(serverErr)) if (k.split(".")[0] === top) delete serverErr[k];
    sync();
  }

  function isDirty(): boolean {
    return !!saved && !!draft && !deepEqual(saved, draft);
  }
  function sync() {
    if (!draft) return;
    const errs = { ...validateFarm(draft), ...serverErr };
    for (const [k, set] of Object.entries(setters)) set(errs[k] || null);
    const dirty = isDirty();
    const n = Object.keys(errs).length;
    saveBtn.disabled = saving || !dirty || n > 0;
    resetBtn.disabled = saving || !dirty;
    bar.classList.toggle("dirty", dirty);
    status.textContent = saving ? "Saving…" : n ? (n === 1 ? "Fix the highlighted field to save." : `Fix ${n} highlighted fields to save.`) : dirty ? "Unsaved changes" : "All changes saved";
  }

  saveBtn.onclick = async () => {
    if (!saved || !draft) return;
    if (Object.keys(validateFarm(draft)).length) return sync();
    const patch = diffTop(saved, draft);
    saving = true;
    sync();
    try {
      const r = await put<Partial<FarmSettings>>("farm-settings", patch);
      saved = withFarmDefaults(r);
      setFarmSettings(saved);
      // Keep anything typed while the request was in flight.
      draft = deepEqual(diffTop(saved, draft), {}) ? clone(saved) : draft;
      saving = false;
      toast("Farm settings saved.", "ok");
      render();
    } catch (e) {
      saving = false;
      const f = e instanceof ApiError && typeof e.body?.field === "string" ? (e.body.field as string) : null;
      if (f && setters[f]) {
        serverErr[f] = errText(e);
        document.getElementById(fieldId(f))?.focus();
      } else toast("Couldn't save the farm settings: " + errText(e), "bad");
      sync();
    }
  };
  resetBtn.onclick = () => {
    if (!saved) return;
    draft = clone(saved);
    serverErr = {};
    render();
    toast("Changes discarded.", "info", 2000);
  };

  return {
    el,
    show() {
      // Never clobber an edit in progress when coming back to the tab.
      if (!isDirty() && !saving) load();
    },
    dirty: isDirty,
  };
}

function fieldId(f: string): string {
  const ids: Record<string, string> = {
    plate_type: "fs-plate",
    material: "fs-material",
    quality: "fs-quality",
    "brim.width_mm": "fs-brim-w",
    "bed_temp_override.first_layer": "fs-bed-first",
    "bed_temp_override.other_layers": "fs-bed-other",
  };
  return ids[f] || "";
}
