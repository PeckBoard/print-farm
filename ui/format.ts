// Pure display helpers for the Print Farm page (no DOM). Unit-tested in
// test/ui-format.test.ts.

export type PrinterState = "idle" | "printing" | "paused" | "finished" | "error" | "offline";

/// Seconds → "1d 2h", "2h 05m", "45m 12s", "37s". null/negative → "—".
export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !isFinite(s) || s < 0) return "—";
  const t = Math.round(s);
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/// Bytes → "512 B", "1.4 KB", "12.3 MB".
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/// Progress 0..1 → "42%" (clamped; one decimal below 10%).
export function fmtPercent(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "0%";
  const v = Math.max(0, Math.min(1, p)) * 100;
  return v > 0 && v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}

/// A temperature reading → "214° / 215°" (target hidden when 0/null = off).
export function fmtTemp(t: { actual: number; target: number | null } | undefined): string {
  if (!t || !isFinite(t.actual)) return "—";
  const a = `${Math.round(t.actual)}°`;
  return t.target ? `${a} / ${Math.round(t.target)}°` : a;
}

/// Filament: grams if known, else metres from mm.
export function fmtFilament(e: { filament_g?: number | null; filament_mm?: number | null } | undefined): string {
  if (!e) return "—";
  const parts: string[] = [];
  if (e.filament_g != null) parts.push(`${e.filament_g < 10 ? e.filament_g.toFixed(1) : Math.round(e.filament_g)} g`);
  if (e.filament_mm != null) parts.push(`${(e.filament_mm / 1000).toFixed(2)} m`);
  return parts.length ? parts.join(" · ") : "—";
}

export interface Pill {
  label: string;
  /// CSS modifier: ok | busy | warn | bad | muted | done
  tone: "ok" | "busy" | "warn" | "bad" | "muted" | "done";
}

/// Printer state → the pill shown on the card.
export function statePill(state: string | null | undefined): Pill {
  switch (state) {
    case "idle":
      return { label: "Idle", tone: "ok" };
    case "printing":
      return { label: "Printing", tone: "busy" };
    case "paused":
      return { label: "Paused", tone: "warn" };
    case "finished":
      return { label: "Finished", tone: "done" };
    case "error":
      return { label: "Error", tone: "bad" };
    case "offline":
      return { label: "Offline", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

/// Which controls a state allows.
export function controlsFor(state: string | null | undefined): { pause: boolean; resume: boolean; cancel: boolean } {
  return {
    pause: state === "printing",
    resume: state === "paused",
    cancel: state === "printing" || state === "paused",
  };
}

export const TYPE_LABELS: Record<string, string> = {
  moonraker: "Klipper / Moonraker",
  octoprint: "OctoPrint",
  prusalink: "PrusaLink",
  bambu: "Bambu Lab",
};

export const TYPE_SHORT: Record<string, string> = {
  moonraker: "Klipper",
  octoprint: "OctoPrint",
  prusalink: "PrusaLink",
  bambu: "Bambu",
};

/// File kinds each printer type accepts (mirrors src/prints.ts ACCEPTS).
export const ACCEPTS: Record<string, string[]> = {
  moonraker: ["gcode"],
  octoprint: ["gcode"],
  prusalink: ["gcode", "bgcode"],
  bambu: ["gcode.3mf"],
};

export function accepts(type: string, kind: string): boolean {
  return (ACCEPTS[type] || []).indexOf(kind) >= 0;
}

/// Print records the user still has to act on (start or dismiss).
export function isQueued(status: string): boolean {
  return status === "uploaded" || status === "awaiting_confirmation";
}

/// Case-insensitive multi-word match for the combobox: every whitespace-
/// separated term must occur somewhere in the option.
export function matchesQuery(option: string, query: string): boolean {
  const o = option.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => o.indexOf(t) >= 0);
}

/// Model formats the 3D viewer can render.
export function previewKind(name: string, kind: string): "stl" | "3mf" | "gcode" | "gcode.3mf" | null {
  const n = name.toLowerCase();
  if (kind === "gcode") return "gcode";
  if (kind === "gcode.3mf") return "gcode.3mf";
  if (kind === "model" && n.endsWith(".stl")) return "stl";
  if (kind === "model" && n.endsWith(".3mf")) return "3mf";
  return null;
}
