// Printer control panel: API types + pure rules (no DOM). Unit-tested in
// test/ui-control.test.ts. See ui/detail.ts for the panel itself.

// Self-contained (no ./state import) so the no-DOM test tsconfig can load it.
interface Temp {
  actual: number;
  target: number | null;
}

export type FanId = "part" | "aux" | "chamber";
export type HeaterId = "nozzle" | "bed" | "chamber";

/// GET printers/:id/capabilities
export interface Capabilities {
  job: { pause: boolean; resume: boolean; stop: boolean; speed_levels: boolean; speed_percent: boolean };
  temps: Record<HeaterId, { max: number } | null>;
  motion: boolean;
  extrude: boolean;
  load_unload: boolean;
  fans: FanId[];
  light: boolean;
  ams: boolean;
  files: boolean;
  gcode: boolean;
  camera: boolean;
  errors: boolean;
}

export interface AmsTray {
  slot: number;
  unit: number;
  tray: number;
  type: string | null;
  color: string | null;
  active?: boolean;
}

export interface PrinterError {
  code: string | number;
  text: string | null;
  severity: string;
  url?: string;
}

/// GET printers/:id/detail
export interface Detail {
  state: string;
  progress: number;
  file: string | null;
  elapsed_s: number | null;
  eta_s: number | null;
  layer: number | null;
  total_layers: number | null;
  temps: { nozzle?: Temp; bed?: Temp; chamber?: Temp };
  message: string | null;
  speed_level: number | null;
  speed_percent: number | null;
  fans: Partial<Record<FanId, number>>;
  light: "on" | "off" | null;
  wifi_signal: string | number | null;
  firmware: string | null;
  developer_mode: boolean | null;
  errors: PrinterError[];
  ams: { trays: AmsTray[]; external: { type: string | null; color: string | null } | null; active?: number | "external" | null } | null;
}

export interface RemoteFile {
  name: string;
  size: number;
  mtime: number | string | null;
}

export interface Capture {
  id: string;
  printer_id: string;
  taken_at: number | string;
  size: number;
  url: string;
}

export const SPEED_LEVELS: { level: number; label: string }[] = [
  { level: 1, label: "Silent" },
  { level: 2, label: "Standard" },
  { level: 3, label: "Sport" },
  { level: 4, label: "Ludicrous" },
];

export const JOG_STEPS = [0.1, 1, 10, 50];

/// Temperature presets (nozzle / bed °C); "Off" turns every heater off.
export const TEMP_PRESETS: { label: string; nozzle: number; bed: number }[] = [
  { label: "PLA", nozzle: 220, bed: 60 },
  { label: "PETG", nozzle: 250, bed: 80 },
  { label: "ABS", nozzle: 260, bed: 100 },
  { label: "Off", nozzle: 0, bed: 0 },
];

export const MIN_EXTRUDE_TEMP = 170;

export function clampTemp(v: number, max: number | null | undefined): number {
  if (!isFinite(v) || v < 0) return 0;
  const r = Math.round(v);
  return max != null && max > 0 ? Math.min(r, max) : r;
}

export function isRunning(state: string | null | undefined): boolean {
  return state === "printing" || state === "paused";
}

/// Why motion / console / filament changes are locked, or null.
export function busyReason(state: string | null | undefined, what: string): string | null {
  if (isRunning(state)) return `${what} is disabled while a print is ${state === "paused" ? "paused" : "running"}.`;
  if (state === "offline") return "The printer is offline.";
  return null;
}

/// Why extrude / retract can't run, or null.
export function extrudeReason(d: Pick<Detail, "state" | "temps"> | null): string | null {
  if (!d) return "Waiting for printer status…";
  const busy = busyReason(d.state, "Extruding");
  if (busy) return busy;
  const t = d.temps?.nozzle?.actual;
  if (t == null || t < MIN_EXTRUDE_TEMP) return `Heat the nozzle to at least ${MIN_EXTRUDE_TEMP} °C first${t != null ? ` (now ${Math.round(t)} °C)` : ""}.`;
  return null;
}

/// Show the "enable Developer Mode" banner?
export function needsDevBanner(developerMode: boolean | null | undefined, refused: boolean): boolean {
  return developerMode === false || refused;
}

/// Bambu colours come as "RRGGBB" or "RRGGBBAA"; CSS needs a "#".
export function cssColor(c: string | null | undefined): string | null {
  if (!c) return null;
  const s = c.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return "#" + s.slice(0, 6);
  return c;
}

/// Load-filament choices from the AMS shape ("external" = the outside spool).
export function loadChoices(ams: Detail["ams"]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const t of ams?.trays || []) out.push({ value: String(t.slot), label: `AMS ${t.unit + 1} · Slot ${t.tray + 1}${t.type ? " — " + t.type : " — empty"}` });
  out.push({ value: "external", label: "External spool" + (ams?.external?.type ? " — " + ams.external.type : "") });
  return out;
}

/// Epoch seconds, epoch ms or an ISO string → Date.
export function toDate(v: number | string | null | undefined): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function newestFirst<T extends { taken_at: number | string }>(xs: T[]): T[] {
  return xs.slice().sort((a, b) => (toDate(b.taken_at)?.getTime() || 0) - (toDate(a.taken_at)?.getTime() || 0));
}

/// Wi-Fi signal → display text ("-52dBm" stays, numbers get "dBm").
export function fmtSignal(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  return typeof v === "number" ? `${v} dBm` : v;
}
