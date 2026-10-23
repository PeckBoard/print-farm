// MCP tool handlers. Each takes the tool arguments and returns a JSON result;
// a thrown Error becomes `{error}` for the agent (see lib.ts).

import { listPrinters, resolvePrinter, redact } from "./printers";
import { driverFor } from "./drivers";
import { defaultTransport } from "./transport";
import { bridgeConfig } from "./config";
import { detectRoots, listVendors, scanProfiles, parseKind } from "./profiles";
import { importProjectFile, requireFile, newFileRecord, writeB64, putFile, listFiles, deleteFile } from "./storage";
import { startSlice, pollSlice } from "./slice";
import {
  uploadForPrint,
  startPrint,
  getPrint,
  putPrint,
  listPrints,
  publicJob,
  newToken,
  confirmationVerdict,
  CONFIRM_LABEL,
  DECLINE_LABEL,
} from "./prints";
import { askUser, getAnswer, storeGet, storePut } from "./host";
import { nextSeq } from "./counter";
import { PrinterRecord, DEVELOPER_MODE_HINT } from "./drivers/types";
import { ensureSetupQuiet, SetupView } from "./setup";
import { withSpools } from "./spools";
import { runControl, parseControl, guardControl, describeAction, validRemoteName, remoteFiles } from "./control";
import { takeCapture, publicCapture } from "./captures";

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
  const requested = args.options && typeof args.options === "object" ? args.options : undefined;
  const choices = Array.isArray(args.spools) ? args.spools : null;
  if (choices && p.type !== "bambu") throw new Error("spools only applies to Bambu printers");
  const { options, plan } = withSpools(p, f, requested, choices);
  const job = uploadForPrint(p, f.id, "agent", options, plan?.summary);
  const token = newToken();
  const queued = { ...job, status: "awaiting_confirmation" as const, token };
  putPrint(queued);
  const spoolLine = plan
    ? ` Spools: ${plan.summary}.`
    : p.type === "bambu"
      ? options?.use_ams
        ? " Spools: AMS (the printer reported no tray details)."
        : " Spool: the external spool (the printer reported no AMS)."
      : "";
  try {
    askUser(
      `Start printing "${f.name}" on ${p.name} (${p.type})?${spoolLine} This moves the printer — make sure the bed is clear.`,
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

// ── printer controls ────────────────────────────────────────────────────────────

export function printerCapabilities(args: any): unknown {
  const p = resolvePrinter(args.printer);
  return { printer: p.id, capabilities: driver(p).capabilities() };
}

export function printerDetail(args: any): unknown {
  const p = resolvePrinter(args.printer);
  return { printer: p.id, detail: driver(p).detail() };
}

export function printerErrors(args: any): unknown {
  const p = resolvePrinter(args.printer);
  const d = driver(p).detail();
  const out: Record<string, unknown> = { printer: p.id, state: d.state, message: d.message, developer_mode: d.developer_mode, errors: d.errors };
  if (d.developer_mode === false || d.errors.some((e) => /Developer Mode/.test(e.text ?? ""))) out.hint = DEVELOPER_MODE_HINT;
  return out;
}

/// Tuning that doesn't move anything: runs straight away.
function direct(body: (args: any) => Record<string, unknown>) {
  return (args: any): unknown => {
    const p = resolvePrinter(args.printer);
    const b = body(args);
    return { printer: p.id, action: b.action, ...runControl(driver(p), b) };
  };
}

export const printerSetTemperature = direct((a) => ({ action: "temp", heater: a.heater, target: a.target }));
export const printerSetFan = direct((a) => ({ action: "fan", fan: a.fan, percent: a.percent }));
export const printerSetLight = direct((a) => ({ action: "light", on: a.on }));
export const printerSetSpeed = direct((a) => ({ action: "speed", level: a.level, percent: a.percent }));

// ── human-confirmed actions (same two-phase flow as print_start) ─────────────

export const RUN_LABEL = "Yes, do it";
export const SKIP_LABEL = "No";
const ACTIONS = "pending_actions";

type ActionKind = "printer_move" | "printer_extrude" | "printer_gcode" | "printer_file_delete" | "file_delete";

interface PendingAction {
  id: string;
  kind: ActionKind;
  token: string;
  status: "awaiting_confirmation" | "done" | "declined" | "failed";
  question: string;
  printer_id?: string;
  /// printer_move / printer_extrude / printer_gcode: the control body.
  body?: Record<string, unknown>;
  /// printer_file_delete: the printer-side path; file_delete: the file id.
  target?: string;
  error?: string;
}

function publicAction(a: PendingAction): Omit<PendingAction, "token"> {
  const { token: _t, ...rest } = a;
  return rest;
}

/// Run a stored action once the user said yes.
function perform(a: PendingAction): unknown {
  switch (a.kind) {
    case "printer_file_delete": {
      const p = resolvePrinter(a.printer_id);
      driver(p).deleteFile(a.target!);
      return { removed: a.target };
    }
    case "file_delete":
      deleteFile(requireFile(a.target).id);
      return { removed: a.target };
    default:
      // Re-checked at run time: the printer may have started printing since.
      return runControl(driver(resolvePrinter(a.printer_id)), a.body);
  }
}

/// Phase 1 (`prepare` validates and words the question) or phase 2
/// (`action_id` + `confirmation_token`: run only if core's answer log shows
/// the user chose RUN_LABEL — the agent can't forge that).
function confirmed(kind: ActionKind, prepare: (args: any) => Omit<PendingAction, "id" | "kind" | "token" | "status">) {
  return (args: any): unknown => {
    if (s(args.action_id) || s(args.confirmation_token)) {
      const a = storeGet(ACTIONS, s(args.action_id)) as PendingAction | null;
      if (!a || a.kind !== kind) throw new Error(`unknown ${kind} action '${s(args.action_id)}'`);
      if (a.status !== "awaiting_confirmation" || a.token !== s(args.confirmation_token)) {
        throw new Error(`action ${a.id} is not awaiting this confirmation (status: ${a.status})`);
      }
      const verdict = confirmationVerdict(getAnswer(a.token), RUN_LABEL);
      if (verdict === "pending") return { action: publicAction(a), status: "awaiting_confirmation", message: "The user has not answered yet." };
      if (verdict !== "start") {
        storePut(ACTIONS, a.id, { ...a, status: "declined" });
        return { action: publicAction({ ...a, status: "declined" }), message: "The user did not confirm; nothing was done." };
      }
      // Mark done before running so a retried call can't run it twice.
      storePut(ACTIONS, a.id, { ...a, status: "done" });
      try {
        const result = perform(a);
        return { action: publicAction({ ...a, status: "done" }), result, message: "The user confirmed; done." };
      } catch (e) {
        storePut(ACTIONS, a.id, { ...a, status: "failed", error: (e as Error).message });
        throw e;
      }
    }
    const prepared = prepare(args);
    const a: PendingAction = { id: "a" + nextSeq("action_seq"), kind, token: newToken(), status: "awaiting_confirmation", ...prepared };
    storePut(ACTIONS, a.id, a);
    try {
      askUser(a.question, [RUN_LABEL, SKIP_LABEL], a.token);
    } catch (e) {
      storePut(ACTIONS, a.id, { ...a, status: "declined", error: (e as Error).message });
      throw new Error(`the user could not be asked here (${(e as Error).message}); ask them to do this from the Print Farm page`);
    }
    return {
      action: publicAction(a),
      status: "awaiting_confirmation",
      action_id: a.id,
      confirmation_token: a.token,
      message: `The user has been asked to confirm. After they answer, call ${kind} again with action_id and confirmation_token.`,
    };
  };
}

/// Validate a motion body now (so the user isn't asked about something that
/// can't run) and word the question.
function prepareControl(args: any, body: Record<string, unknown>) {
  const p = resolvePrinter(args.printer);
  const d = driver(p);
  const a = parseControl(body, d.capabilities());
  guardControl(a, d.status());
  return {
    printer_id: p.id,
    body,
    question: `Let the agent ${describeAction(a)} on ${p.name}? This moves the printer — make sure nothing is in the way.`,
  };
}

export const printerMove = confirmed("printer_move", (args) => {
  const action = s(args.action);
  if (action !== "home" && action !== "jog" && action !== "motors_off") throw new Error("action must be home, jog or motors_off");
  return prepareControl(args, { action, axis: args.axis, distance: args.distance });
});

export const printerExtrude = confirmed("printer_extrude", (args) => {
  const action = s(args.action);
  const mm = Number(args.mm);
  if (action === "extrude") return prepareControl(args, { action: "extrude", mm: Math.abs(mm) });
  if (action === "retract") return prepareControl(args, { action: "extrude", mm: -Math.abs(mm) });
  if (action === "load") return prepareControl(args, { action: "load", slot: args.slot });
  if (action === "unload") return prepareControl(args, { action: "unload" });
  throw new Error("action must be extrude, retract, load or unload");
});

export const printerGcode = confirmed("printer_gcode", (args) => prepareControl(args, { action: "gcode", line: args.line }));

export const printerFileDelete = confirmed("printer_file_delete", (args) => {
  const p = resolvePrinter(args.printer);
  const name = s(args.name);
  if (!validRemoteName(name)) throw new Error("invalid file name");
  if (!driver(p).capabilities().files) throw new Error("this printer's storage can't be managed");
  return { printer_id: p.id, target: name, question: `Delete "${name}" from ${p.name}'s storage? This can't be undone.` };
});

export const fileDelete = confirmed("file_delete", (args) => {
  const f = requireFile(s(args.file_id));
  return { target: f.id, question: `Delete "${f.name}" from Print Farm storage? This can't be undone.` };
});

// ── listings + camera ───────────────────────────────────────────────────────────────

export function printerFiles(args: any): unknown {
  const p = resolvePrinter(args.printer);
  return { printer: p.id, files: remoteFiles(driver(p)) };
}

export function printList(): unknown {
  return { prints: listPrints().map(publicJob) };
}

export function fileList(): unknown {
  return { files: listFiles().map(({ path: _p, ...rest }) => rest) };
}

export function cameraCapture(args: any): unknown {
  const p = resolvePrinter(args.printer);
  const { capture, data_base64 } = takeCapture(p);
  return { printer: p.id, capture: publicCapture(capture), content_type: capture.content_type, data_base64 };
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
  printer_capabilities: printerCapabilities,
  printer_detail: printerDetail,
  printer_errors: printerErrors,
  printer_set_temperature: printerSetTemperature,
  printer_set_fan: printerSetFan,
  printer_set_light: printerSetLight,
  printer_set_speed: printerSetSpeed,
  printer_move: printerMove,
  printer_extrude: printerExtrude,
  printer_gcode: printerGcode,
  printer_file_delete: printerFileDelete,
  printer_files: printerFiles,
  print_list: printList,
  file_list: fileList,
  file_delete: fileDelete,
  camera_capture: cameraCapture,
};
