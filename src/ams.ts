// AMS spool selection for Bambu printers. Pure — tested (test/ams.test.ts).
//
// A sliced .gcode.3mf names the filaments each plate uses
// (Metadata/slice_info.config: `<filament id type color used_g/>`); the
// print-bridge status lists what is loaded (`ams.trays[]` + the external
// `vt_tray` spool). Each used filament is matched to a loaded spool, and the
// choice becomes the `project_file` command's `use_ams` + `ams_mapping`
// (indexed by filament id - 1, value = global tray `unit * 4 + tray`, -1 for
// filaments the plate doesn't use).

export interface Filament {
  /// 1-based filament index in the project.
  id: number;
  type: string;
  /// `RRGGBB`, upper case; "" when unknown.
  color: string;
  used_g?: number;
}

export interface AmsTray {
  /// Global tray index (`unit * 4 + tray`).
  slot: number;
  unit: number;
  tray: number;
  type: string;
  color: string | null;
}

export interface AmsState {
  trays: AmsTray[];
  external: { type: string; color: string | null } | null;
  /// The spool feeding the toolhead now: a global slot, "external", or null
  /// (none / unknown). Bambu `ams.tray_now` (print-bridge >= 0.1.7).
  active?: number | "external" | null;
}

/// "ams:<slot>" or "external".
export type SpoolRef = string;

export interface SpoolMatch {
  filament: Filament;
  spool: SpoolRef;
  /// Set when the spool's type doesn't match the filament's.
  warning?: string;
}

/// `ams_mapping` value for the external spool in a mixed AMS + external
/// print (the `vt_tray` id).
export const EXTERNAL_TRAY_ID = 254;

/// `#ff9016`, `FF9016FF` → `FF9016`; anything else → "".
export function normColor(c: unknown): string {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(c ?? "").trim());
  return m ? m[1].toUpperCase() : "";
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
}

/// Filaments per plate index from Metadata/slice_info.config.
export function parseSliceInfo(xml: string): Map<number, Filament[]> {
  const out = new Map<number, Filament[]>();
  const plates = String(xml || "").split(/<plate\b[^>]*>/).slice(1);
  plates.forEach((body, i) => {
    const block = body.split(/<\/plate>/)[0];
    const idx = /<metadata\s+key="index"\s+value="(\d+)"/.exec(block);
    const plate = idx ? Number(idx[1]) : i + 1;
    const fil: Filament[] = [];
    for (const m of block.matchAll(/<filament\b[^>]*>/g)) {
      const id = Number(attr(m[0], "id"));
      if (!Number.isInteger(id) || id < 1) continue;
      const g = Number(attr(m[0], "used_g"));
      const f: Filament = { id, type: (attr(m[0], "type") ?? "").trim(), color: normColor(attr(m[0], "color")) };
      if (isFinite(g)) f.used_g = g;
      fil.push(f);
    }
    fil.sort((a, b) => a.id - b.id);
    out.set(plate, fil);
  });
  return out;
}

/// Coerce the bridge's `ams` status field (defensive: separate process).
export function coerceAms(v: any): AmsState | null {
  if (!v || typeof v !== "object") return null;
  const trays: AmsTray[] = [];
  for (const t of Array.isArray(v.trays) ? v.trays : []) {
    const slot = Number(t?.slot);
    if (!Number.isInteger(slot) || slot < 0 || typeof t?.type !== "string" || !t.type) continue;
    trays.push({
      slot,
      unit: Number.isInteger(t.unit) ? t.unit : Math.floor(slot / 4),
      tray: Number.isInteger(t.tray) ? t.tray : slot % 4,
      type: t.type,
      color: typeof t.color === "string" ? t.color : null,
    });
  }
  const e = v.external;
  const external = e && typeof e.type === "string" && e.type ? { type: e.type, color: typeof e.color === "string" ? e.color : null } : null;
  if (!trays.length && !external) return null;
  const active = v.active === "external" ? "external" : Number.isInteger(v.active) && v.active >= 0 ? (v.active as number) : null;
  return { trays, external, active };
}

/// `PLA`, `pla`, `PLA Basic` → `PLA`; `PLA-CF`, `PLA+` → `PLA` family.
function family(t: string): string {
  return t.trim().toUpperCase().split(/[\s\-+_/]/)[0];
}

/// 0 = same type, 1 = same family (PLA vs PLA-CF), 2 = different.
function typeScore(want: string, have: string): number {
  if (!want) return 2;
  if (want.trim().toUpperCase() === have.trim().toUpperCase()) return 0;
  return family(want) && family(want) === family(have) ? 1 : 2;
}

function colorDist(a: string, b: string | null): number {
  const x = normColor(a);
  const y = normColor(b);
  if (!x || !y) return 1e9;
  let d = 0;
  for (let i = 0; i < 6; i += 2) {
    const k = parseInt(x.slice(i, i + 2), 16) - parseInt(y.slice(i, i + 2), 16);
    d += k * k;
  }
  return d;
}

/// The external spool's ref.
export const EXTERNAL: SpoolRef = "external";

export function amsRef(slot: number): SpoolRef {
  return `ams:${slot}`;
}

/// Pick a loaded spool for one filament: an AMS tray of the same type
/// (nearest colour), else the external spool if its type matches, else the
/// same family (AMS first), else the first loaded tray / the external spool —
/// the last two with a warning.
export function matchFilament(f: Filament, ams: AmsState): SpoolMatch {
  const best = (score: number) =>
    ams.trays
      .filter((t) => typeScore(f.type, t.type) === score)
      .sort((a, b) => colorDist(f.color, a.color) - colorDist(f.color, b.color) || a.slot - b.slot)[0];
  const ext = ams.external;
  const exact = best(0);
  if (exact) return { filament: f, spool: amsRef(exact.slot) };
  if (ext && typeScore(f.type, ext.type) === 0) return { filament: f, spool: EXTERNAL };
  const near = best(1);
  if (near) return { filament: f, spool: amsRef(near.slot), warning: mismatch(f, near.type) };
  if (ext && typeScore(f.type, ext.type) === 1) return { filament: f, spool: EXTERNAL, warning: mismatch(f, ext.type) };
  // Unknown type: keep the pre-AMS behaviour (external spool) when there is one.
  if (!f.type && ext) return { filament: f, spool: EXTERNAL, warning: mismatch(f, ext.type) };
  const anyTray = best(2);
  if (anyTray) return { filament: f, spool: amsRef(anyTray.slot), warning: mismatch(f, anyTray.type) };
  return { filament: f, spool: EXTERNAL, warning: mismatch(f, ext?.type ?? "nothing") };
}

function mismatch(f: Filament, have: string): string {
  return f.type ? `filament ${f.id} is ${f.type} but the spool holds ${have}` : `filament ${f.id}'s type is unknown`;
}

/// Auto-match every used filament.
export function autoMatch(filaments: Filament[], ams: AmsState): SpoolMatch[] {
  return filaments.map((f) => matchFilament(f, ams));
}

/// Validate explicit choices (one per filament, in order) against what is
/// loaded; a type mismatch is allowed (the user chose it) but flagged.
export function explicitMatch(filaments: Filament[], ams: AmsState, choices: unknown[]): SpoolMatch[] {
  if (choices.length !== filaments.length) {
    throw new Error(`spools: expected ${filaments.length} choice(s) (one per used filament), got ${choices.length}`);
  }
  return filaments.map((f, i) => {
    const c = String(choices[i] ?? "").trim().toLowerCase();
    if (c === "auto") return matchFilament(f, ams);
    if (c === EXTERNAL) {
      const w = ams.external ? (typeScore(f.type, ams.external.type) === 0 ? undefined : mismatch(f, ams.external.type)) : "the printer reports no external spool";
      return w ? { filament: f, spool: EXTERNAL, warning: w } : { filament: f, spool: EXTERNAL };
    }
    const m = /^ams:(\d+)$/.exec(c);
    const tray = m ? ams.trays.find((t) => t.slot === Number(m[1])) : undefined;
    if (!tray) throw new Error(`spools[${i}]: '${String(choices[i])}' is not a loaded spool (use "ams:<slot>" or "external")`);
    const w = typeScore(f.type, tray.type) === 0 ? undefined : mismatch(f, tray.type);
    return w ? { filament: f, spool: amsRef(tray.slot), warning: w } : { filament: f, spool: amsRef(tray.slot) };
  });
}

/// The start options for a set of matches: all external → no AMS; otherwise
/// use_ams with ams_mapping (external slots → EXTERNAL_TRAY_ID).
export function mappingFor(matches: SpoolMatch[]): { use_ams: boolean; ams_mapping?: number[] } {
  if (!matches.length || matches.every((m) => m.spool === EXTERNAL)) return { use_ams: false };
  const len = Math.max(...matches.map((m) => m.filament.id));
  const mapping = new Array<number>(len).fill(-1);
  for (const m of matches) {
    mapping[m.filament.id - 1] = m.spool === EXTERNAL ? EXTERNAL_TRAY_ID : Number(m.spool.slice(4));
  }
  return { use_ams: true, ams_mapping: mapping };
}

/// "AMS 1 · slot 2 (PLA #161616)" / "External spool (ASA)".
export function spoolLabel(ref: SpoolRef, ams: AmsState | null): string {
  if (ref === EXTERNAL) {
    const e = ams?.external;
    return e ? `External spool (${e.type}${normColor(e.color) ? " #" + normColor(e.color) : ""})` : "External spool";
  }
  const slot = Number(ref.slice(4));
  const t = ams?.trays.find((x) => x.slot === slot);
  const where = `AMS ${Math.floor(slot / 4) + 1} · slot ${(slot % 4) + 1}`;
  return t ? `${where} (${t.type}${normColor(t.color) ? " #" + normColor(t.color) : ""})` : where;
}

/// One line per filament for the confirmation question.
export function describeMatches(matches: SpoolMatch[], ams: AmsState | null): string {
  return matches
    .map((m) => {
      const f = m.filament;
      const what = [f.type || "unknown type", f.color ? "#" + f.color : ""].filter(Boolean).join(" ");
      return `filament ${f.id} (${what}) → ${spoolLabel(m.spool, ams)}${m.warning ? ` — WARNING: ${m.warning}` : ""}`;
    })
    .join("; ");
}
