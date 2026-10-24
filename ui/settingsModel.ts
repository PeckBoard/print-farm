// Pure logic behind the Settings / printer settings / Profiles views (no
// DOM): types for the FARM_SETTINGS_API.md routes, plate + filament enums,
// HMS code validation, dirty-state diffing, and Orca preset value shapes.
// Unit-tested in test/ui-settings.test.ts.

// ── API types (FARM_SETTINGS_API.md) ─────────────────────────────────────────

export type BrimMode = "off" | "auto" | "mm";
export interface Brim {
  mode: BrimMode;
  width_mm: number;
}
export interface FarmSettings {
  plate_type: string;
  material: string;
  quality: string;
  brim: Brim;
  auto_arrange: boolean;
  auto_orient: boolean;
  bed_temp_override: { first_layer: number | null; other_layers: number | null };
  confirm_before_start: boolean;
  monitoring: { snapshot_interval_s: number; ignored_hms: string[]; auto_pause_on_failure: boolean };
}
export const FARM_DEFAULTS: FarmSettings = {
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

export interface PrinterSettings {
  plate_type: string | null;
  printer_preset: string | null;
  process_preset: string | null;
  filament_preset: string | null;
  nozzle_mm: number | null;
  capabilities?: { heaters?: boolean; camera?: boolean; gcode?: boolean };
  effective?: { plate_type?: string; printer_preset?: string; process_preset?: string; filament_preset?: string };
}

/// Orca preset kinds as the API names them; the UI labels them below.
export type Kind = "machine" | "filament" | "process";
export const KIND_LABEL: Record<Kind, string> = { machine: "Printer", filament: "Filament", process: "Process" };
/// The older `GET profiles?kind=` / profile picker name for `machine`.
export const LIST_KIND: Record<Kind, "printer" | "filament" | "process"> = { machine: "printer", filament: "filament", process: "process" };

export type OrcaValue = string | string[];
export interface Profile {
  kind: Kind;
  name: string;
  vendor: string;
  user: boolean;
  inherits: string | null;
  own: Record<string, OrcaValue>;
  /// Every key after the inherits chain (null on the wire when it can't resolve).
  resolved: Record<string, OrcaValue>;
  resolve_error?: string;
  path?: string;
}
export interface ProfileListItem {
  name: string;
  vendor: string;
  user?: boolean;
  inherits?: string | null;
  instantiable?: boolean;
  filament_type?: string;
}
export interface FieldDef {
  key: string;
  label: string;
  group?: string;
  type: "int" | "float" | "percent" | "bool" | "enum";
  unit?: string;
  min?: number;
  max?: number;
  per_extruder?: boolean;
  options?: { value: string; label: string }[];
}

/// GET slice/:job → `effective`.
export interface SliceEffective {
  bed_type?: string;
  bed_temp_first_layer?: number | null;
  bed_temp_other_layers?: number | null;
  nozzle_temp_first_layer?: number | null;
  nozzle_temp_other_layers?: number | null;
  brim_width?: number | null;
  printer_preset?: string;
  process_preset?: string;
  filament_preset?: string;
}

// ── plates ──────────────────────────────────────────────────────────────────

export const PLATE_TYPES = ["Textured PEI Plate", "Cool Plate", "Engineering Plate", "High Temp Plate"];
/// Plates only some Orca versions know; offered when a value already uses one.
export const EXTRA_PLATES = ["Supertack Plate", "Textured Cool Plate"];

/// Plate dropdown values: the four standard plates plus any extra plate the
/// current value(s) already use.
export function plateOptions(...current: (string | null | undefined)[]): string[] {
  const out = PLATE_TYPES.slice();
  for (const c of current) if (c && out.indexOf(c) < 0) out.push(c);
  return out;
}

/// The filament preset keys holding a plate's bed temperature.
export const PLATE_TEMP_KEY: Record<string, string> = {
  "Cool Plate": "cool_plate_temp",
  "Engineering Plate": "eng_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Textured PEI Plate": "textured_plate_temp",
  "Supertack Plate": "supertack_plate_temp",
  "Textured Cool Plate": "textured_cool_plate_temp",
};

/// Plates that need a hot bed: a first/other-layer temp below this on one is
/// almost always a wrong preset (a 35 °C PEI bed = parts that won't stick).
export const HOT_PLATES = ["Textured PEI Plate", "Engineering Plate", "High Temp Plate"];
export const LOW_BED_C = 45;

export function lowBedTemp(plate: string | null | undefined, temp: number | null | undefined): boolean {
  return !!plate && HOT_PLATES.indexOf(plate) >= 0 && temp != null && isFinite(temp) && temp > 0 && temp < LOW_BED_C;
}

// ── materials ───────────────────────────────────────────────────────────────

/// Orca's filament_type values, most common first (fallback when the profile
/// list doesn't carry `filament_type`).
export const FILAMENT_TYPES = [
  "PLA", "PETG", "ABS", "ASA", "TPU", "PC", "PA", "PCTG", "PVA", "HIPS",
  "PLA-CF", "PETG-CF", "PET-CF", "PA-CF", "PA6-CF", "PA-GF", "ASA-CF", "ABS-GF",
  "PLA-AERO", "ASA-AERO", "PP", "PP-CF", "PP-GF", "PPS", "PPS-CF", "PPA-CF", "PPA-GF",
  "PE", "PE-CF", "PHA", "EVA", "SBS", "BVOH",
];

/// Material dropdown: the types the profile list exposes (in canonical order,
/// unknown ones after), else the canonical list; the current value always.
export function materialOptions(listed: (string | undefined)[], current?: string): string[] {
  const seen = new Set(listed.filter(Boolean).map((t) => t!.trim().toUpperCase()));
  let out = seen.size ? FILAMENT_TYPES.filter((t) => seen.has(t)) : FILAMENT_TYPES.slice();
  if (seen.size) for (const t of [...seen].sort()) if (out.indexOf(t) < 0) out.push(t);
  if (current && out.indexOf(current) < 0) out = [current].concat(out);
  return out;
}

/// "0.20mm Standard @BBL X1C" → "0.20mm Standard" (quality names shared
/// across printers).
export function qualityName(preset: string): string {
  const i = preset.indexOf(" @");
  return (i > 0 ? preset.slice(0, i) : preset).trim();
}

/// Distinct quality names, sorted by layer height then name.
export function qualityOptions(presets: string[], current?: string): string[] {
  const set = new Set(presets.map(qualityName).filter(Boolean));
  if (current) set.add(current);
  const lh = (s: string) => {
    const m = /^(\d+(?:\.\d+)?)\s*mm/.exec(s);
    return m ? Number(m[1]) : 99;
  };
  return [...set].sort((a, b) => lh(a) - lh(b) || a.localeCompare(b));
}

// ── HMS codes ───────────────────────────────────────────────────────────────

/// Normalise a typed Bambu HMS code to XXXX_XXXX_XXXX_XXXX (upper-case hex).
/// Accepts `_`, `-`, spaces or no separators. null = not a valid code.
export function normalizeHms(raw: string): string | null {
  const hex = raw.trim().toUpperCase().replace(/^HMS[_-]?/, "").replace(/[\s_-]/g, "");
  if (!/^[0-9A-F]{16}$/.test(hex)) return null;
  return hex.match(/.{4}/g)!.join("_");
}

/// Why an HMS code can't be added, or null.
export function hmsError(raw: string, existing: string[]): string | null {
  if (!raw.trim()) return "Enter an HMS code.";
  const n = normalizeHms(raw);
  if (!n) return "Use the format XXXX_XXXX_XXXX_XXXX (16 hex digits, e.g. 0300_3100_0001_0001).";
  if (existing.indexOf(n) >= 0) return `${n} is already ignored.`;
  return null;
}

// ── dirty state ─────────────────────────────────────────────────────────────

/// Structural equality for JSON-shaped values (key order ignored).
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as any)[k], (b as any)[k]));
}

/// The top-level keys of `draft` that differ from `saved` (the partial body a
/// PUT needs). Nested objects are sent whole.
export function diffTop<T extends object>(saved: T, draft: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(draft) as (keyof T)[]) if (!deepEqual(saved[k], draft[k])) out[k] = draft[k];
  return out;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/// A FarmSettings from a (possibly partial / older) server answer.
export function withFarmDefaults(s: Partial<FarmSettings> | null | undefined): FarmSettings {
  const d = clone(FARM_DEFAULTS);
  if (!s) return d;
  return {
    ...d,
    ...s,
    brim: { ...d.brim, ...(s.brim || {}) },
    bed_temp_override: { ...d.bed_temp_override, ...(s.bed_temp_override || {}) },
    monitoring: { ...d.monitoring, ...(s.monitoring || {}), ignored_hms: (s.monitoring?.ignored_hms || d.monitoring.ignored_hms).slice() },
  };
}

/// Field-level problems in a farm settings draft (keys = API field paths).
export function validateFarm(s: FarmSettings): Record<string, string> {
  const e: Record<string, string> = {};
  if (!s.plate_type) e.plate_type = "Pick a plate type.";
  if (!s.material) e.material = "Pick a default material.";
  if (!s.quality) e.quality = "Pick a default quality.";
  if (s.brim.mode === "mm" && !(isFinite(s.brim.width_mm) && s.brim.width_mm > 0 && s.brim.width_mm <= 50)) e["brim.width_mm"] = "Brim width must be between 0.1 and 50 mm.";
  const bt = (v: number | null) => v === null || (isFinite(v) && v >= 0 && v <= 130);
  if (!bt(s.bed_temp_override.first_layer)) e["bed_temp_override.first_layer"] = "0–130 °C.";
  if (!bt(s.bed_temp_override.other_layers)) e["bed_temp_override.other_layers"] = "0–130 °C.";
  return e;
}

/// A number input's text → number | null (blank) | NaN (garbage).
export function numOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return isFinite(n) ? n : NaN;
}

// ── Orca preset values ──────────────────────────────────────────────────────

/// One field's scalar text from Orca's on-disk shape (arrays → first entry).
export function scalar(v: OrcaValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v.length ? String(v[0]) : undefined) : String(v);
}

/// Text from a typed control → Orca's on-disk shape. Per-extruder keys (and
/// keys whose current value is an array) stay arrays of the same length.
export function toOrca(f: FieldDef, text: string, current: OrcaValue | undefined): OrcaValue {
  let s = text.trim();
  if (f.type === "percent" && s && !s.endsWith("%")) s += "%";
  if (Array.isArray(current)) return current.length > 1 ? current.map(() => s) : [s];
  return f.per_extruder ? [s] : s;
}

/// Orca value → the control's text (percent without "%", bool as "1"/"0").
export function fromOrca(f: FieldDef, v: OrcaValue | undefined): string {
  const s = scalar(v) ?? "";
  if (f.type === "percent") return s.replace(/%$/, "");
  if (f.type === "bool") return s === "1" || s.toLowerCase() === "true" ? "1" : "0";
  return s;
}

/// Why a typed field's text is invalid, or null.
export function fieldError(f: FieldDef, text: string): string | null {
  if (f.type === "bool") return null;
  if (f.type === "enum") return !f.options || f.options.some((o) => o.value === text) ? null : "Pick one of the options.";
  const t = text.trim().replace(/%$/, "");
  if (!t) return "Enter a value.";
  const n = Number(t);
  if (!isFinite(n)) return "Enter a number.";
  if (f.type === "int" && !Number.isInteger(n)) return "Whole numbers only.";
  const u = f.type === "percent" ? "%" : f.unit ? " " + f.unit : "";
  if (f.min != null && n < f.min) return `At least ${f.min}${u}.`;
  if (f.max != null && n > f.max) return `At most ${f.max}${u}.`;
  return null;
}

/// Parse the Advanced JSON editor: an object whose values are strings or
/// arrays of strings (Orca's shapes). Returns the object or an error.
export function parseOwnJson(text: string): { own: Record<string, OrcaValue> } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: "Not valid JSON: " + (e as Error).message };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "Must be a JSON object of preset keys, e.g. {\"layer_height\": \"0.2\"}." };
  for (const [k, x] of Object.entries(v as object)) {
    if (["name", "inherits", "from", "type", "version", "instantiation"].indexOf(k) >= 0) return { error: `"${k}" is managed by Print Farm — remove it here.` };
    const ok = typeof x === "string" || (Array.isArray(x) && x.every((y) => typeof y === "string"));
    if (!ok) return { error: `"${k}" must be a string or an array of strings (Orca stores every value as text).` };
  }
  return { own: v as Record<string, OrcaValue> };
}

/// Why a preset name can't be used, or null. `taken` = names already used in
/// that kind (User presets).
export function presetNameError(name: string, taken: string[], current?: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > 120) return "Keep it under 120 characters.";
  if (/[\\/:*?"<>|]/.test(n)) return 'Names can\'t contain \\ / : * ? " < > |';
  if (n !== current && taken.some((t) => t.toLowerCase() === n.toLowerCase())) return "A User preset with this name already exists.";
  return null;
}
