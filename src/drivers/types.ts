// The normalised printer model every driver maps onto. The UI and the
// print-bridge sidecar use exactly this status shape.

import type { AmsState } from "../ams";

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
  /// Bambu only: loaded AMS trays + external spool (print-bridge >= 0.1.6).
  ams?: AmsState | null;
}

export interface StartOptions {
  /// Bambu only: plate index inside the .gcode.3mf (default 1).
  plate?: number;
  /// Bambu only.
  use_ams?: boolean;
  /// Bambu only: per filament (id - 1) the global AMS tray, -1 unused.
  ams_mapping?: number[];
  /// Bambu only.
  bed_leveling?: boolean;
}

export interface Snapshot {
  content_type: string;
  data_base64: string;
}

export type FanName = "part" | "aux" | "chamber";
export type Heater = "nozzle" | "bed" | "chamber";
export type Axis = "x" | "y" | "z";

/// What a printer's controls support; the UI hides the rest.
export interface Capabilities {
  job: { pause: boolean; resume: boolean; stop: boolean; speed_levels: boolean; speed_percent: boolean };
  temps: { nozzle: { max: number } | null; bed: { max: number } | null; chamber: { max: number } | null };
  motion: boolean;
  extrude: boolean;
  load_unload: boolean;
  fans: FanName[];
  light: boolean;
  ams: boolean;
  files: boolean;
  gcode: boolean;
  camera: boolean;
  errors: boolean;
  /// Why setting a temperature isn't possible, when `temps` are all null.
  temps_unsupported_reason?: string;
}

export interface PrinterError {
  code: string;
  text: string | null;
  severity: string;
  url?: string;
}

/// Status plus the control-panel fields.
export interface PrinterDetail extends PrinterStatus {
  speed_level: number | null;
  speed_percent: number | null;
  fans: Partial<Record<FanName, number>>;
  light: "on" | "off" | null;
  wifi_signal: string | null;
  firmware: string | null;
  developer_mode: boolean | null;
  errors: PrinterError[];
  ams: AmsState | null;
}

/// A validated control request (see control.ts `parseControl`).
export type ControlAction =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "stop" }
  | { action: "speed"; level?: number; percent?: number }
  | { action: "temp"; heater: Heater; target: number }
  | { action: "fan"; fan: FanName; percent: number }
  | { action: "light"; on: boolean }
  | { action: "home" }
  | { action: "jog"; axis: Axis; distance: number }
  | { action: "motors_off" }
  | { action: "extrude"; mm: number }
  | { action: "load"; slot: number | "external" }
  | { action: "unload" }
  | { action: "gcode"; line: string };

/// `confirmed: false` = sent, but the printer didn't acknowledge it (Bambu).
export interface ControlResult {
  ok: true;
  confirmed?: boolean;
}

/// A file on the printer's own storage.
export interface RemoteFile {
  name: string;
  size: number;
  /// Unix seconds, or null when unknown.
  mtime: number | null;
}

/// An error with an HTTP status for the UI (and a hint for people/agents).
export class DriverError extends Error {
  constructor(
    public status: number,
    msg: string,
    public hint?: string,
    public needs_developer_mode?: boolean,
  ) {
    super(msg);
  }
}

export const DEVELOPER_MODE_HINT = "On the printer: Settings → enable LAN Only Mode, then Developer Mode.";

export function unsupported(what: string): DriverError {
  return new DriverError(400, `${what} is not supported on this printer`);
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
  capabilities(): Capabilities;
  detail(): PrinterDetail;
  /// Run a validated action (callers go through control.ts `runControl`).
  control(a: ControlAction): ControlResult;
  /// Files on the printer's storage.
  files(): RemoteFile[];
  deleteFile(name: string): void;
}

/// A capability set with everything off; drivers switch on what they do.
export function noCapabilities(): Capabilities {
  return {
    job: { pause: false, resume: false, stop: false, speed_levels: false, speed_percent: false },
    temps: { nozzle: null, bed: null, chamber: null },
    motion: false,
    extrude: false,
    load_unload: false,
    fans: [],
    light: false,
    ams: false,
    files: false,
    gcode: false,
    camera: false,
    errors: false,
  };
}

/// A detail record from a plain status (fields the driver doesn't know: null).
export function detailFrom(st: PrinterStatus): PrinterDetail {
  const errors: PrinterError[] =
    st.state === "error" && st.message ? [{ code: "error", text: st.message, severity: "error" }] : [];
  return {
    ...st,
    speed_level: null,
    speed_percent: null,
    fans: {},
    light: null,
    wifi_signal: null,
    firmware: null,
    developer_mode: null,
    errors,
    ams: st.ams ?? null,
  };
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
  /// `serial_corrected_from`: the serial the user typed, when print-bridge
  /// read a different one off the printer's certificate and we switched.
  bambu?: { serial: string; access_code: string; model?: string; serial_corrected_from?: string };
  /// Accept a self-signed TLS certificate (https hosts only).
  tls_insecure?: boolean;
  /// PrusaLink storage name ("usb" on MK4/XL/MINI, "local" on some builds).
  storage?: string;
  orca_printer_profile?: string;
  orca_filament_profile?: string;
  orca_process_profile?: string;
  /// Per-printer slicing settings (farmsettings.ts); presets are the
  /// `orca_*_profile` fields above.
  settings?: { plate_type?: string; nozzle_mm?: number };
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
