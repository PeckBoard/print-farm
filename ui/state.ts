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
  bambu?: { serial: string; model?: string; has_access_code: boolean };
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
    display: boolean;
    xvfb_run: string | null;
    headless_mode: string;
    curl_found: boolean;
  };
  bridge_url: string;
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
