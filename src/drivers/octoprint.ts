// OctoPrint driver — https://docs.octoprint.org/en/master/api/

import { Transport, HttpReq, jsonBody, expectOk } from "../transport";
import {
  PrinterDriver,
  PrinterRecord,
  PrinterStatus,
  Capabilities,
  ControlAction,
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
} from "./types";
import { gcodeFor } from "./moonraker";

/// Map `/api/job` + `/api/printer` (null when 409 — printer not connected)
/// onto the normalised status. Pure.
export function octoprintStatus(job: any, printer: any | null): PrinterStatus {
  if (!printer) {
    return emptyStatus("offline", typeof job?.state === "string" ? job.state : "printer not connected");
  }
  const flags = printer.state?.flags ?? {};
  const text: string = printer.state?.text ?? job?.state ?? "";
  const completion = num(job?.progress?.completion);
  let state: PrinterStatus["state"] = "idle";
  if (flags.error || flags.closedOrError) state = flags.closedOrError && !flags.error ? "offline" : "error";
  else if (flags.paused || flags.pausing) state = "paused";
  else if (flags.printing || flags.cancelling || flags.finishing) state = "printing";
  else if (completion !== null && completion >= 100) state = "finished";

  const st = emptyStatus(state, state === "error" || state === "offline" ? text || null : null);
  st.file = job?.job?.file?.name ?? job?.job?.file?.display ?? null;
  st.progress = state === "finished" ? 1 : clamp01((completion ?? 0) / 100);
  st.elapsed_s = num(job?.progress?.printTime);
  st.eta_s = state === "printing" || state === "paused" ? num(job?.progress?.printTimeLeft) : null;
  const tt = printer.temperature ?? {};
  const nozzle = temp(tt.tool0?.actual, tt.tool0?.target);
  const bed = temp(tt.bed?.actual, tt.bed?.target);
  if (nozzle) st.temps.nozzle = nozzle;
  if (bed) st.temps.bed = bed;
  if (tt.chamber && num(tt.chamber.actual) !== null) {
    st.temps.chamber = { actual: tt.chamber.actual, target: num(tt.chamber.target) };
  }
  return st;
}

/// Pick the snapshot URL out of `/api/settings` (classic webcam plugin on
/// OctoPrint ≥1.9, legacy `webcam.snapshotUrl` before). Pure.
export function octoprintSnapshotUrl(settings: any): string | null {
  const u =
    settings?.plugins?.classicwebcam?.snapshot ??
    settings?.webcam?.snapshotUrl ??
    null;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

/// OctoPrint reports the snapshot URL as seen from its own host — often
/// `http://127.0.0.1:8080/...`. Re-point loopback hosts at the printer host.
export function rebaseSnapshotUrl(base: string, u: string): string {
  const origin = /^(https?):\/\/([^/:]+|\[[^\]]+\])/i.exec(base);
  if (!/^https?:\/\//i.test(u)) {
    const o = /^(https?:\/\/[^/]+)/i.exec(base)?.[1] ?? base;
    return o + (u.startsWith("/") ? u : "/" + u);
  }
  if (origin) {
    return u.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])/i, `$1${origin[2]}`);
  }
  return u;
}

export function octoprintDriver(p: PrinterRecord, t: Transport): PrinterDriver {
  const base = baseUrl(p, 80);
  const headers: Record<string, string> = p.api_key ? { "X-Api-Key": p.api_key } : {};
  const req = (r: Omit<HttpReq, "url"> & { path: string }) => {
    const { path, ...rest } = r;
    return t.request({ ...rest, url: base + path, headers: { ...headers, ...(rest.headers ?? {}) }, insecure: p.tls_insecure });
  };
  const command = (path: string, body: unknown, what: string) => {
    expectOk(
      req({ method: "POST", path, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutSecs: 15 }),
      what,
    );
  };

  return {
    status() {
      try {
        const jr = req({ method: "GET", path: "/api/job", timeoutSecs: 8 });
        if (jr.status === 401 || jr.status === 403) return emptyStatus("offline", "unauthorized — check the API key");
        expectOk(jr, "octoprint /api/job");
        const job = jsonBody(jr, "octoprint job");
        const pr = req({ method: "GET", path: "/api/printer", timeoutSecs: 8 });
        const printer = pr.status === 409 ? null : jsonBody(expectOk(pr, "octoprint /api/printer"), "octoprint printer");
        return octoprintStatus(job, printer);
      } catch (e) {
        return emptyStatus("offline", (e as Error).message);
      }
    },
    upload(name, src) {
      expectOk(
        req({
          method: "POST",
          path: "/api/files/local",
          form: { fields: { select: "false", print: "false" }, file: { field: "file", path: src.path, filename: name } },
          timeoutSecs: 300,
        }),
        "octoprint upload",
      );
    },
    start(file) {
      command(`/api/files/local/${encPath(file)}`, { command: "select", print: true }, "octoprint start");
    },
    pause() {
      command("/api/job", { command: "pause", action: "pause" }, "octoprint pause");
    },
    resume() {
      command("/api/job", { command: "pause", action: "resume" }, "octoprint resume");
    },
    cancel() {
      command("/api/job", { command: "cancel" }, "octoprint cancel");
    },
    snapshot(): Snapshot | null {
      const sr = req({ method: "GET", path: "/api/settings", timeoutSecs: 8 });
      if (sr.status < 200 || sr.status >= 300) return null;
      const url = octoprintSnapshotUrl(jsonBody(sr, "octoprint settings"));
      if (!url) return null;
      const img = t.request({
        method: "GET",
        url: rebaseSnapshotUrl(base, url),
        binaryResponse: true,
        insecure: p.tls_insecure,
        timeoutSecs: 10,
      });
      if (img.status < 200 || img.status >= 300 || !img.bodyBase64) return null;
      return { content_type: img.contentType || "image/jpeg", data_base64: img.bodyBase64 };
    },
    test() {
      try {
        const r = req({ method: "GET", path: "/api/version", timeoutSecs: 8 });
        if (r.status === 401 || r.status === 403) return { ok: false, detail: "unauthorized — check the API key" };
        expectOk(r, "octoprint /api/version");
        const v = jsonBody(r, "octoprint version");
        return { ok: true, detail: `OctoPrint ${v.server ?? v.text ?? ""}`.trim() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    capabilities() {
      return octoprintCapabilities();
    },
    detail() {
      return detailFrom(this.status());
    },
    control(a) {
      const r = octoprintRequest(a);
      command(r.path, r.body, `octoprint ${a.action}`);
      return { ok: true };
    },
    files() {
      const r = expectOk(req({ method: "GET", path: "/api/files/local?recursive=true", timeoutSecs: 15 }), "octoprint files");
      return flattenOctoprintFiles(jsonBody(r, "octoprint files").files);
    },
    deleteFile(name) {
      expectOk(req({ method: "DELETE", path: `/api/files/local/${encPath(name)}`, timeoutSecs: 15 }), "octoprint delete");
    },
  };
}

export function octoprintCapabilities(): Capabilities {
  const caps = noCapabilities();
  caps.job = { pause: true, resume: true, stop: true, speed_levels: false, speed_percent: true };
  caps.temps = { nozzle: { max: 300 }, bed: { max: 120 }, chamber: null };
  caps.motion = true;
  caps.extrude = true;
  caps.fans = ["part"];
  caps.files = true;
  caps.gcode = true;
  caps.camera = true;
  return caps;
}

/// A validated action → the OctoPrint REST call. Pure.
export function octoprintRequest(a: ControlAction): { path: string; body: Record<string, unknown> } {
  switch (a.action) {
    case "pause":
      return { path: "/api/job", body: { command: "pause", action: "pause" } };
    case "resume":
      return { path: "/api/job", body: { command: "pause", action: "resume" } };
    case "stop":
      return { path: "/api/job", body: { command: "cancel" } };
    case "home":
      return { path: "/api/printer/printhead", body: { command: "home", axes: ["x", "y", "z"] } };
    case "jog":
      return { path: "/api/printer/printhead", body: { command: "jog", [a.axis]: a.distance } };
    case "temp":
      return a.heater === "bed"
        ? { path: "/api/printer/bed", body: { command: "target", target: a.target } }
        : { path: "/api/printer/tool", body: { command: "target", targets: { tool0: a.target } } };
    case "extrude":
      return { path: "/api/printer/tool", body: { command: "extrude", amount: a.mm } };
    default:
      // speed / fan / motors_off / gcode go through the raw command API.
      return { path: "/api/printer/command", body: { commands: gcodeFor(a).split("\n") } };
  }
}

/// `/api/files/local?recursive=true` → flat machine-code files. Pure.
export function flattenOctoprintFiles(entries: any): RemoteFile[] {
  const out: RemoteFile[] = [];
  const walk = (list: any) => {
    for (const e of Array.isArray(list) ? list : []) {
      if (e?.type === "folder") walk(e.children);
      else if (typeof e?.path === "string" || typeof e?.name === "string") {
        out.push({ name: e.path ?? e.name, size: num(e.size) ?? 0, mtime: num(e.date) });
      }
    }
  };
  walk(entries);
  return out;
}
