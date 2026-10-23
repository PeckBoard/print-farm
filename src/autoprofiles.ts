// Automatic default slicing profiles. A printer saved without defaults gets
// them picked: Bambu printers map their model (or the serial's model prefix)
// to `Bambu Lab <model> 0.4 nozzle`; other printers are matched by name
// against the vendors' machine presets. The machine preset's own
// `default_print_profile` / `default_filament_profile` (resolved through
// `inherits`) supply the process and filament. Users can still override.

import { storeGet, storePut } from "./host";
import { PrinterRecord } from "./drivers/types";
import { detectRoots, scanProfiles, resolveProfile, listMachineFiles, rootsSig } from "./profiles";

export interface Defaults {
  orca_printer_profile: string;
  orca_filament_profile: string;
  orca_process_profile: string;
}

// ── pure ────────────────────────────────────────────────────────────────────

/// Bambu model aliases → the model part of Orca's machine preset name.
const BAMBU_MODELS: Record<string, string> = {
  x1c: "X1 Carbon",
  "x1 carbon": "X1 Carbon",
  x1: "X1",
  x1e: "X1E",
  p1s: "P1S",
  p1p: "P1P",
  p2s: "P2S",
  a1: "A1",
  "a1 mini": "A1 mini",
  a1m: "A1 mini",
  a1mini: "A1 mini",
  h2d: "H2D",
  h2s: "H2S",
};

/// Serial-number prefixes → model (Bambu encodes the model in the first 3).
const BAMBU_SERIAL_PREFIX: Record<string, string> = {
  "00M": "X1C",
  "00W": "X1",
  "03W": "X1E",
  "01S": "P1P",
  "01P": "P1S",
  "030": "A1 mini",
  "039": "A1",
  "094": "H2D",
};

/// The Orca machine preset for a Bambu printer, or null when the model is
/// unknown. `model` wins; otherwise the serial prefix decides. Pure — tested.
export function bambuMachineName(model: string | undefined, serial: string | undefined): string | null {
  let m = String(model ?? "").trim().replace(/^bambu\s*lab\s*/i, "").toLowerCase().replace(/\s+/g, " ");
  if (!m && serial) m = (BAMBU_SERIAL_PREFIX[serial.trim().slice(0, 3).toUpperCase()] ?? "").toLowerCase();
  const name = BAMBU_MODELS[m];
  return name ? `Bambu Lab ${name} 0.4 nozzle` : null;
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/// Best-effort match of a printer's name against vendor machine presets
/// (0.4 nozzle variants only): the preset's model — with or without its
/// vendor word — must appear in the name; the longest match wins. Pure — tested.
export function matchMachine(printerName: string, machines: { vendor: string; name: string }[]): { vendor: string; name: string } | null {
  const target = compact(printerName);
  if (!target) return null;
  let best: { vendor: string; name: string; len: number } | null = null;
  for (const m of machines) {
    const mm = /^(.*\S)\s+0\.4 nozzle$/i.exec(m.name);
    if (!mm) continue;
    const model = mm[1];
    const words = model.split(/\s+/);
    const keys = [compact(model)];
    if (words.length > 1) keys.push(compact(words.slice(1).join(" ")));
    for (const k of keys) {
      if (k.length >= 4 && target.includes(k) && (!best || k.length > best.len)) best = { vendor: m.vendor, name: m.name, len: k.length };
    }
  }
  return best ? { vendor: best.vendor, name: best.name } : null;
}

/// Pull the defaults a machine preset names. Filament defaults are a list
/// (or a `;`-joined string); the first entry wins. Pure — tested.
export function presetDefaults(machine: Record<string, unknown>): { process: string; filament: string } {
  const proc = typeof machine.default_print_profile === "string" ? machine.default_print_profile.trim() : "";
  const f = machine.default_filament_profile;
  const list = Array.isArray(f) ? f.map(String) : typeof f === "string" ? f.split(";") : [];
  return { process: proc, filament: (list.find((x) => x.trim()) ?? "").trim() };
}

export function hasDefaults(p: PrinterRecord): boolean {
  return !!(p.orca_printer_profile || p.orca_filament_profile || p.orca_process_profile);
}

// ── host-backed ─────────────────────────────────────────────────────────────

/// Pick defaults for a printer from the installed presets, or null.
export function pickDefaults(p: PrinterRecord): Defaults | null {
  const roots = detectRoots();
  if (!roots.some((r) => r.kind === "system")) return null;
  let machine: { vendor: string; name: string } | null = null;
  if (p.type === "bambu") {
    const name = bambuMachineName(p.bambu?.model, p.bambu?.serial);
    if (name && scanProfiles(roots, "BBL", "printer").some((e) => e.name === name)) machine = { vendor: "BBL", name };
  } else {
    machine = matchMachine(p.name, listMachineFiles(roots));
  }
  if (!machine) return null;
  try {
    const flat = resolveProfile(machine.name, "printer", machine.vendor).profile;
    const d = presetDefaults(flat);
    if (!d.process || !d.filament) return null;
    return { orca_printer_profile: machine.name, orca_filament_profile: d.filament, orca_process_profile: d.process };
  } catch (_e) {
    return null;
  }
}

const TRIED = "auto_profiles";

/// What an attempt depended on: retry only when one of these changes.
function attemptSig(p: PrinterRecord): string {
  return [rootsSig(detectRoots()), p.type, p.name, p.bambu?.model ?? "", p.bambu?.serial ?? ""].join("|");
}

/// Fill in defaults for a printer that has none. With `force` (a save),
/// always try; otherwise (listing) only when the inputs changed since the
/// last attempt. Returns the updated record, or null when nothing changed.
export function autoFill(p: PrinterRecord, force: boolean): PrinterRecord | null {
  if (hasDefaults(p)) return null;
  try {
    const sig = attemptSig(p);
    if (!force && storeGet(TRIED, p.id)?.sig === sig) return null;
    storePut(TRIED, p.id, { sig });
    const d = pickDefaults(p);
    return d ? { ...p, ...d } : null;
  } catch (_e) {
    return null; // best effort: a broken profile tree just leaves them unset
  }
}
