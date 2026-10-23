// PrusaLink v1 driver (MK4 / XL / MINI / Core One firmware) —
// https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
//
// Auth: HTTP Digest (username default "maker" + the password from the
// printer's settings screen) or, on older builds, X-Api-Key.

import { Transport, HttpReq, jsonBody, expectOk } from "../transport";
import {
  PrinterDriver,
  PrinterRecord,
  PrinterStatus,
  PrinterState,
  RemoteFile,
  emptyStatus,
  baseUrl,
  num,
  clamp01,
  temp,
  Snapshot,
  encPath,
  detailFrom,
  noCapabilities,
  unsupported,
} from "./types";

const STATE_MAP: Record<string, PrinterState> = {
  IDLE: "idle",
  READY: "idle",
  STOPPED: "idle",
  BUSY: "idle",
  PRINTING: "printing",
  PAUSED: "paused",
  FINISHED: "finished",
  ERROR: "error",
  ATTENTION: "error",
};

/// Map `/api/v1/status` (+ optional `/api/v1/job`) onto the normalised status. Pure.
export function prusalinkStatus(status: any, job: any | null): PrinterStatus {
  const pr = status?.printer ?? {};
  const raw = String(pr.state ?? "").toUpperCase();
  const state = STATE_MAP[raw] ?? "idle";
  const message =
    raw === "ATTENTION" ? "printer needs attention (check its screen)" : raw === "BUSY" ? "printer busy" : raw === "ERROR" ? "printer error" : null;
  const st = emptyStatus(state, message);
  const sj = status?.job ?? {};
  const progress = num(job?.progress) ?? num(sj.progress);
  st.progress = state === "finished" ? 1 : clamp01((progress ?? 0) / 100);
  st.elapsed_s = num(job?.time_printing) ?? num(sj.time_printing);
  st.eta_s = state === "printing" || state === "paused" ? num(job?.time_remaining) ?? num(sj.time_remaining) : null;
  st.file = job?.file?.display_name ?? job?.file?.name ?? null;
  const nozzle = temp(pr.temp_nozzle, pr.target_nozzle);
  const bed = temp(pr.temp_bed, pr.target_bed);
  if (nozzle) st.temps.nozzle = nozzle;
  if (bed) st.temps.bed = bed;
  if (num(pr.temp_chamber) !== null) st.temps.chamber = { actual: pr.temp_chamber, target: num(pr.target_chamber) };
  return st;
}

export function prusalinkDriver(p: PrinterRecord, t: Transport): PrinterDriver {
  const base = baseUrl(p, 80);
  const storage = (p.storage || "usb").replace(/[^a-zA-Z0-9_-]/g, "");
  const auth: Partial<HttpReq> = p.password
    ? { digest: { user: p.username || "maker", pass: p.password } }
    : p.api_key
      ? { headers: { "X-Api-Key": p.api_key } }
      : {};
  const req = (r: Omit<HttpReq, "url"> & { path: string }) => {
    const { path, ...rest } = r;
    return t.request({
      ...auth,
      ...rest,
      url: base + path,
      headers: { ...(auth.headers ?? {}), ...(rest.headers ?? {}) },
      insecure: p.tls_insecure,
    });
  };
  const jobId = (): number => {
    const r = expectOk(req({ method: "GET", path: "/api/v1/status", timeoutSecs: 8 }), "prusalink status");
    const id = num(jsonBody(r, "prusalink status").job?.id);
    if (id === null) throw new Error("no active job on this printer");
    return id;
  };

  return {
    status() {
      try {
        const r = req({ method: "GET", path: "/api/v1/status", timeoutSecs: 8 });
        if (r.status === 401 || r.status === 403) return emptyStatus("offline", "unauthorized — check the credentials");
        const status = jsonBody(expectOk(r, "prusalink status"), "prusalink status");
        let job: any = null;
        if (status?.job?.id !== undefined) {
          const jr = req({ method: "GET", path: "/api/v1/job", timeoutSecs: 8 });
          if (jr.status === 200) job = jsonBody(jr, "prusalink job");
        }
        return prusalinkStatus(status, job);
      } catch (e) {
        return emptyStatus("offline", (e as Error).message);
      }
    },
    upload(name, src) {
      expectOk(
        req({
          method: "PUT",
          path: `/api/v1/files/${storage}/${encPath(name)}`,
          headers: {
            "Content-Type": name.toLowerCase().endsWith(".bgcode") ? "application/octet-stream" : "text/x.gcode",
            Overwrite: "?1",
            "Print-After-Upload": "?0",
          },
          bodyFile: src.path,
          timeoutSecs: 300,
        }),
        "prusalink upload",
      );
    },
    start(file) {
      expectOk(req({ method: "POST", path: `/api/v1/files/${storage}/${encPath(file)}`, timeoutSecs: 15 }), "prusalink start");
    },
    pause() {
      expectOk(req({ method: "PUT", path: `/api/v1/job/${jobId()}/pause`, timeoutSecs: 15 }), "prusalink pause");
    },
    resume() {
      expectOk(req({ method: "PUT", path: `/api/v1/job/${jobId()}/resume`, timeoutSecs: 15 }), "prusalink resume");
    },
    cancel() {
      expectOk(req({ method: "DELETE", path: `/api/v1/job/${jobId()}`, timeoutSecs: 15 }), "prusalink cancel");
    },
    snapshot(): Snapshot | null {
      const img = req({ method: "GET", path: "/api/v1/cameras/snap", binaryResponse: true, timeoutSecs: 10 });
      if (img.status !== 200 || !img.bodyBase64) return null;
      return { content_type: img.contentType || "image/png", data_base64: img.bodyBase64 };
    },
    test() {
      try {
        const r = req({ method: "GET", path: "/api/version", timeoutSecs: 8 });
        if (r.status === 401 || r.status === 403) return { ok: false, detail: "unauthorized — check the credentials" };
        expectOk(r, "prusalink /api/version");
        const v = jsonBody(r, "prusalink version");
        return { ok: true, detail: `PrusaLink ${v.server ?? v.api ?? ""} ${v.hostname ?? ""}`.trim() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    capabilities() {
      const caps = noCapabilities();
      caps.job = { pause: true, resume: true, stop: true, speed_levels: false, speed_percent: false };
      caps.files = true;
      caps.camera = true;
      return caps;
    },
    detail() {
      return detailFrom(this.status());
    },
    control(a) {
      if (a.action === "pause") this.pause();
      else if (a.action === "resume") this.resume();
      else if (a.action === "stop") this.cancel();
      else throw unsupported(a.action);
      return { ok: true };
    },
    files() {
      const r = expectOk(req({ method: "GET", path: `/api/v1/files/${storage}`, timeoutSecs: 15 }), "prusalink files");
      return prusalinkFiles(jsonBody(r, "prusalink files"));
    },
    deleteFile(name) {
      expectOk(req({ method: "DELETE", path: `/api/v1/files/${storage}/${encPath(name)}`, timeoutSecs: 15 }), "prusalink delete");
    },
  };
}

/// `/api/v1/files/{storage}` → the printable files at its top level. Pure.
export function prusalinkFiles(body: any): RemoteFile[] {
  const list: any[] = Array.isArray(body?.children) ? body.children : [];
  return list
    .filter((e) => typeof e?.name === "string" && e.type !== "FOLDER")
    .map((e) => ({ name: e.name, size: num(e.size) ?? 0, mtime: num(e.m_timestamp) }));
}
