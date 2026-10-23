// Shared page state + API types (see README "UI API").

import { get } from "./api";

export interface Temp {
  actual: number;
  target: number | null;
}
export interface Status {
  state: string;
  progress: number;
  file: string | null;
  elapsed_s: number | null;
  eta_s: number | null;
  layer: number | null;
  total_layers: number | null;
  temps: { nozzle?: Temp; bed?: Temp; chamber?: Temp };
  message: string | null;
}
export interface Printer {
  id: string;
  name: string;
  type: string;
  host: string;
  port?: number;
  username?: string;
  has_api_key: boolean;
  has_password: boolean;
  tls_insecure: boolean;
  storage?: string;
  bambu?: { serial: string; model?: string; has_access_code: boolean; serial_corrected_from?: string };
  orca_printer_profile?: string;
  orca_filament_profile?: string;
  orca_process_profile?: string;
}
export interface Estimate {
  print_time_s: number | null;
  filament_mm: number | null;
  filament_g: number | null;
  filament_cm3: number | null;
  filament_cost: number | null;
  layers: number | null;
}
export interface FileRec {
  id: string;
  name: string;
  kind: string;
  size: number;
  complete: boolean;
  source: string;
  slice_job?: string;
  estimate?: Estimate;
}
export interface SliceJob {
  id: string;
  status: "running" | "succeeded" | "failed";
  model_file_id: string;
  printer_id?: string;
  profiles: { printer: string; filament: string; process: string; vendor?: string };
  target: string;
  result_file_id?: string;
  estimate?: Estimate;
  error?: string;
  log_tail?: string;
}
export interface Print {
  id: string;
  printer_id: string;
  file_id: string;
  remote_name: string;
  requested_by: "ui" | "agent";
  status: string;
  error?: string;
}
export interface Diagnostics {
  orca: {
    orca_path: string;
    orca_found: boolean;
    orca_resolved: string | null;
    orca_via: "path" | "local" | "flatpak" | null;
    display: boolean;
    xvfb_run: string | null;
    headless_mode: string;
    curl_found: boolean;
  };
  bridge_url: string;
  /// null when not probed (no Bambu printer and `?bridge=1` not asked).
  bridge: { reachable: boolean; version?: string; token_source: "setting" | "file" | "none"; error?: string; auth_failed?: boolean } | null;
  profile_roots: { kind: string; path: string }[];
}

export const state = {
  printers: [] as Printer[],
  printersLoaded: false,
  status: new Map<string, Status>(),
  statusLoaded: false,
  prints: [] as Print[],
  files: [] as FileRec[],
  filesLoaded: false,
  jobs: [] as SliceJob[],
  diagnostics: null as Diagnostics | null,
  setup: null as Setup | null,
};

export function printerById(id: string | undefined): Printer | undefined {
  return state.printers.find((p) => p.id === id);
}

export async function loadPrinters(): Promise<Printer[]> {
  const r = await get<{ printers: Printer[] }>("printers");
  state.printers = r.printers;
  state.printersLoaded = true;
  return r.printers;
}

// ── Orca profiles (cached per kind+vendor) ─────────────────────────────────

/// Drop cached vendor/profile lists (an install just added profiles).
export function resetProfileCache(): void {
  vendorsP = null;
  profileCache.clear();
}

/// Automatic installs (GET setup). See src/setup.ts.
export interface SetupItem {
  status: "ok" | "running" | "failed";
  reason?: string;
  phase?: string;
  bytes?: number;
  total?: number;
  error?: string;
  log_tail?: string;
  no_systemd?: boolean;
  version?: string;
}
export interface Setup {
  orca: SetupItem;
  bridge: SetupItem | null;
  notices: string[];
}

/// Fired on window when an automatic install finishes successfully.
export const SETUP_DONE = "pf-setup-done";
/// Fired on window whenever the setup state was (re)loaded.
export const SETUP_CHANGED = "pf-setup-changed";

let vendorsP: Promise<string[]> | null = null;
const profileCache = new Map<string, Promise<string[]>>();

export function loadVendors(force = false): Promise<string[]> {
  if (!vendorsP || force) {
    vendorsP = get<{ vendors: string[] }>("profiles").then((r) => r.vendors || []);
    vendorsP.catch(() => (vendorsP = null));
  }
  return vendorsP;
}

export function loadProfiles(kind: "printer" | "filament" | "process", vendor: string): Promise<string[]> {
  const key = kind + "|" + vendor;
  let p = profileCache.get(key);
  if (!p) {
    p = get<{ profiles: { name: string }[] }>(`profiles?kind=${kind}&vendor=${encodeURIComponent(vendor)}`).then((r) =>
      (r.profiles || []).map((x) => x.name),
    );
    p.catch(() => profileCache.delete(key));
    profileCache.set(key, p);
  }
  return p;
}
