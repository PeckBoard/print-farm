// Print jobs: upload a stored file to a printer and (optionally) start it.
//
// Starting a print moves physical hardware, so an AGENT can never start one
// on its own say-so. The MCP `print_start` tool uploads the file and queues a
// print in "awaiting_confirmation"; it then asks the user through core's
// ask_user flow (a question in the agent's session). The print only starts
// when the agent calls print_start again with the confirmation token AND core's
// event log shows the user picked "Start print" (peckboard_get_answer — the
// agent cannot forge it). Without a live session (or if the user prefers),
// the queued print is started from the Print Farm page (a human click).

import { storeGet, storePut, storeList } from "./host";
import { nextSeq } from "./counter";
import { requireFile, FileRecord, FileKind } from "./storage";
import { PrinterRecord, PrinterType, StartOptions } from "./drivers/types";
import { driverFor } from "./drivers";
import { defaultTransport } from "./transport";
import { bridgeConfig } from "./config";
import { randomHex } from "./transport";

export const CONFIRM_LABEL = "Start print";
export const DECLINE_LABEL = "Don't start";

export type PrintStatus = "uploaded" | "awaiting_confirmation" | "started" | "declined" | "failed";

export interface PrintJob {
  id: string;
  printer_id: string;
  file_id: string;
  remote_name: string;
  status: PrintStatus;
  requested_by: "ui" | "agent";
  options?: StartOptions;
  /// Agent confirmations: the ask_user token (never shown to the UI).
  token?: string;
  error?: string;
}

// ── pure ────────────────────────────────────────────────────────────────────

const ACCEPTS: Record<PrinterType, FileKind[]> = {
  moonraker: ["gcode"],
  octoprint: ["gcode"],
  prusalink: ["gcode", "bgcode"],
  bambu: ["gcode.3mf"],
};

/// Throw unless the printer type can take this file kind. Pure — tested.
export function checkCompatible(type: PrinterType, kind: FileKind): void {
  if (!ACCEPTS[type].includes(kind)) {
    throw new Error(
      `a ${type} printer takes ${ACCEPTS[type].map((k) => "." + k).join(" / ")} files, not ${kind}` +
        (type === "bambu" ? " — slice for a Bambu printer profile to get a .gcode.3mf" : ""),
    );
  }
}

/// Decide what an ask_user answer means for a queued print. Pure — tested.
export function confirmationVerdict(ans: { status: string; answer?: string; rejected?: boolean }): "start" | "pending" | "declined" | "unknown" {
  if (ans.status === "pending") return "pending";
  if (ans.status !== "answered") return "unknown";
  if (ans.rejected) return "declined";
  return (ans.answer ?? "").trim() === CONFIRM_LABEL ? "start" : "declined";
}

export function publicJob(j: PrintJob): Omit<PrintJob, "token"> {
  const { token: _t, ...rest } = j;
  return rest;
}

// ── store ───────────────────────────────────────────────────────────────────

const PRINTS = "prints";

export function getPrint(id: string): PrintJob | null {
  return (storeGet(PRINTS, id) as PrintJob) ?? null;
}

export function putPrint(j: PrintJob): void {
  storePut(PRINTS, j.id, j);
}

export function listPrints(): PrintJob[] {
  return storeList(PRINTS)
    .map((i) => i.value as PrintJob)
    .filter((j) => j && j.id)
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
}

// ── actions ─────────────────────────────────────────────────────────────────

function remoteName(f: FileRecord): string {
  return f.name;
}

/// Upload a stored file to a printer and record a print job.
export function uploadForPrint(printer: PrinterRecord, fileId: string, by: "ui" | "agent", options?: StartOptions): PrintJob {
  const f = requireFile(fileId);
  if (!f.complete) throw new Error(`file ${f.id} is still uploading`);
  checkCompatible(printer.type, f.kind);
  const job: PrintJob = {
    id: "r" + nextSeq("print_seq"),
    printer_id: printer.id,
    file_id: f.id,
    remote_name: remoteName(f),
    status: "uploaded",
    requested_by: by,
  };
  if (options) job.options = options;
  try {
    driverFor(printer, defaultTransport, bridgeConfig()).upload(job.remote_name, { path: f.path });
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error).message;
    putPrint(job);
    throw e;
  }
  putPrint(job);
  return job;
}

/// Start an uploaded print. Callers must have established human intent: a UI
/// request (user authority) or a verified ask_user answer.
export function startPrint(printer: PrinterRecord, job: PrintJob): PrintJob {
  if (job.status === "started") throw new Error(`print ${job.id} was already started`);
  if (job.status === "failed" || job.status === "declined") throw new Error(`print ${job.id} is ${job.status}; queue a new one`);
  try {
    driverFor(printer, defaultTransport, bridgeConfig()).start(job.remote_name, job.options);
  } catch (e) {
    const failed: PrintJob = { ...job, status: "failed", error: (e as Error).message };
    delete failed.token;
    putPrint(failed);
    throw e;
  }
  const started: PrintJob = { ...job, status: "started" };
  delete started.token;
  putPrint(started);
  return started;
}

/// The user chose not to start a queued print (page "Dismiss"). The file stays
/// on the printer; the record leaves the queue as `declined`.
export function dismissPrint(job: PrintJob): PrintJob {
  if (job.status !== "uploaded" && job.status !== "awaiting_confirmation") {
    throw new Error(`print ${job.id} is ${job.status}, not queued`);
  }
  const next: PrintJob = { ...job, status: "declined" };
  delete next.token;
  putPrint(next);
  return next;
}

export function newToken(): string {
  return "pf-" + randomHex(16);
}
