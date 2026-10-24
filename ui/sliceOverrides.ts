// Slice form additions: the plate type (defaulting to the printer's / farm's
// effective plate), an "Overrides" disclosure (brim, bed temperature), and
// the post-slice `effective` block read back from the G-code — with a loud
// warning when the bed is suspiciously cold for the plate.

import { h, select, field, icon } from "./dom";
import { get } from "./api";
import { loadFarmSettings } from "./state";
import { FarmSettings, PrinterSettings, SliceEffective, plateOptions, lowBedTemp, numOrNull, BrimMode, LOW_BED_C } from "./settingsModel";
import { segmented, switchToggle, numberInput, errorSlot } from "./widgets";

type BrimChoice = "default" | BrimMode;

export interface SliceOverrides {
  /// The plate field (goes above the disclosure).
  plateEl: HTMLElement;
  /// The Overrides disclosure.
  el: HTMLElement;
  /// The slice form's printer changed ("" = none).
  setPrinter(id: string): void;
  /// Extra POST slice fields, or an error to show instead of slicing.
  body(): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string };
  /// The farm defaults, once loaded (arrange / orient defaults).
  farm(): Promise<FarmSettings | null>;
}

const BRIM_TYPE: Record<BrimMode, string> = { off: "no_brim", auto: "auto_brim", mm: "outer_only" };

function brimText(b: FarmSettings["brim"] | undefined): string {
  if (!b) return "";
  return b.mode === "off" ? "off" : b.mode === "auto" ? "auto" : `${b.width_mm} mm`;
}

export function sliceOverrides(printerId: string, onChange: () => void): SliceOverrides {
  let farm: FarmSettings | null = null;
  const farmP = loadFarmSettings()
    .then((f) => (farm = f))
    .catch(() => null);
  let plateTouched = false;
  let seq = 0;

  // ── plate ──
  const plate = select("pf-slice-plate", plateOptions().map((p) => ({ value: p, label: p })), "Textured PEI Plate", () => {
    plateTouched = true;
    plateHint.textContent = "Changed for this slice.";
    onChange();
  });
  const plateF = field("Plate type", plate, { forId: "pf-slice-plate", hint: "Loading the printer's plate…" });
  const plateHint = plateF.el.querySelector(".hint") as HTMLElement;
  const setPlate = (v: string, why: string) => {
    if (plateTouched) return;
    if (!Array.from(plate.options).some((o) => o.value === v)) plate.appendChild(h("option", { value: v, text: v }));
    plate.value = v;
    plateHint.textContent = why;
  };

  // ── brim ──
  const brimW = numberInput("pf-brim-w", { unit: "mm", min: 0.1, max: 50, step: "0.5", value: "5", label: "Brim width" });
  const brimErr = errorSlot();
  const brimSeg = segmented<BrimChoice>(
    "Brim",
    [
      { value: "default", label: "Default" },
      { value: "off", label: "Off" },
      { value: "auto", label: "Auto" },
      { value: "mm", label: "Width" },
    ],
    "default",
    () => {
      syncBrim();
      changed();
      if (brimSeg.value() === "mm") brimW.input.focus();
    },
  );
  const brimHint = h("span", { class: "hint" });
  const syncBrim = () => {
    const m = brimSeg.value();
    brimW.input.disabled = m !== "mm";
    brimHint.textContent = m === "default" ? (farm ? `Farm default: ${brimText(farm.brim)}.` : "Farm default.") : m === "auto" ? "OrcaSlicer adds a brim where a part needs one." : "";
  };
  brimW.input.addEventListener("input", changed);

  // ── bed temperature ──
  const bedFirst = numberInput("pf-bed-first", { unit: "°C", min: 0, max: 130, step: "1", placeholder: "Preset", label: "Bed temperature, first layer" });
  const bedOther = numberInput("pf-bed-other", { unit: "°C", min: 0, max: 130, step: "1", placeholder: "Preset", label: "Bed temperature, other layers" });
  const bedErr = errorSlot();
  const bedOn = switchToggle(
    "pf-bed-on",
    "Override the bed temperature",
    false,
    () => {
      bedFirst.input.disabled = bedOther.input.disabled = !bedOn.value();
      changed();
      if (bedOn.value()) bedFirst.input.focus();
    },
    "Only for this slice. Blank = the filament preset's value for the plate.",
  );
  bedFirst.input.disabled = bedOther.input.disabled = true;
  bedFirst.input.addEventListener("input", changed);
  bedOther.input.addEventListener("input", changed);

  const badge = h("span", { class: "badge ovn" });
  badge.hidden = true;
  const sum = h("summary", null, icon("down"), h("span", { text: "Overrides" }), badge, h("span", { class: "muted sumhint", text: "brim · bed temperature" }));
  const el = h(
    "details",
    { class: "ovr-disc" },
    sum,
    h(
      "div",
      { class: "stack" },
      h("div", { class: "f" }, h("span", { class: "flabel", id: "pf-brim-l", text: "Brim" }), h("div", { class: "row brim-row" }, brimSeg.el, h("div", { class: "brim-w" }, brimW.el)), brimHint, brimErr.el),
      bedOn.el,
      h("div", { class: "grid2" }, field("First layer", bedFirst.el, { forId: "pf-bed-first" }).el, field("Other layers", bedOther.el, { forId: "pf-bed-other" }).el),
      bedErr.el,
    ),
  );
  brimSeg.el.setAttribute("aria-labelledby", "pf-brim-l");

  function errors(): { brim: string | null; bed: string | null } {
    let brim: string | null = null;
    let bed: string | null = null;
    if (brimSeg.value() === "mm") {
      const w = numOrNull(brimW.input.value);
      if (w === null || !(w > 0 && w <= 50)) brim = "Brim width must be between 0.1 and 50 mm.";
    }
    if (bedOn.value()) {
      const a = numOrNull(bedFirst.input.value);
      const b = numOrNull(bedOther.input.value);
      const okT = (x: number | null) => x === null || (x >= 0 && x <= 130);
      if (!okT(a) || !okT(b)) bed = "Bed temperatures must be 0–130 °C.";
      else if (a === null && b === null) bed = "Enter a first-layer and/or other-layers temperature, or turn the override off.";
    }
    return { brim, bed };
  }

  function changed() {
    const e = errors();
    brimErr.set(e.brim);
    bedErr.set(e.bed);
    const n = (brimSeg.value() !== "default" ? 1 : 0) + (bedOn.value() ? 1 : 0);
    badge.hidden = !n;
    badge.textContent = n + " on";
    if (e.brim || e.bed) el.open = true;
    onChange();
  }

  async function setPrinter(id: string) {
    const my = ++seq;
    await farmP;
    syncBrim();
    if (my !== seq) return;
    if (!id) {
      if (farm) setPlate(farm.plate_type, "Farm default.");
      else plateHint.textContent = "";
      return;
    }
    try {
      const s = await get<PrinterSettings>(`printers/${encodeURIComponent(id)}/settings`);
      if (my !== seq) return;
      const eff = s.effective?.plate_type || s.plate_type || farm?.plate_type;
      if (eff) setPlate(eff, s.plate_type ? "Installed on this printer." : "Farm default (the printer has no plate set).");
    } catch (_e) {
      if (my !== seq) return;
      if (farm) setPlate(farm.plate_type, "Farm default.");
    }
  }
  setPrinter(printerId);
  syncBrim();

  return {
    plateEl: plateF.el,
    el,
    setPrinter,
    farm: () => farmP,
    body() {
      const e = errors();
      if (e.brim || e.bed) {
        el.open = true;
        return { ok: false, error: e.brim || e.bed! };
      }
      const fields: Record<string, unknown> = { bed_type: plate.value };
      const m = brimSeg.value();
      if (m !== "default") {
        const w = m === "mm" ? numOrNull(brimW.input.value)! : m === "auto" ? farm?.brim.width_mm ?? 5 : 0;
        fields.brim_width = w;
        fields.overrides = { brim_type: BRIM_TYPE[m], brim_width: String(w) };
      }
      if (bedOn.value()) fields.bed_temp = { first_layer: numOrNull(bedFirst.input.value), other_layers: numOrNull(bedOther.input.value) };
      return { ok: true, fields };
    },
  };
}

/// The `effective` block shown after a slice: what really reached the G-code.
export function effectiveBlock(e: SliceEffective): HTMLElement {
  const t = (v: number | null | undefined, u = "°C") => (v == null || !isFinite(v) ? "—" : `${Math.round(v * 10) / 10} ${u}`);
  const lowFirst = lowBedTemp(e.bed_type, e.bed_temp_first_layer);
  const lowOther = lowBedTemp(e.bed_type, e.bed_temp_other_layers);
  const tile = (k: string, v: string, low = false) =>
    h("div", { class: "tile" + (low ? " low" : "") }, h("div", { class: "k", text: k }), h("div", { class: "v", text: v }, low ? h("span", { class: "sr", text: " (unusually low)" }) : null));
  const wrap = h("div", { class: "eff", role: "group", "aria-label": "Effective slicing values" });
  if (lowFirst || lowOther) {
    const temp = lowFirst ? e.bed_temp_first_layer : e.bed_temp_other_layers;
    wrap.appendChild(
      h(
        "div",
        { class: "banner warn", role: "alert" },
        icon("warn"),
        h(
          "div",
          { class: "grow" },
          h("b", { text: `Bed only ${t(temp)} on a ${e.bed_type}` }),
          h("p", { text: `That's far below what this plate needs (≥ ${LOW_BED_C} °C) — parts may not stick. Check the filament preset's ${e.bed_type} temperature and any bed temperature override, then slice again.` }),
        ),
      ),
    );
  }
  wrap.append(
    h("p", { class: "subhead", text: "What the G-code uses" }),
    h(
      "div",
      { class: "est eff-tiles" },
      tile("Plate", e.bed_type || "—"),
      tile("Bed · first layer", t(e.bed_temp_first_layer), lowFirst),
      tile("Bed · other layers", t(e.bed_temp_other_layers), lowOther),
      tile("Nozzle · first layer", t(e.nozzle_temp_first_layer)),
      tile("Nozzle · other layers", t(e.nozzle_temp_other_layers)),
      tile("Brim", e.brim_width == null ? "—" : e.brim_width ? t(e.brim_width, "mm") : "Off"),
    ),
  );
  const presets = (
    [
      ["Printer", e.printer_preset],
      ["Process", e.process_preset],
      ["Filament", e.filament_preset],
    ] as [string, string | undefined][]
  ).filter(([, v]) => v);
  if (presets.length) wrap.appendChild(h("dl", { class: "kv" }, ...presets.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v! })])));
  return wrap;
}
