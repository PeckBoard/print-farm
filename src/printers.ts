// Printer registry (data_store collection "printers"). Secrets (api_key,
// password, Bambu access code) are stored here and NEVER returned to the UI or
// to agents — every outward view goes through `redact`.

import { storeGet, storePut, storeList, storeDelete } from "./host";
import { nextSeq } from "./counter";
import { PrinterRecord, PrinterType } from "./drivers/types";

const COLLECTION = "printers";
const TYPES: PrinterType[] = ["moonraker", "octoprint", "prusalink", "bambu"];

export interface RedactedPrinter {
  id: string;
  name: string;
  type: PrinterType;
  host: string;
  port?: number;
  username?: string;
  has_api_key: boolean;
  has_password: boolean;
  bambu?: { serial: string; model?: string; has_access_code: boolean };
  tls_insecure: boolean;
  storage?: string;
  orca_printer_profile?: string;
  orca_filament_profile?: string;
  orca_process_profile?: string;
}

export function redact(p: PrinterRecord): RedactedPrinter {
  const out: RedactedPrinter = {
    id: p.id,
    name: p.name,
    type: p.type,
    host: p.host,
    has_api_key: !!p.api_key,
    has_password: !!p.password,
    tls_insecure: !!p.tls_insecure,
  };
  if (p.port !== undefined) out.port = p.port;
  if (p.username) out.username = p.username;
  if (p.storage) out.storage = p.storage;
  if (p.bambu) {
    out.bambu = { serial: p.bambu.serial, has_access_code: !!p.bambu.access_code };
    if (p.bambu.model) out.bambu.model = p.bambu.model;
  }
  for (const k of ["orca_printer_profile", "orca_filament_profile", "orca_process_profile"] as const) {
    if (p[k]) out[k] = p[k];
  }
  return out;
}

function optStr(v: unknown, field: string, max = 512): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new Error(`${field} is too long`);
  return s || undefined;
}

/// Secret field update rule: omitted (undefined) or "" keeps the stored value,
/// explicit null clears it, any other string replaces it.
function secret(input: any, key: string, prev: string | undefined): string | undefined {
  if (!(key in input) || input[key] === undefined || input[key] === "") return prev;
  if (input[key] === null) return undefined;
  return optStr(input[key], key, 4096);
}

/// Build (create or update) a record from untrusted input. Pure — tested.
export function buildPrinter(input: any, existing: PrinterRecord | null, idf: () => string): PrinterRecord {
  if (!input || typeof input !== "object") throw new Error("printer must be an object");
  const type = (input.type ?? existing?.type) as PrinterType;
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
  const host = optStr(input.host, "host") ?? existing?.host;
  if (!host) throw new Error("host is required");
  if (/[\s'"`<>]/.test(host)) throw new Error("host contains invalid characters");
  const name = optStr(input.name, "name", 120) ?? existing?.name ?? host;

  let port = existing?.port;
  if ("port" in input) {
    if (input.port === null || input.port === "") port = undefined;
    else {
      const n = Number(input.port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("port must be 1..65535");
      port = n;
    }
  }

  const rec: PrinterRecord = { id: existing?.id ?? idf(), name, type, host };
  if (port !== undefined) rec.port = port;
  const api_key = secret(input, "api_key", existing?.api_key);
  const password = secret(input, "password", existing?.password);
  if (api_key) rec.api_key = api_key;
  if (password) rec.password = password;
  const username = "username" in input ? optStr(input.username, "username", 120) : existing?.username;
  if (username) rec.username = username;
  const tls = "tls_insecure" in input ? input.tls_insecure === true : existing?.tls_insecure;
  if (tls) rec.tls_insecure = true;
  const storage = "storage" in input ? optStr(input.storage, "storage", 32) : existing?.storage;
  if (storage) rec.storage = storage;
  for (const k of ["orca_printer_profile", "orca_filament_profile", "orca_process_profile"] as const) {
    const v = k in input ? optStr(input[k], k, 256) : existing?.[k];
    if (v) rec[k] = v;
  }

  if (type === "bambu") {
    const b = input.bambu ?? {};
    const prev = existing?.bambu;
    const serial = optStr(b.serial, "bambu.serial", 64) ?? prev?.serial;
    const access_code = secret(b, "access_code", prev?.access_code);
    const model = "model" in b ? optStr(b.model, "bambu.model", 64) : prev?.model;
    if (!serial) throw new Error("bambu.serial is required for a Bambu printer");
    if (!access_code) throw new Error("bambu.access_code is required for a Bambu printer");
    rec.bambu = { serial, access_code };
    if (model) rec.bambu.model = model;
  }
  return rec;
}

// ── store-backed ────────────────────────────────────────────────────────────

export function listPrinters(): PrinterRecord[] {
  return storeList(COLLECTION)
    .map((i) => i.value as PrinterRecord)
    .filter((p) => p && p.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPrinter(id: string): PrinterRecord | null {
  return (storeGet(COLLECTION, id) as PrinterRecord) ?? null;
}

/// Resolve by id or (case-insensitive) name.
export function resolvePrinter(ref: unknown): PrinterRecord {
  const s = typeof ref === "string" ? ref.trim() : "";
  if (!s) throw new Error("printer is required (id or name; see printer_list)");
  const byId = getPrinter(s);
  if (byId) return byId;
  const lower = s.toLowerCase();
  const hit = listPrinters().filter((p) => p.name.toLowerCase() === lower);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new Error(`printer name '${s}' is ambiguous; use the id`);
  throw new Error(`unknown printer '${s}'`);
}

export function savePrinter(input: any, existing: PrinterRecord | null): PrinterRecord {
  const rec = buildPrinter(input, existing, () => "p" + nextSeq("printer_seq"));
  storePut(COLLECTION, rec.id, rec);
  return rec;
}

export function deletePrinter(id: string): void {
  storeDelete(COLLECTION, id);
}
