// Moonraker (Klipper) driver — https://moonraker.readthedocs.io/en/latest/web_api/

import { Transport, HttpReq, jsonBody, expectOk } from "../transport";
import {
  PrinterDriver,
  PrinterRecord,
  PrinterStatus,
  PrinterState,
  PrinterDetail,
  Capabilities,
  ControlAction,
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
  standby: "idle",
  printing: "printing",
  paused: "paused",
  complete: "finished",
  cancelled: "idle",
  error: "error",
};

const QUERY = "print_stats&virtual_sdcard&display_status&extruder&heater_bed";

/// Map a `/printer/objects/query` result onto the normalised status. Pure.
export function moonrakerStatus(result: any, chamber?: any): PrinterStatus {
  const s = result?.status ?? {};
  const ps = s.print_stats ?? {};
  const state = STATE_MAP[String(ps.state ?? "")] ?? "idle";
  const st = emptyStatus(state, typeof ps.message === "string" && ps.message ? ps.message : null);
  const progress = num(s.virtual_sdcard?.progress) ?? num(s.display_status?.progress) ?? 0;
  st.progress = state === "finished" ? 1 : clamp01(progress);
  st.file = typeof ps.filename === "string" && ps.filename ? ps.filename : null;
  const elapsed = num(ps.print_duration);
  st.elapsed_s = elapsed !== null && (state === "printing" || state === "paused" || state === "finished") ? Math.round(elapsed) : null;
  if (state === "printing" || state === "paused") {
    if (elapsed !== null && st.progress > 0.001) {
      st.eta_s = Math.max(0, Math.round(elapsed / st.progress - elapsed));
    }
  }
  st.layer = num(ps.info?.current_layer);
  st.total_layers = num(ps.info?.total_layer);
  const nozzle = temp(s.extruder?.temperature, s.extruder?.target);
  const bed = temp(s.heater_bed?.temperature, s.heater_bed?.target);
  if (nozzle) st.temps.nozzle = nozzle;
  if (bed) st.temps.bed = bed;
  if (chamber && num(chamber.temperature) !== null) {
    st.temps.chamber = { actual: chamber.temperature, target: num(chamber.target) };
  }
  return st;
}

export function moonrakerDriver(p: PrinterRecord, t: Transport): PrinterDriver {
  const base = baseUrl(p, 7125);
  const headers: Record<string, string> = p.api_key ? { "X-Api-Key": p.api_key } : {};
  const req = (r: Omit<HttpReq, "url"> & { path: string }) => {
    const { path, ...rest } = r;
    return t.request({ ...rest, url: base + path, headers: { ...headers, ...(rest.headers ?? {}) }, insecure: p.tls_insecure });
  };
  const post = (path: string, what: string) => {
    expectOk(req({ method: "POST", path, timeoutSecs: 15 }), what);
  };

  return {
    status(): PrinterStatus {
      let res;
      try {
        res = req({ method: "GET", path: `/printer/objects/query?${QUERY}`, timeoutSecs: 8 });
      } catch (e) {
        return emptyStatus("offline", (e as Error).message);
      }
      if (res.status === 503) {
        // Moonraker up but Klippy not ready (shutdown / disconnected MCU).
        const body = safeJson(res.body);
        return emptyStatus("error", body?.error?.message ?? "Klippy not ready");
      }
      if (res.status < 200 || res.status >= 300) {
        return emptyStatus("offline", `HTTP ${res.status}`);
      }
      return moonrakerStatus(jsonBody(res, "moonraker status").result);
    },
    upload(name, src) {
      expectOk(
        req({
          method: "POST",
          path: "/server/files/upload",
          form: { fields: { root: "gcodes" }, file: { field: "file", path: src.path, filename: name } },
          timeoutSecs: 300,
        }),
        "moonraker upload",
      );
    },
    start(file) {
      post(`/printer/print/start?filename=${encodeURIComponent(file)}`, "moonraker start");
    },
    pause() {
      post("/printer/print/pause", "moonraker pause");
    },
    resume() {
      post("/printer/print/resume", "moonraker resume");
    },
    cancel() {
      post("/printer/print/cancel", "moonraker cancel");
    },
    snapshot(): Snapshot | null {
      const list = req({ method: "GET", path: "/server/webcams/list", timeoutSecs: 8 });
      if (list.status < 200 || list.status >= 300) return null;
      const cams: any[] = jsonBody(list, "moonraker webcams").result?.webcams ?? [];
      const cam = cams.find((c) => c && c.enabled !== false && c.snapshot_url) ?? null;
      if (!cam) return null;
      const url = absoluteUrl(base, String(cam.snapshot_url));
      const img = t.request({ method: "GET", url, headers, binaryResponse: true, insecure: p.tls_insecure, timeoutSecs: 10 });
      if (img.status < 200 || img.status >= 300 || !img.bodyBase64) return null;
      return { content_type: img.contentType || "image/jpeg", data_base64: img.bodyBase64 };
    },
    test() {
      try {
        const res = req({ method: "GET", path: "/server/info", timeoutSecs: 8 });
        if (res.status === 401 || res.status === 403) return { ok: false, detail: "unauthorized — check the API key" };
        expectOk(res, "moonraker /server/info");
        const info = jsonBody(res, "moonraker info").result ?? {};
        return { ok: true, detail: `Moonraker ${info.moonraker_version ?? ""}, Klippy ${info.klippy_state ?? "unknown"}`.trim() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    capabilities() {
      return moonrakerCapabilities();
    },
    detail() {
      let res;
      try {
        res = req({ method: "GET", path: `/printer/objects/query?${QUERY}&gcode_move&fan`, timeoutSecs: 8 });
      } catch (e) {
        return detailFrom(emptyStatus("offline", (e as Error).message));
      }
      if (res.status < 200 || res.status >= 300) return detailFrom(emptyStatus("offline", `HTTP ${res.status}`));
      return moonrakerDetail(jsonBody(res, "moonraker status").result);
    },
    control(a) {
      if (a.action === "pause") post("/printer/print/pause", "moonraker pause");
      else if (a.action === "resume") post("/printer/print/resume", "moonraker resume");
      else if (a.action === "stop") post("/printer/print/cancel", "moonraker cancel");
      else post(`/printer/gcode/script?script=${encodeURIComponent(gcodeFor(a))}`, `moonraker ${a.action}`);
      return { ok: true };
    },
    files() {
      const r = expectOk(req({ method: "GET", path: "/server/files/list?root=gcodes", timeoutSecs: 15 }), "moonraker files");
      const list: any[] = jsonBody(r, "moonraker files").result ?? [];
      return list
        .filter((f) => typeof f?.path === "string")
        .map((f) => ({ name: f.path, size: num(f.size) ?? 0, mtime: num(f.modified) !== null ? Math.round(f.modified) : null }));
    },
    deleteFile(name) {
      expectOk(req({ method: "DELETE", path: `/server/files/gcodes/${encPath(name)}`, timeoutSecs: 15 }), "moonraker delete");
    },
  };
}

export function moonrakerCapabilities(): Capabilities {
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

/// Status + speed factor and part-fan speed from the same query. Pure.
export function moonrakerDetail(result: any): PrinterDetail {
  const d = detailFrom(moonrakerStatus(result));
  const s = result?.status ?? {};
  const factor = num(s.gcode_move?.speed_factor);
  if (factor !== null) d.speed_percent = Math.round(factor * 100);
  const fan = num(s.fan?.speed);
  if (fan !== null) d.fans.part = Math.round(fan * 100);
  return d;
}

/// G-code for a (validated) non-job action; shared with OctoPrint. Pure.
export function gcodeFor(a: ControlAction): string {
  switch (a.action) {
    case "speed":
      return `M220 S${a.percent ?? 100}`;
    case "temp":
      return a.heater === "bed" ? `M140 S${a.target}` : `M104 S${a.target}`;
    case "fan":
      return `M106 S${Math.round((a.percent * 255) / 100)}`;
    case "home":
      return "G28";
    case "jog": {
      const feed = a.axis === "z" ? 600 : 3000;
      return `G91\nG1 ${a.axis.toUpperCase()}${a.distance} F${feed}\nG90`;
    }
    case "motors_off":
      return "M18";
    case "extrude":
      return `M83\nG1 E${a.mm} F300`;
    case "gcode":
      return a.line;
    default:
      throw unsupported(a.action);
  }
}

/// Resolve a webcam URL that may be relative to the printer host.
export function absoluteUrl(base: string, u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  const origin = /^(https?:\/\/[^/]+)/i.exec(base)?.[1] ?? base;
  // Webcam streams are served by the web frontend (port 80), not Moonraker's
  // API port: strip the API port for host-relative paths.
  const host = origin.replace(/:7125$/, "");
  return host + (u.startsWith("/") ? u : "/" + u);
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch (_e) {
    return null;
  }
}
