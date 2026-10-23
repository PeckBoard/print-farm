// Moonraker (Klipper) driver — https://moonraker.readthedocs.io/en/latest/web_api/

import { Transport, HttpReq, jsonBody, expectOk } from "../transport";
import {
  PrinterDriver,
  PrinterRecord,
  PrinterStatus,
  PrinterState,
  emptyStatus,
  baseUrl,
  num,
  clamp01,
  temp,
  Snapshot,
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
  };
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
