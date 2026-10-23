// MCP tool handlers. Each takes the tool arguments and returns a JSON result;
// a thrown Error becomes `{error}` for the agent (see lib.ts).

import { listPrinters, resolvePrinter, redact } from "./printers";
import { driverFor } from "./drivers";
import { defaultTransport } from "./transport";
import { bridgeConfig } from "./config";
import { detectRoots, listVendors, scanProfiles, parseKind } from "./profiles";
import { importProjectFile, requireFile, newFileRecord, writeB64, putFile } from "./storage";
import { startSlice, pollSlice } from "./slice";
import {
  uploadForPrint,
  startPrint,
  getPrint,
  putPrint,
  publicJob,
  newToken,
  confirmationVerdict,
  CONFIRM_LABEL,
  DECLINE_LABEL,
} from "./prints";
import { askUser, getAnswer } from "./host";
import { PrinterRecord } from "./drivers/types";
import { ensureSetupQuiet, SetupView } from "./setup";

/// A one-line note for an agent while an automatic install runs/failed.
function setupNote(what: string, v: SetupView | null | undefined): string | null {
  if (!v || v.status === "ok") return null;
  if (v.status === "running") return `${what} is being installed automatically (${v.phase ?? "starting"}); try again in a few minutes.`;
  return `${what} could not be installed automatically: ${v.error ?? "unknown error"}. The user can press Retry on the Print Farm page.`;
}

function driver(p: PrinterRecord) {
  return driverFor(p, defaultTransport, bridgeConfig());
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function printerList(): unknown {
  return { printers: listPrinters().map(redact) };
}

export function printerStatus(args: any): unknown {
  const setup = ensureSetupQuiet();
  const note = setupNote("print-bridge", setup?.bridge);
  if (s(args.printer)) {
    const p = resolvePrinter(args.printer);
    return { id: p.id, name: p.name, status: driver(p).status(), ...(note && p.type === "bambu" ? { setup: note } : {}) };
  }
  return { printers: listPrinters().map((p) => ({ id: p.id, name: p.name, type: p.type, status: driver(p).status() })), ...(note ? { setup: note } : {}) };
}

export function profileList(args: any): unknown {
  const note = setupNote("OrcaSlicer", ensureSetupQuiet()?.orca);
  const roots = detectRoots();
  if (!roots.length) return { roots, vendors: [], hint: note ?? "no OrcaSlicer profiles yet; Print Farm installs them automatically — try again shortly" };
  if (!s(args.kind) || !s(args.vendor)) return { roots, vendors: listVendors(roots) };
  const kind = parseKind(args.kind);
  const q = s(args.query).toLowerCase();
  const all = scanProfiles(roots, s(args.vendor), kind).filter((e) => e.instantiable);
  const hits = all.filter((e) => !q || e.name.toLowerCase().includes(q)).map((e) => e.name).sort();
  return { kind, vendor: s(args.vendor), total: hits.length, profiles: hits.slice(0, 200), truncated: hits.length > 200 };
}

export function sliceModel(args: any): unknown {
  const note = setupNote("OrcaSlicer", ensureSetupQuiet()?.orca);
  if (note) throw new Error(note);
  let fileId = s(args.file_id);
  if (!fileId) {
    if (!s(args.path)) throw new Error("pass file_id (an uploaded file) or path (relative to the project folder)");
    fileId = importProjectFile(s(args.path)).id;
  }
  const printer = s(args.printer) ? resolvePrinter(args.printer) : null;
  const job = startSlice({
    file_id: fileId,
    printer_id: printer?.id,
    printer_profile: s(args.printer_profile) || undefined,
    filament_profile: s(args.filament_profile) || undefined,
    process_profile: s(args.process_profile) || undefined,
    vendor: s(args.vendor) || undefined,
    arrange: args.arrange !== false,
    orient: args.orient === true,
  });
  return {
    job_id: job.id,
    status: job.status,
    target: job.target,
    message: "Slicing in the background. Poll slice_status with job_id until status is succeeded or failed.",
  };
}

export function sliceStatus(args: any): unknown {
  const job = pollSlice(s(args.job_id));
  const { dir: _d, pid: _p, command: _c, ...rest } = job;
  return rest;
}

export function printUpload(args: any): unknown {
  const p = resolvePrinter(args.printer);
  const job = uploadForPrint(p, s(args.file_id), "agent");
  return { print: publicJob(job), message: "Uploaded. Nothing is printing — use print_start to request a start." };
}

export function printStart(args: any): unknown {
  // Phase 2: the agent comes back after the user answered.
  if (s(args.print_id) && s(args.confirmation_token)) {
    const job = getPrint(s(args.print_id));
    if (!job) throw new Error(`unknown print '${s(args.print_id)}'`);
    if (job.status !== "awaiting_confirmation" || !job.token || job.token !== s(args.confirmation_token)) {
      throw new Error(`print ${job.id} is not awaiting this confirmation (status: ${job.status})`);
    }
    const verdict = confirmationVerdict(getAnswer(job.token));
    if (verdict === "pending") return { print: publicJob(job), status: "awaiting_confirmation", message: "The user has not answered yet." };
    if (verdict === "start") {
      const started = startPrint(resolvePrinter(job.printer_id), job);
      return { print: publicJob(started), message: "The user confirmed; the print has started." };
    }
    const declined = { ...job, status: "declined" as const };
    delete declined.token;
    putPrint(declined);
    return { print: publicJob(declined), message: "The user did not confirm; the print was NOT started." };
  }

  // Phase 1: upload + queue + ask.
  const p = resolvePrinter(args.printer);
  const f = requireFile(s(args.file_id));
  const options = args.options && typeof args.options === "object" ? args.options : undefined;
  const job = uploadForPrint(p, f.id, "agent", options);
  const token = newToken();
  const queued = { ...job, status: "awaiting_confirmation" as const, token };
  putPrint(queued);
  try {
    askUser(
      `Start printing "${f.name}" on ${p.name} (${p.type})? This moves the printer — make sure the bed is clear.`,
      [CONFIRM_LABEL, DECLINE_LABEL],
      token,
    );
  } catch (e) {
    return {
      print: publicJob(queued),
      status: "awaiting_confirmation",
      message:
        `Uploaded and queued, but the user could not be asked here (${(e as Error).message}). ` +
        "The user must press Start on this print in the Print Farm page.",
    };
  }
  return {
    print: publicJob(queued),
    status: "awaiting_confirmation",
    confirmation_token: token,
    message:
      "Uploaded and queued. The user has been asked to confirm. After they answer, call print_start again " +
      "with print_id and confirmation_token. The user can also start it from the Print Farm page.",
  };
}

export function printControl(args: any): unknown {
  const p = resolvePrinter(args.printer);
  const action = s(args.action);
  const d = driver(p);
  if (action === "pause") d.pause();
  else if (action === "cancel") d.cancel();
  else if (action === "resume") {
    throw new Error("resume moves the printer and needs a human: ask the user to resume from the Print Farm page");
  } else throw new Error("action must be pause or cancel (resume is UI-only)");
  return { ok: true, printer: p.id, action };
}

export function printSnapshot(args: any): unknown {
  const p = resolvePrinter(args.printer);
  const snap = driver(p).snapshot();
  if (!snap) return { printer: p.id, camera: false };
  const ext = /png/.test(snap.content_type) ? "png" : "jpg";
  const rec = newFileRecord(`snapshot-${p.id}.${ext}`, "snapshot");
  const size = writeB64(rec.path, snap.data_base64, true);
  const saved = { ...rec, size, complete: true };
  putFile(saved);
  const out: Record<string, unknown> = { printer: p.id, camera: true, content_type: snap.content_type, file_id: saved.id, size };
  if (args.include_data === true) out.data_base64 = snap.data_base64;
  return out;
}

export const TOOLS: Record<string, (args: any) => unknown> = {
  printer_list: printerList,
  printer_status: printerStatus,
  profile_list: profileList,
  slice_model: sliceModel,
  slice_status: sliceStatus,
  print_upload: printUpload,
  print_start: printStart,
  print_control: printControl,
  print_snapshot: printSnapshot,
};
