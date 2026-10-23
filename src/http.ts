// HTTP surfaces: the served page (`http.request.before`) and the
// authenticated app-UI JSON API (`http.request.authed`) under
// /api/plugin-ui/print-farm/*. Every request here is a logged-in user's, so a
// UI "start" is a human click. Secrets never leave through this surface —
// printers go through `redact`.
//
// Binary data: core's plugin HTTP bridge carries string bodies only (request
// bodies are decoded lossy-UTF-8, responses are sent as the string's bytes),
// and axum caps request bodies at 2 MiB. So binary goes as base64 inside JSON
// both ways, uploads are chunked (≤1 MiB base64 per request), and file reads
// are ranged (≤768 KiB per request).

import { htmlResponse, jsonResponse, errMsg } from "./verdict";
import { PAGE } from "./page";
import { listPrinters, getPrinter, savePrinter, deletePrinter, redact, putPrinter } from "./printers";
import { driverFor } from "./drivers";
import { registerWithBridge, unregisterFromBridge, bridgeDiagnostics } from "./drivers/bambu";
import { defaultTransport } from "./transport";
import { bridgeConfig } from "./config";
import { PrinterRecord } from "./drivers/types";
import {
  listFiles,
  requireFile,
  newFileRecord,
  putFile,
  uploadChunk,
  readB64,
  deleteFile,
  MAX_READ,
} from "./storage";
import { detectRoots, listVendors, scanProfiles, parseKind } from "./profiles";
import { startSlice, pollSlice, listJobs, orcaDiagnostics } from "./slice";
import { uploadForPrint, startPrint, dismissPrint, listPrints, getPrint, publicJob } from "./prints";
import { autoFill } from "./autoprofiles";
import { ensureSetup, invalidateSetup, syncSerials, SetupName } from "./setup";
import { planSpools, spoolChoices, withSpools } from "./spools";

export const PAGE_PATH = "/plugin-api/v1/print-farm";
export const API = "/api/plugin-ui/print-farm";

function up(v: unknown): string {
  return (typeof v === "string" ? v : "").toUpperCase();
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function parseBody(body: string): any {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("invalid request body: " + errMsg(e));
  }
}

export function serveHttp(payload: any): string {
  if (up(payload?.method) === "GET" && str(payload?.path) === PAGE_PATH) {
    return htmlResponse(200, PAGE);
  }
  return htmlResponse(404, "<!doctype html><title>Not found</title><p>Not found.</p>");
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

function printerOr404(id: string): PrinterRecord {
  const p = getPrinter(id);
  if (!p) throw new HttpError(404, `unknown printer '${id}'`);
  return p;
}

function driver(p: PrinterRecord) {
  return driverFor(p, defaultTransport, bridgeConfig());
}

/// Keep the sidecar's registry in step with ours (best effort).
function syncBridge(p: PrinterRecord): string | null {
  if (p.type !== "bambu") return null;
  try {
    registerWithBridge(p, defaultTransport, bridgeConfig());
    return null;
  } catch (e) {
    return `saved, but print-bridge registration failed: ${errMsg(e)}`;
  }
}

/// Save, then fill in default slicing profiles when the printer has none.
function saveWithDefaults(body: any, existing: PrinterRecord | null): PrinterRecord {
  let p = savePrinter(body, existing);
  const filled = autoFill(p, true);
  if (filled) {
    putPrinter(filled);
    p = filled;
  }
  if (p.type === "bambu") invalidateSetup();
  return p;
}

/// Printers for the UI, lazily auto-filling defaults on ones that lack them.
function listWithDefaults(): PrinterRecord[] {
  return listPrinters().map((p) => {
    const filled = autoFill(p, false);
    if (!filled) return p;
    putPrinter(filled);
    return filled;
  });
}

type Handler = (ctx: { params: Record<string, string>; query: string; body: any }) => unknown;

function setupName(v: string): SetupName {
  if (v !== "orca" && v !== "bridge") throw new HttpError(404, `unknown setup '${v}'`);
  return v;
}

/// Route table: "METHOD path" (with :params) → handler. Mirrors manifest ui_routes.
export const ROUTES: Array<[string, Handler]> = [
  ["GET printers", () => ({ printers: listWithDefaults().map(redact) })],
  [
    "POST printers",
    ({ body }) => {
      const p = saveWithDefaults(body, null);
      return { printer: redact(p), warning: syncBridge(p) };
    },
  ],
  [
    "PUT printers/:id",
    ({ params, body }) => {
      const p = saveWithDefaults(body, printerOr404(params.id));
      return { printer: redact(p), warning: syncBridge(p) };
    },
  ],
  [
    "DELETE printers/:id",
    ({ params }) => {
      const p = printerOr404(params.id);
      deletePrinter(p.id);
      if (p.type === "bambu") {
        try {
          unregisterFromBridge(p.id, defaultTransport, bridgeConfig());
        } catch (_e) {
          /* best effort */
        }
      }
      return { removed: p.id };
    },
  ],
  [
    "POST printers/:id/test",
    ({ params }) => {
      const p = printerOr404(params.id);
      const r = driver(p).test();
      if (p.type !== "bambu") return r;
      // The bridge reads the real serial off the printer while connecting.
      const notices = syncSerials([p]);
      return notices.length ? { ...r, detail: r.detail + " — " + notices.join("; "), serial_corrected: true } : r;
    },
  ],
  ["GET setup", () => ensureSetup()],
  ["POST setup/:name/retry", ({ params }) => ensureSetup(setupName(params.name))],
  [
    "GET status",
    () => ({
      printers: listPrinters().map((p) => ({ id: p.id, name: p.name, type: p.type, status: driver(p).status() })),
    }),
  ],
  ["GET printers/:id/status", ({ params }) => ({ id: params.id, status: driver(printerOr404(params.id)).status() })],
  [
    "POST printers/:id/control",
    ({ params, body }) => {
      const d = driver(printerOr404(params.id));
      const action = str(body?.action);
      if (action === "pause") d.pause();
      else if (action === "resume") d.resume();
      else if (action === "cancel") d.cancel();
      else throw new Error("action must be pause, resume, or cancel");
      return { ok: true, action };
    },
  ],
  [
    "GET printers/:id/snapshot",
    ({ params }) => {
      const snap = driver(printerOr404(params.id)).snapshot();
      if (!snap) throw new HttpError(404, "no camera");
      return snap;
    },
  ],
  [
    "GET profiles",
    ({ query }) => {
      const roots = detectRoots();
      const kindRaw = queryParam(query, "kind");
      const vendor = queryParam(query, "vendor");
      if (!kindRaw || !vendor) return { roots, vendors: listVendors(roots) };
      const kind = parseKind(kindRaw);
      const all = queryParam(query, "all") === "1";
      const entries = scanProfiles(roots, vendor, kind, queryParam(query, "refresh") === "1")
        .filter((e) => all || e.instantiable)
        .map((e) => ({ name: e.name, vendor: e.vendor, inherits: e.inherits || null, instantiable: e.instantiable, source: e.source }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { kind, vendor, profiles: entries };
    },
  ],
  ["GET files", () => ({ files: listFiles() })],
  [
    "POST uploads",
    ({ body }) => {
      const name = str(body?.name);
      if (!name) throw new Error("name is required");
      const rec = newFileRecord(name, "upload");
      putFile(rec);
      const data = str(body?.data_base64);
      const file = data || body?.done === true ? uploadChunk(rec, 0, data, body?.done === true) : rec;
      return { file };
    },
  ],
  [
    "POST uploads/:id/chunk",
    ({ params, body }) => {
      const f = requireFile(params.id);
      return { file: uploadChunk(f, Number(body?.offset ?? -1), str(body?.data_base64), body?.done === true) };
    },
  ],
  [
    "GET files/:id",
    ({ params, query }) => {
      const f = requireFile(params.id);
      const offset = Number(queryParam(query, "offset") ?? "0") || 0;
      const length = Number(queryParam(query, "length") ?? String(MAX_READ)) || MAX_READ;
      const r = readB64(f.path, offset, length);
      const got = Math.floor((r.data_base64.length * 3) / 4) - (r.data_base64.endsWith("==") ? 2 : r.data_base64.endsWith("=") ? 1 : 0);
      return { file: f, offset, length: got, eof: offset + got >= r.size, size: r.size, data_base64: r.data_base64 };
    },
  ],
  [
    "DELETE files/:id",
    ({ params }) => {
      deleteFile(requireFile(params.id).id);
      return { removed: params.id };
    },
  ],
  ["POST slice", ({ body }) => ({ job: startSlice(body ?? {}) })],
  ["GET slice", () => ({ jobs: listJobs() })],
  ["GET slice/:job", ({ params }) => ({ job: pollSlice(params.job) })],
  [
    "POST print",
    ({ body }) => {
      const p = printerOr404(str(body?.printer_id));
      const f = requireFile(str(body?.file_id));
      const spools = Array.isArray(body?.spools) ? body.spools : null;
      const { options, plan } = withSpools(p, f, body?.options, spools);
      const job = uploadForPrint(p, f.id, "ui", options, plan?.summary);
      return { print: publicJob(body?.start === true ? startPrint(p, job) : job) };
    },
  ],
  [
    // Bambu: the file's filaments, the loaded spools and the auto-match, for
    // the send panel's spool pickers. `applicable: false` → no picker.
    "GET printers/:id/spools/:file",
    ({ params, query }) => {
      const p = printerOr404(params.id);
      const f = requireFile(params.file);
      const plan = planSpools(p, f, Math.max(1, Number(queryParam(query, "plate")) || 1));
      if (!plan) return { applicable: false };
      return {
        applicable: true,
        filaments: plan.filaments,
        matches: plan.matches.map((m) => ({ filament_id: m.filament.id, spool: m.spool, warning: m.warning ?? null })),
        choices: spoolChoices(plan.ams),
      };
    },
  ],
  ["GET prints", () => ({ prints: listPrints().map(publicJob) })],
  [
    "POST prints/:id/start",
    ({ params }) => {
      const job = getPrint(params.id);
      if (!job) throw new HttpError(404, `unknown print '${params.id}'`);
      return { print: publicJob(startPrint(printerOr404(job.printer_id), job)) };
    },
  ],
  [
    "POST prints/:id/dismiss",
    ({ params }) => {
      const job = getPrint(params.id);
      if (!job) throw new HttpError(404, `unknown print '${params.id}'`);
      return { print: publicJob(dismissPrint(job)) };
    },
  ],
  [
    "GET diagnostics",
    ({ query }) => {
      const cfg = bridgeConfig();
      const hasBambu = listPrinters().some((p) => p.type === "bambu");
      return {
        orca: orcaDiagnostics(),
        bridge_url: cfg.url,
        bridge: bridgeDiagnostics(hasBambu, queryParam(query, "bridge") === "1", defaultTransport, cfg),
        profile_roots: detectRoots(),
      };
    },
  ],
];

/// Match "METHOD pattern" against a request (path relative to API). Pure.
export function matchRoute(decl: string, method: string, rel: string): Record<string, string> | null {
  const [m, pat] = decl.split(" ");
  if (m !== method) return null;
  const ps = pat.split("/");
  const rs = rel.split("/").filter(Boolean);
  if (ps.length !== rs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(rs[i]);
    else if (ps[i] !== rs[i]) return null;
  }
  return params;
}

export function serveAuthed(payload: any): string {
  const method = up(payload?.method);
  const path = str(payload?.path);
  if (!path.startsWith(API + "/")) return jsonResponse(404, { error: "not found" });
  const rel = path.slice(API.length + 1);
  try {
    for (const [decl, handler] of ROUTES) {
      const params = matchRoute(decl, method, rel);
      if (params) {
        return jsonResponse(200, handler({ params, query: str(payload?.query), body: parseBody(str(payload?.body)) }));
      }
    }
  } catch (e) {
    return jsonResponse(e instanceof HttpError ? e.status : 400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}

/// The manifest's ui_routes, derived from ROUTES so they can't drift.
export function uiRoutes(): string[] {
  return ROUTES.map(([decl]) => {
    const [m, pat] = decl.split(" ");
    return `${m} ${API}/${pat}`;
  });
}

/// Extract and URL-decode `name`'s value from a `&`-separated query string.
export function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx) !== name) continue;
    const v = pair.slice(idx + 1);
    try {
      return decodeURIComponent(v.replace(/\+/g, "%20"));
    } catch (_e) {
      return v;
    }
  }
  return undefined;
}
