// Which loaded spool each filament of a .gcode.3mf prints from (Bambu AMS).
// The matching itself is pure (ams.ts); this reads the file's filament list
// and the printer's loaded spools and turns the result into start options.

import { sh, FileRecord, putFile } from "./storage";
import { PrinterRecord, StartOptions } from "./drivers/types";
import { driverFor } from "./drivers";
import { defaultTransport } from "./transport";
import { bridgeConfig } from "./config";
import { parseSliceInfo, Filament, AmsState, SpoolMatch, autoMatch, explicitMatch, mappingFor, describeMatches, spoolLabel, EXTERNAL, amsRef } from "./ams";

/// argv: <file.gcode.3mf>. Prints Metadata/slice_info.config (nothing when absent).
export const READ_SLICE_INFO =
  'if command -v unzip >/dev/null 2>&1; then unzip -p \"$1\" Metadata/slice_info.config 2>/dev/null; ' +
  'elif command -v python3 >/dev/null 2>&1; then python3 -c \"import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(\'Metadata/slice_info.config\').decode(\'utf-8\', \'replace\'))\" \"$1\" 2>/dev/null; fi; true';

/// Filaments per plate from a .gcode.3mf's slice_info (empty when unreadable).
export function readFilaments(path: string): Record<string, Filament[]> {
  const out: Record<string, Filament[]> = {};
  try {
    for (const [plate, fil] of parseSliceInfo(sh(READ_SLICE_INFO, [path], 60))) {
      if (fil.length) out[String(plate)] = fil;
    }
  } catch (_e) {
    /* unreadable: no filament info */
  }
  return out;
}

/// The filaments plate `plate` uses: recorded at slice time, else read from
/// the file (and cached), else one filament of unknown type.
export function fileFilaments(f: FileRecord, plate: number): Filament[] {
  let by = f.filaments;
  if (!by || !Object.keys(by).length) {
    by = f.kind === "gcode.3mf" ? readFilaments(f.path) : {};
    if (Object.keys(by).length) putFile({ ...f, filaments: by });
  }
  const fil = by[String(plate)] ?? (Object.keys(by).length === 1 ? Object.values(by)[0] : undefined);
  return fil && fil.length ? fil : [{ id: 1, type: "", color: "" }];
}

export interface SpoolPlan {
  filaments: Filament[];
  ams: AmsState | null;
  matches: SpoolMatch[];
  use_ams: boolean;
  ams_mapping?: number[];
  /// One line per filament, for confirmations and the print record.
  summary: string;
  warnings: string[];
}

/// Plan the spools for printing `f` on `p`: `choices` ("ams:<slot>" /
/// "external" / "auto", one per used filament) or auto-match. Null for
/// non-Bambu printers and when the printer reports no AMS/external spool
/// and nothing was chosen (the start then keeps its plain options).
export function planSpools(p: PrinterRecord, f: FileRecord, plate: number, choices?: unknown[] | null): SpoolPlan | null {
  if (p.type !== "bambu") return null;
  const ams = driverFor(p, defaultTransport, bridgeConfig()).status().ams ?? null;
  if (!ams && !choices?.length) return null;
  const filaments = fileFilaments(f, plate);
  const loaded = ams ?? { trays: [], external: null };
  const matches = choices?.length ? explicitMatch(filaments, loaded, choices) : autoMatch(filaments, loaded);
  return {
    filaments,
    ams,
    matches,
    ...mappingFor(matches),
    summary: describeMatches(matches, ams),
    warnings: matches.flatMap((m) => (m.warning ? [m.warning] : [])),
  };
}

/// `options` with the planned spools applied (`use_ams` + `ams_mapping`).
export function withSpools(
  p: PrinterRecord,
  f: FileRecord,
  options: StartOptions | undefined,
  choices?: unknown[] | null,
): { options?: StartOptions; plan: SpoolPlan | null } {
  const plan = planSpools(p, f, Math.max(1, Number(options?.plate) || 1), choices);
  if (!plan) return { options, plan };
  const next: StartOptions = { ...(options ?? {}), use_ams: plan.use_ams };
  if (plan.ams_mapping) next.ams_mapping = plan.ams_mapping;
  else delete next.ams_mapping;
  return { options: next, plan };
}

/// The spool picker's options: every loaded AMS tray, then the external spool.
export function spoolChoices(ams: AmsState | null): { value: string; label: string; type: string; color: string | null }[] {
  const out = (ams?.trays ?? []).map((t) => ({ value: amsRef(t.slot), label: spoolLabel(amsRef(t.slot), ams), type: t.type, color: t.color }));
  out.push({ value: EXTERNAL, label: spoolLabel(EXTERNAL, ams), type: ams?.external?.type ?? "", color: ams?.external?.color ?? null });
  return out;
}
