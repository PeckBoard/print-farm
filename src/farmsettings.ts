// Farm-wide slicing/monitoring defaults (data_store "farm_settings"/"farm")
// and the per-printer settings stored on the printer record. Contract:
// FARM_SETTINGS_API.md. Every slicing value resolves call argument →
// printer settings → farm settings → the Orca preset (resolveSlice).

import { storeGet, storePut } from "./host";
import { fieldError } from "./apierror";
import { Capabilities, PrinterDetail, PrinterRecord } from "./drivers/types";

/// Orca `curr_bed_type` values. Orca 2.x knows all six.
export const PLATE_TYPES = [
  "Cool Plate",
  "Engineering Plate",
  "High Temp Plate",
  "Textured PEI Plate",
  "Supertack Plate",
  "Textured Cool Plate",
] as const;

/// The filament preset's bed temperature key for each plate (`<key>` = other
/// layers, `<key>_initial_layer` = first layer).
export const PLATE_TEMP_KEY: Record<string, string> = {
  "Cool Plate": "cool_plate_temp",
  "Engineering Plate": "eng_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Textured PEI Plate": "textured_plate_temp",
  "Supertack Plate": "supertack_plate_temp",
  "Textured Cool Plate": "textured_cool_plate_temp",
};

export const NOZZLES = [0.2, 0.4, 0.6, 0.8];

export type BrimMode = "off" | "auto" | "mm";

export interface FarmSettings {
  plate_type: string;
  material: string;
  quality: string;
  brim: { mode: BrimMode; width_mm: number };
  auto_arrange: boolean;
  auto_orient: boolean;
  bed_temp_override: { first_layer: number | null; other_layers: number | null };
  confirm_before_start: boolean;
  monitoring: { snapshot_interval_s: number; ignored_hms: string[]; auto_pause_on_failure: boolean };
}

export function defaultFarmSettings(): FarmSettings {
  return {
    plate_type: "Textured PEI Plate",
    material: "PLA",
    quality: "0.20mm Standard",
    brim: { mode: "auto", width_mm: 5 },
    auto_arrange: true,
    auto_orient: false,
    bed_temp_override: { first_layer: null, other_layers: null },
    confirm_before_start: true,
    monitoring: { snapshot_interval_s: 60, ignored_hms: ["0300_3100_0001_0001"], auto_pause_on_failure: false },
  };
}

// ── validation (pure) ───────────────────────────────────────────────────────

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fieldError(field, `${field} must be an object`);
  return v as Record<string, unknown>;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw fieldError(field, `${field} must be true or false`);
  return v;
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw fieldError(field, `${field} must be a non-empty string`);
  if (v.trim().length > max) throw fieldError(field, `${field} is too long`);
  return v.trim();
}

function numIn(v: unknown, field: string, min: number, max: number, integer = false): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw fieldError(field, `${field} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return n;
}

export function plateType(v: unknown, field: string): string {
  if (typeof v !== "string" || !(PLATE_TYPES as readonly string[]).includes(v)) {
    throw fieldError(field, `${field} must be one of ${PLATE_TYPES.join(", ")}`);
  }
  return v;
}

/// A bed temperature (°C) or null = use the filament preset.
function bedTemp(v: unknown, field: string): number | null {
  return v === null ? null : numIn(v, field, 0, 130, true);
}

/// Apply a partial update to farm settings; throws 400 `{field}`. Pure — tested.
export function mergeFarmSettings(current: FarmSettings, patchIn: unknown): FarmSettings {
  const patch = obj(patchIn ?? {}, "body");
  const next: FarmSettings = JSON.parse(JSON.stringify(current));
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "plate_type":
        next.plate_type = plateType(v, k);
        break;
      case "material":
        next.material = text(v, k, 64);
        break;
      case "quality":
        next.quality = text(v, k, 128);
        break;
      case "brim": {
        const b = obj(v, k);
        for (const [bk, bv] of Object.entries(b)) {
          if (bk === "mode") {
            if (bv !== "off" && bv !== "auto" && bv !== "mm") throw fieldError("brim.mode", "brim.mode must be off, auto or mm");
            next.brim.mode = bv;
          } else if (bk === "width_mm") next.brim.width_mm = numIn(bv, "brim.width_mm", 0, 50);
          else throw fieldError(`brim.${bk}`, `unknown setting brim.${bk}`);
        }
        break;
      }
      case "auto_arrange":
      case "auto_orient":
      case "confirm_before_start":
        next[k] = bool(v, k);
        break;
      case "bed_temp_override": {
        const b = obj(v, k);
        for (const [bk, bv] of Object.entries(b)) {
          if (bk !== "first_layer" && bk !== "other_layers") throw fieldError(`${k}.${bk}`, `unknown setting ${k}.${bk}`);
          next.bed_temp_override[bk] = bedTemp(bv, `${k}.${bk}`);
        }
        break;
      }
      case "monitoring": {
        const m = obj(v, k);
        for (const [mk, mv] of Object.entries(m)) {
          if (mk === "snapshot_interval_s") next.monitoring.snapshot_interval_s = numIn(mv, "monitoring.snapshot_interval_s", 5, 86400, true);
          else if (mk === "auto_pause_on_failure") next.monitoring.auto_pause_on_failure = bool(mv, "monitoring.auto_pause_on_failure");
          else if (mk === "ignored_hms") {
            if (!Array.isArray(mv)) throw fieldError("monitoring.ignored_hms", "monitoring.ignored_hms must be a list of HMS codes");
            const codes = mv.map((c) => (typeof c === "string" ? c.trim().toUpperCase() : ""));
            if (codes.some((c) => !/^[0-9A-F]{4}(?:[_-]?[0-9A-F]{4}){1,3}$/.test(c))) {
              throw fieldError("monitoring.ignored_hms", "HMS codes look like 0300_3100_0001_0001");
            }
            next.monitoring.ignored_hms = [...new Set(codes)];
          } else throw fieldError(`monitoring.${mk}`, `unknown setting monitoring.${mk}`);
        }
        break;
      }
      default:
        throw fieldError(k, `unknown setting ${k}`);
    }
  }
  return next;
}

// ── store ───────────────────────────────────────────────────────────────────

const FARM = "farm_settings";
const FARM_KEY = "farm";

/// Stored settings over the defaults (a stored doc from an older version may
/// lack newer keys).
export function getFarmSettings(): FarmSettings {
  const stored = storeGet(FARM, FARM_KEY);
  const d = defaultFarmSettings();
  if (!stored || typeof stored !== "object") return d;
  try {
    return mergeFarmSettings(d, stored);
  } catch (_e) {
    return d;
  }
}

export function setFarmSettings(patch: unknown): FarmSettings {
  const next = mergeFarmSettings(getFarmSettings(), patch);
  storePut(FARM, FARM_KEY, next);
  return next;
}

// ── per-printer settings ────────────────────────────────────────────────────

export interface PrinterSettingsView {
  plate_type: string | null;
  printer_preset: string | null;
  process_preset: string | null;
  filament_preset: string | null;
  nozzle_mm: number | null;
  capabilities: { heaters: boolean; camera: boolean; gcode: boolean };
  effective: { plate_type: string; printer_preset: string | null; process_preset: string | null; filament_preset: string | null };
}

const PRESET_FIELDS = {
  printer_preset: "orca_printer_profile",
  process_preset: "orca_process_profile",
  filament_preset: "orca_filament_profile",
} as const;

/// Apply a partial PrinterSettings update to a record. Presets live in the
/// record's existing `orca_*_profile` fields; `capabilities` / `effective`
/// are read-only and ignored. Pure — tested.
export function applyPrinterSettings(p: PrinterRecord, patchIn: unknown): PrinterRecord {
  const patch = obj(patchIn ?? {}, "body");
  const next: PrinterRecord = { ...p, settings: { ...(p.settings ?? {}) } };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "capabilities" || k === "effective") continue;
    if (k === "plate_type") {
      if (v === null) delete next.settings!.plate_type;
      else next.settings!.plate_type = plateType(v, k);
    } else if (k === "nozzle_mm") {
      if (v === null) delete next.settings!.nozzle_mm;
      else {
        const n = Number(v);
        if (!NOZZLES.includes(n)) throw fieldError(k, `nozzle_mm must be one of ${NOZZLES.join(", ")}`);
        next.settings!.nozzle_mm = n;
      }
    } else if (k in PRESET_FIELDS) {
      const field = PRESET_FIELDS[k as keyof typeof PRESET_FIELDS];
      if (v === null || v === "") delete next[field];
      else next[field] = text(v, k, 256);
    } else {
      throw fieldError(k, `unknown printer setting ${k}`);
    }
  }
  if (!Object.keys(next.settings!).length) delete next.settings;
  return next;
}

/// Swap the nozzle in an Orca machine preset name (`… 0.4 nozzle` → `… 0.6
/// nozzle`); names without a nozzle size are left alone. Pure.
export function withNozzle(machine: string, nozzle: number | undefined): string {
  if (!machine || !nozzle) return machine;
  return machine.replace(/\b\d\.\d+ nozzle\b/, `${nozzle} nozzle`);
}

function nozzleOf(machine: string | undefined): number | null {
  const m = /\b(\d\.\d+) nozzle\b/.exec(machine ?? "");
  return m ? Number(m[1]) : null;
}

/// The page's view of a printer's settings. Pure — tested.
export function printerSettingsView(p: PrinterRecord, farm: FarmSettings, caps: Capabilities): PrinterSettingsView {
  const machine = p.orca_printer_profile ?? null;
  return {
    plate_type: p.settings?.plate_type ?? null,
    printer_preset: machine,
    process_preset: p.orca_process_profile ?? null,
    filament_preset: p.orca_filament_profile ?? null,
    nozzle_mm: p.settings?.nozzle_mm ?? nozzleOf(machine ?? undefined),
    capabilities: {
      heaters: !!(caps.temps.nozzle || caps.temps.bed || caps.temps.chamber),
      camera: caps.camera,
      gcode: caps.gcode,
    },
    effective: {
      plate_type: p.settings?.plate_type ?? farm.plate_type,
      printer_preset: machine ? withNozzle(machine, p.settings?.nozzle_mm) : null,
      process_preset: p.orca_process_profile ?? null,
      filament_preset: p.orca_filament_profile ?? null,
    },
  };
}

// ── slice resolution ────────────────────────────────────────────────────────

export interface SliceOptions {
  bed_type?: unknown;
  brim_width?: unknown;
  bed_temp?: unknown;
  overrides?: unknown;
  arrange?: unknown;
  orient?: unknown;
}

export type PresetValue = string | string[];

export interface ResolvedSlice {
  bed_type: string;
  /// null = keep the process preset's brim.
  brim: { type: string; width: number } | null;
  bed_temp: { first_layer: number | null; other_layers: number | null };
  arrange: boolean;
  orient: boolean;
  overrides: Record<string, PresetValue>;
}

/// An Orca preset value from a JSON override: strings stay, numbers become
/// strings, booleans "1"/"0", lists of those become string lists.
export function presetValue(v: unknown, field: string): PresetValue {
  const one = (x: unknown): string => {
    if (typeof x === "string") return x;
    if (typeof x === "number" && isFinite(x)) return String(x);
    if (typeof x === "boolean") return x ? "1" : "0";
    throw fieldError(field, `${field} must be a string, number, boolean or a list of them`);
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

/// Resolve every slicing value: call argument → printer → farm (the preset
/// is whatever's left untouched). Pure — tested.
export function resolveSlice(call: SliceOptions, printer: PrinterRecord | null, farm: FarmSettings): ResolvedSlice {
  const bed_type =
    call.bed_type !== undefined && call.bed_type !== null && call.bed_type !== ""
      ? plateType(call.bed_type, "bed_type")
      : printer?.settings?.plate_type ?? farm.plate_type;

  let brim: ResolvedSlice["brim"];
  if (call.brim_width !== undefined && call.brim_width !== null) {
    const w = numIn(call.brim_width, "brim_width", 0, 50);
    brim = w === 0 ? { type: "no_brim", width: 0 } : { type: "outer_only", width: w };
  } else if (farm.brim.mode === "off") brim = { type: "no_brim", width: 0 };
  else if (farm.brim.mode === "auto") brim = { type: "auto_brim", width: farm.brim.width_mm };
  else brim = { type: "outer_only", width: farm.brim.width_mm };

  const bt = call.bed_temp === undefined || call.bed_temp === null ? {} : obj(call.bed_temp, "bed_temp");
  const pick = (k: "first_layer" | "other_layers") =>
    bt[k] !== undefined && bt[k] !== null ? bedTemp(bt[k], `bed_temp.${k}`) : farm.bed_temp_override[k];

  const overrides: Record<string, PresetValue> = {};
  if (call.overrides !== undefined && call.overrides !== null) {
    for (const [k, v] of Object.entries(obj(call.overrides, "overrides"))) {
      if (!/^[a-z0-9_]+$/.test(k)) throw fieldError("overrides", `override key '${k}' is not an Orca setting name`);
      if (k === "name" || k === "inherits" || k === "from") throw fieldError("overrides", `'${k}' can't be overridden`);
      overrides[k] = presetValue(v, `overrides.${k}`);
    }
  }

  return {
    bed_type,
    brim,
    bed_temp: { first_layer: pick("first_layer"), other_layers: pick("other_layers") },
    arrange: typeof call.arrange === "boolean" ? call.arrange : farm.auto_arrange,
    orient: typeof call.orient === "boolean" ? call.orient : farm.auto_orient,
    overrides,
  };
}

/// Farm fallback presets when neither the call nor the printer names one:
/// the machine's default process with the farm `quality` swapped in
/// (`0.20mm Standard @BBL X1C` → `0.16mm Optimal @BBL X1C`), and filament
/// candidates for the farm `material` (the machine default first when it is
/// that material). The caller takes the first candidate that resolves. Pure.
export function farmPresetCandidates(
  defaults: { process: string; filament: string },
  farm: Pick<FarmSettings, "quality" | "material">,
): { process: string[]; filament: string[] } {
  const procSuffix = /(\s@.*)$/.exec(defaults.process)?.[1] ?? "";
  const process = [farm.quality ? farm.quality + procSuffix : "", defaults.process].filter(Boolean);
  const filSuffix = /(\s@.*)$/.exec(defaults.filament)?.[1] ?? "";
  const mat = farm.material.trim();
  const matches = mat && new RegExp(`\\b${mat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(defaults.filament);
  const filament = matches || !mat
    ? [defaults.filament]
    : [`Generic ${mat}${filSuffix}`, `Generic ${mat}`, defaults.filament];
  return { process: [...new Set(process)], filament: [...new Set(filament.filter(Boolean))] };
}

// ── HMS filtering ───────────────────────────────────────────────────────────

/// Canonical HMS code: hex digits only, upper case.
function hmsKey(code: string): string {
  return code.toUpperCase().replace(/^HMS[_-]?/, "").replace(/[^0-9A-F]/g, "");
}

/// Drop errors whose code is on the ignore list. Pure — tested.
export function withoutIgnoredHms<T extends Pick<PrinterDetail, "errors">>(d: T, ignored: string[]): T {
  if (!ignored.length || !d.errors.length) return d;
  const skip = new Set(ignored.map(hmsKey));
  return { ...d, errors: d.errors.filter((e) => !skip.has(hmsKey(e.code))) };
}
