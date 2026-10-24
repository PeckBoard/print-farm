// Parse the estimates OrcaSlicer (and PrusaSlicer/SuperSlicer/Cura) write as
// G-code comments in the header block and the footer. Pure — tested.

export interface GcodeEstimate {
  print_time_s: number | null;
  filament_mm: number | null;
  filament_g: number | null;
  filament_cm3: number | null;
  filament_cost: number | null;
  layers: number | null;
}

/// "1d 2h 3m 4s" / "2h 05m" / "45m 12s" / "37s" → seconds.
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  let total = 0;
  let any = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    any = true;
    const v = Number(m[1]);
    const unit = m[2].toLowerCase();
    total += unit === "d" ? v * 86400 : unit === "h" ? v * 3600 : unit === "m" ? v * 60 : v;
  }
  return any ? Math.round(total) : null;
}

/// Sum a possibly per-extruder, comma-separated list ("12.3, 4.5").
function sumList(s: string): number | null {
  const parts = s
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => isFinite(n));
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

export function parseGcodeEstimate(text: string): GcodeEstimate {
  const est: GcodeEstimate = {
    print_time_s: null,
    filament_mm: null,
    filament_g: null,
    filament_cm3: null,
    filament_cost: null,
    layers: null,
  };
  let totalTime: number | null = null;
  let normalTime: number | null = null;
  let cura: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(";")) continue;
    const body = line.replace(/^;+\s*/, "");
    let m: RegExpExecArray | null;
    // Orca/Bambu header: "model printing time: 41m 25s; total estimated time: 47m 34s"
    if ((m = /total estimated time:\s*([^;]+)/i.exec(body))) totalTime = parseDuration(m[1]) ?? totalTime;
    // Orca/Prusa footer: "estimated printing time (normal mode) = 1h 2m 3s"
    else if ((m = /^estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/i.exec(body))) normalTime = parseDuration(m[1]) ?? normalTime;
    else if ((m = /^TIME:\s*(\d+)/.exec(body))) cura = Number(m[1]);
    else if ((m = /^(?:total )?filament used \[mm\]\s*=\s*(.+)$/i.exec(body))) est.filament_mm = est.filament_mm ?? sumList(m[1]);
    else if ((m = /^total filament used \[g\]\s*=\s*(.+)$/i.exec(body))) est.filament_g = sumList(m[1]);
    else if ((m = /^filament used \[g\]\s*=\s*(.+)$/i.exec(body))) est.filament_g = est.filament_g ?? sumList(m[1]);
    else if ((m = /^filament used \[cm3\]\s*=\s*(.+)$/i.exec(body))) est.filament_cm3 = sumList(m[1]);
    else if ((m = /^(?:total )?filament cost\s*=\s*(.+)$/i.exec(body))) est.filament_cost = sumList(m[1]);
    else if ((m = /^Filament used:\s*([\d.]+)\s*m\b/i.exec(body))) est.filament_mm = est.filament_mm ?? Math.round(Number(m[1]) * 1000 * 100) / 100;
    else if ((m = /^total layers? (?:count|number)\s*[:=]\s*(\d+)/i.exec(body))) est.layers = Number(m[1]);
    else if ((m = /^LAYER_COUNT:\s*(\d+)/.exec(body))) est.layers = est.layers ?? Number(m[1]);
  }
  est.print_time_s = totalTime ?? normalTime ?? cura;
  return est;
}

// ── effective settings read back from the G-code ────────────────────────────

export interface EffectiveSettings {
  bed_type: string | null;
  bed_temp_first_layer: number | null;
  bed_temp_other_layers: number | null;
  nozzle_temp_first_layer: number | null;
  nozzle_temp_other_layers: number | null;
  brim_width: number | null;
  brim_type: string | null;
  printer_preset: string | null;
  process_preset: string | null;
  filament_preset: string | null;
}

/// Orca's bed temperature key per `curr_bed_type`.
const PLATE_KEY: Record<string, string> = {
  "Cool Plate": "cool_plate_temp",
  "Engineering Plate": "eng_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Textured PEI Plate": "textured_plate_temp",
  "Supertack Plate": "supertack_plate_temp",
  "Textured Cool Plate": "textured_cool_plate_temp",
};

/// The awk filter that cuts a (possibly 20+ MB) G-code down to what
/// parseEffective reads: heater commands up to the third layer change and
/// the config-block lines it needs.
export const EFFECTIVE_AWK =
  '/^;[ ]?(LAYER_CHANGE|CHANGE_LAYER)/ { n++; if (n <= 3) print; next } ' +
  '/^M1(04|09|40|90) / { if (n < 3) print; next } ' +
  '/^; (curr_bed_type|brim_width|brim_type|nozzle_temperature|nozzle_temperature_initial_layer|[a-z_]*plate_temp|[a-z_]*plate_temp_initial_layer|print_settings_id|filament_settings_id|printer_settings_id) = / { print }';

function firstNum(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v.split(/[,;]/)[0].trim().replace(/^"|"$/g, ""));
  return isFinite(n) && v.trim() !== "" ? n : null;
}

function unquote(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v
    .split(";")
    .map((p) => p.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .join("; ");
  return s || null;
}

/// What the slicer actually produced: bed/nozzle temperatures from the heater
/// commands before (first layer) and after (other layers) the first layer
/// change, falling back to the config block; plate, brim and preset names
/// from the config block. Pure — tested.
export function parseEffective(text: string): EffectiveSettings {
  const cfg: Record<string, string> = {};
  let layer = 0;
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (/^;\s?(LAYER_CHANGE|CHANGE_LAYER)\b/.test(line)) layer++;
    else if ((m = /^;\s*([a-z_]+)\s*=\s*(.*)$/.exec(line))) cfg[m[1]] = m[2];
    else if ((m = /^M(104|109|140|190)\b[^;]*?\bS(\d+(?:\.\d+)?)/.exec(line))) {
      const v = Number(m[2]);
      if (!(v > 0)) continue;
      if (layer === 0) before[m[1]] = v; // last one before the first layer wins
      else if (after[m[1]] === undefined && layer >= 2) after[m[1]] = v;
    }
  }
  const bedType = unquote(cfg.curr_bed_type);
  const key = bedType ? PLATE_KEY[bedType] : undefined;
  const cfgBedFirst = key ? firstNum(cfg[`${key}_initial_layer`]) : null;
  const cfgBedOther = key ? firstNum(cfg[key]) : null;
  const bedFirst = before["190"] ?? before["140"] ?? cfgBedFirst;
  const nozFirst = before["109"] ?? before["104"] ?? firstNum(cfg.nozzle_temperature_initial_layer);
  return {
    bed_type: bedType,
    bed_temp_first_layer: bedFirst,
    bed_temp_other_layers: after["140"] ?? after["190"] ?? cfgBedOther ?? bedFirst,
    nozzle_temp_first_layer: nozFirst,
    nozzle_temp_other_layers: after["104"] ?? after["109"] ?? firstNum(cfg.nozzle_temperature) ?? nozFirst,
    brim_width: firstNum(cfg.brim_width),
    brim_type: unquote(cfg.brim_type),
    printer_preset: unquote(cfg.printer_settings_id),
    process_preset: unquote(cfg.print_settings_id),
    filament_preset: unquote(cfg.filament_settings_id),
  };
}