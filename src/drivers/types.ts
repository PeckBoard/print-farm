// The normalised printer model every driver maps onto. The UI and the
// print-bridge sidecar use exactly this status shape.

export type PrinterType = "moonraker" | "octoprint" | "prusalink" | "bambu";

export type PrinterState = "idle" | "printing" | "paused" | "finished" | "error" | "offline";

export interface Temp {
  actual: number;
  target: number;
}

export interface PrinterStatus {
  state: PrinterState;
  progress: number; // 0..1
  file: string | null;
  elapsed_s: number | null;
  eta_s: number | null;
  layer: number | null;
  total_layers: number | null;
  temps: {
    nozzle?: Temp;
    bed?: Temp;
    chamber?: { actual: number; target: number | null };
  };
  message: string | null;
}

export interface StartOptions {
  /// Bambu only: plate index inside the .gcode.3mf (default 1).
  plate?: number;
  /// Bambu only.
  use_ams?: boolean;
  /// Bambu only.
  bed_leveling?: boolean;
}

export interface Snapshot {
  content_type: string;
  data_base64: string;
}

export interface PrinterDriver {
  status(): PrinterStatus;
  /// Upload a file from local disk (the plugin's storage dir) under `name`.
  upload(name: string, src: { path: string }): void;
  start(file: string, opts?: StartOptions): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  /// A camera frame, or null when the printer has no camera.
  snapshot(): Snapshot | null;
  /// Reachability + credential check.
  test(): { ok: boolean; detail: string };
}

/// Stored printer record (secrets included — never hand this to the UI; see
/// printers.ts `redact`).
export interface PrinterRecord {
  id: string;
  name: string;
  type: PrinterType;
  host: string;
  port?: number;
  api_key?: string;
  username?: string;
  password?: string;
  bambu?: { serial: string; access_code: string; model?: string };
  /// Accept a self-signed TLS certificate (https hosts only).
  tls_insecure?: boolean;
  /// PrusaLink storage name ("usb" on MK4/XL/MINI, "local" on some builds).
  storage?: string;
  orca_printer_profile?: string;
  orca_filament_profile?: string;
  orca_process_profile?: string;
}

export function emptyStatus(state: PrinterState, message: string | null = null): PrinterStatus {
  return {
    state,
    progress: 0,
    file: null,
    elapsed_s: null,
    eta_s: null,
    layer: null,
    total_layers: null,
    temps: {},
    message,
  };
}

/// Base URL for an HTTP printer: `host` may carry a scheme (`https://...`).
export function baseUrl(p: PrinterRecord, defaultPort: number): string {
  let host = p.host.trim().replace(/\/+$/, "");
  let scheme = "http";
  const m = /^(https?):\/\/(.*)$/i.exec(host);
  if (m) {
    scheme = m[1].toLowerCase();
    host = m[2];
  }
  const hasPort = /:\d+$/.test(host) || /^\[.*\]:\d+$/.test(host);
  const port = p.port ?? (hasPort ? undefined : scheme === "https" ? undefined : defaultPort);
  return `${scheme}://${host}${port && port !== 80 ? ":" + port : ""}`;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

export function clamp01(v: number): number {
  if (!isFinite(v) || v < 0) return 0;
  return v > 1 ? 1 : v;
}

export function temp(actual: unknown, target: unknown): Temp | undefined {
  const a = num(actual);
  if (a === null) return undefined;
  return { actual: a, target: num(target) ?? 0 };
}

/// URL-encode each path segment of a file name.
export function encPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}
