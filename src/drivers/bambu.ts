// Bambu Lab driver — talks to the local print-bridge sidecar (MQTT + FTPS to
// the printer live there). Contract: JSON, `Authorization: Bearer <token>`.
//   GET  /health                       → {ok, version}
//   PUT  /printers/{id}                {host, serial, access_code, model?}
//   DELETE /printers/{id}
//   GET  /printers/{id}/status         → normalised status
//   POST /printers/{id}/upload?name=   raw body → {ok}
//   POST /printers/{id}/start          {file, plate?, use_ams?, bed_leveling?, ams_mapping?}
//   POST /printers/{id}/pause | /resume | /stop
//   GET  /printers/{id}/snapshot       → image/jpeg (404 = no camera)
//   POST /printers/{id}/command        {type, ...} (bridge >= 0.1.7) → {ok, confirmed}
//   GET  /printers/{id}/files          → {files:[{name,size,mtime}]}
//   DELETE /printers/{id}/files?name=
// Commands wait for the printer's reply: 409 + needs_developer_mode when the
// printer refuses unsigned MQTT commands (LAN Only + Developer Mode off).

import { Transport, HttpReq, HttpRes, jsonBody, expectOk } from "../transport";
import { base64ToUtf8 } from "../b64";
import {
  PrinterDriver,
  PrinterRecord,
  PrinterStatus,
  emptyStatus,
  num,
  clamp01,
  Snapshot,
  StartOptions,
  PrinterState,
  PrinterDetail,
  PrinterError,
  Capabilities,
  ControlAction,
  ControlResult,
  DriverError,
  DEVELOPER_MODE_HINT,
  FanName,
  detailFrom,
  noCapabilities,
  unsupported,
} from "./types";
import { coerceAms } from "../ams";

function safeJson(s: string): any {
  try {
    return s ? JSON.parse(s) : null;
  } catch (_e) {
    return null;
  }
}

export interface BridgeConfig {
  url: string;
  token: string;
}

const STATES: PrinterState[] = ["idle", "printing", "paused", "finished", "error", "offline"];

/// Coerce the sidecar's status into the normalised shape (defensive: the
/// sidecar is a separate process and may lag the contract). Pure.
export function coerceStatus(v: any): PrinterStatus {
  const state: PrinterState = STATES.includes(v?.state) ? v.state : "offline";
  const st = emptyStatus(state, typeof v?.message === "string" ? v.message : null);
  st.progress = clamp01(num(v?.progress) ?? 0);
  st.file = typeof v?.file === "string" ? v.file : null;
  st.elapsed_s = num(v?.elapsed_s);
  st.eta_s = num(v?.eta_s);
  st.layer = num(v?.layer);
  st.total_layers = num(v?.total_layers);
  const t = v?.temps ?? {};
  for (const k of ["nozzle", "bed"] as const) {
    if (num(t[k]?.actual) !== null) st.temps[k] = { actual: t[k].actual, target: num(t[k].target) ?? 0 };
  }
  if (num(t.chamber?.actual) !== null) st.temps.chamber = { actual: t.chamber.actual, target: num(t.chamber.target) };
  const ams = coerceAms(v?.ams);
  if (ams) st.ams = ams;
  return st;
}

/// Bridge error body → DriverError; a developer-mode refusal gets the fix. Pure.
export function bridgeError(status: number, body: any, what: string): DriverError {
  if (body?.needs_developer_mode === true) {
    return new DriverError(409, "Printer refused the command", DEVELOPER_MODE_HINT, true);
  }
  const msg = typeof body?.error === "string" && body.error ? body.error : `${what} failed: HTTP ${status}`;
  return new DriverError(status >= 400 && status < 600 ? status : 502, msg);
}

/// The bridge's answer to a command → ControlResult, or throw. Pure.
export function commandResult(res: HttpRes, what: string): ControlResult {
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : {};
  } catch (_e) {
    /* not JSON */
  }
  if (res.status < 200 || res.status >= 300) throw bridgeError(res.status, body, what);
  return typeof body?.confirmed === "boolean" ? { ok: true, confirmed: body.confirmed } : { ok: true };
}

const FAN_NAMES: FanName[] = ["part", "aux", "chamber"];

/// Coerce the bridge's status (>= 0.1.7 adds the control fields). Pure.
export function coerceDetail(v: any): PrinterDetail {
  const d = detailFrom(coerceStatus(v));
  const lvl = num(v?.speed_level);
  d.speed_level = lvl !== null && lvl >= 1 && lvl <= 4 ? lvl : null;
  for (const f of FAN_NAMES) {
    const pct = num(v?.fans?.[f]);
    if (pct !== null) d.fans[f] = pct;
  }
  d.light = v?.light === "on" || v?.light === "off" ? v.light : null;
  d.wifi_signal = typeof v?.wifi_signal === "string" ? v.wifi_signal : null;
  d.firmware = typeof v?.firmware === "string" ? v.firmware : null;
  d.developer_mode = typeof v?.developer_mode === "boolean" ? v.developer_mode : null;
  if (Array.isArray(v?.errors)) {
    d.errors = v.errors
      .filter((e: any) => typeof e?.code === "string")
      .map((e: any) => {
        const out: PrinterError = { code: e.code, text: typeof e.text === "string" ? e.text : null, severity: typeof e.severity === "string" ? e.severity : "unknown" };
        if (typeof e.url === "string") out.url = e.url;
        return out;
      });
  }
  return d;
}

/// Fans per model: A1 / A1 mini have only the part fan; P1P has no chamber fan.
export function bambuCapabilities(model: string | undefined): Capabilities {
  const m = (model ?? "").toUpperCase();
  const caps = noCapabilities();
  caps.job = { pause: true, resume: true, stop: true, speed_levels: true, speed_percent: false };
  caps.temps = { nozzle: { max: 300 }, bed: { max: 110 }, chamber: null };
  caps.motion = true;
  caps.extrude = true;
  caps.load_unload = true;
  caps.fans = /^A1/.test(m) ? ["part"] : m === "P1P" ? ["part", "aux"] : ["part", "aux", "chamber"];
  caps.light = true;
  caps.ams = true;
  caps.files = true;
  caps.gcode = true;
  caps.camera = true;
  caps.errors = true;
  return caps;
}

/// A control action → the bridge's `/command` body (pause/resume/stop go to
/// their own routes). Pure.
export function bridgeCommand(a: ControlAction): { path: string; body: Record<string, unknown> } {
  switch (a.action) {
    case "pause":
    case "resume":
      return { path: "/" + a.action, body: {} };
    case "stop":
      return { path: "/stop", body: {} };
    case "speed":
      if (a.level === undefined) throw unsupported("speed percent");
      return { path: "/command", body: { type: "speed", level: a.level } };
    case "temp":
      if (a.heater === "chamber") throw unsupported("setting the chamber temperature");
      return { path: "/command", body: { type: "temp", heater: a.heater, target: a.target } };
    case "fan":
      return { path: "/command", body: { type: "fan", fan: a.fan, percent: a.percent } };
    case "light":
      return { path: "/command", body: { type: "light", on: a.on } };
    case "jog":
      return { path: "/command", body: { type: "jog", axis: a.axis, distance: a.distance } };
    case "extrude":
      return { path: "/command", body: { type: "extrude", mm: a.mm } };
    case "load":
      return { path: "/command", body: { type: "load", slot: a.slot } };
    case "gcode":
      return { path: "/command", body: { type: "gcode", line: a.line } };
    default:
      return { path: "/command", body: { type: a.action } };
  }
}

export function bambuDriver(p: PrinterRecord, t: Transport, bridge: BridgeConfig): PrinterDriver {
  const base = bridge.url.replace(/\/+$/, "") + "/printers/" + encodeURIComponent(p.id);
  const auth: Record<string, string> = bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {};
  const req = (r: Omit<HttpReq, "url"> & { path: string }) => {
    const { path, ...rest } = r;
    return t.request({ ...rest, url: base + path, headers: { ...auth, ...(rest.headers ?? {}) } });
  };
  // The bridge waits up to ~6 s for the printer's reply.
  const post = (path: string, body: unknown, what: string): ControlResult =>
    commandResult(
      req({ method: "POST", path, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), timeoutSecs: 20 }),
      what,
    );
  const rawStatus = (): any => {
    const r = req({ method: "GET", path: "/status", timeoutSecs: 8 });
    if (r.status === 404) {
      // Bridge restarted and forgot the printer — re-register, then retry once.
      registerWithBridge(p, t, bridge);
      return jsonBody(expectOk(req({ method: "GET", path: "/status", timeoutSecs: 8 }), "bridge status"), "bridge status");
    }
    return jsonBody(expectOk(r, "bridge status"), "bridge status");
  };

  return {
    status() {
      try {
        return coerceStatus(rawStatus());
      } catch (e) {
        return emptyStatus("offline", (e as Error).message);
      }
    },
    detail() {
      try {
        return coerceDetail(rawStatus());
      } catch (e) {
        return detailFrom(emptyStatus("offline", (e as Error).message));
      }
    },
    capabilities() {
      return bambuCapabilities(p.bambu?.model);
    },
    control(a) {
      const { path, body } = bridgeCommand(a);
      return post(path, body, `bridge ${a.action}`);
    },
    files() {
      const r = req({ method: "GET", path: "/files", timeoutSecs: 60 });
      const body = jsonBody(r, "bridge files");
      if (r.status < 200 || r.status >= 300) throw bridgeError(r.status, body, "bridge files");
      const list: any[] = Array.isArray(body?.files) ? body.files : [];
      return list
        .filter((f) => typeof f?.name === "string")
        .map((f) => ({ name: f.name, size: num(f.size) ?? 0, mtime: num(f.mtime) }));
    },
    deleteFile(name) {
      const r = req({ method: "DELETE", path: `/files?name=${encodeURIComponent(name)}`, timeoutSecs: 60 });
      if (r.status < 200 || r.status >= 300) throw bridgeError(r.status, safeJson(r.body), "bridge delete");
    },
    upload(name, src) {
      expectOk(
        req({
          method: "POST",
          path: `/upload?name=${encodeURIComponent(name)}`,
          headers: { "Content-Type": "application/octet-stream" },
          bodyFile: src.path,
          timeoutSecs: 600 - 30,
        }),
        "bridge upload",
      );
    },
    start(file, opts?: StartOptions) {
      const body: Record<string, unknown> = { file, plate: opts?.plate ?? 1, use_ams: opts?.use_ams ?? false, bed_leveling: opts?.bed_leveling ?? true };
      if (opts?.use_ams && Array.isArray(opts.ams_mapping) && opts.ams_mapping.length) body.ams_mapping = opts.ams_mapping;
      post("/start", body, "bridge start");
    },
    pause() {
      post("/pause", {}, "bridge pause");
    },
    resume() {
      post("/resume", {}, "bridge resume");
    },
    cancel() {
      post("/stop", {}, "bridge stop");
    },
    snapshot(): Snapshot | null {
      // The bridge keeps a camera stream open and answers from memory; while
      // the first frame is still arriving (a minute+ on weak printer Wi-Fi)
      // it answers 502 with the reason. Only 404 means "no camera".
      const img = req({ method: "GET", path: "/snapshot?wait=10", binaryResponse: true, timeoutSecs: 15 });
      if (img.status === 404) return null;
      if (img.status !== 200 || !img.bodyBase64) {
        let reason = `camera: bridge answered HTTP ${img.status}`;
        try {
          const body = JSON.parse(img.body || base64ToUtf8(img.bodyBase64 ?? ""));
          if (body?.error) reason = String(body.error);
        } catch (_e) {
          /* not JSON */
        }
        throw new Error(reason);
      }
      return { content_type: img.contentType || "image/jpeg", data_base64: img.bodyBase64 };
    },
    test() {
      try {
        const h = t.request({ method: "GET", url: bridge.url.replace(/\/+$/, "") + "/health", headers: auth, timeoutSecs: 5 });
        if (h.status === 401 || h.status === 403) return { ok: false, detail: TOKEN_REJECTED };
        const health = jsonBody(expectOk(h, "bridge /health"), "bridge health");
        registerWithBridge(p, t, bridge);
        // The printer's TLS handshake takes 5-40 s, so a status read right
        // after (re)registering says "offline". Long-poll until it connects
        // (bridge >= 0.1.2; older bridges ignore `wait` and answer at once).
        let st: PrinterStatus;
        try {
          const r = req({ method: "GET", path: "/status?wait=40", timeoutSecs: 50 });
          st = coerceStatus(jsonBody(expectOk(r, "bridge status"), "bridge status"));
        } catch (e) {
          st = emptyStatus("offline", (e as Error).message);
        }
        return {
          ok: st.state !== "offline",
          detail: `print-bridge ${health.version ?? ""}: printer ${st.state}${st.message ? " — " + st.message : ""}`,
        };
      } catch (e) {
        return { ok: false, detail: `print-bridge unreachable at ${bridge.url}: ${(e as Error).message}` };
      }
    },
  };
}

const TOKEN_REJECTED = "print-bridge rejected the token — check ~/.config/print-bridge/token or the bridge_token setting";

export interface BridgeHealth {
  reachable: boolean;
  version?: string;
  token_source: "setting" | "file" | "none";
  error?: string;
  /// It answered but refused the token (so it IS installed and running).
  auth_failed?: boolean;
}

/// Probe `GET {url}/health` for diagnostics. Never throws; never echoes the token.
export function bridgeHealth(t: Transport, bridge: BridgeConfig, tokenSource: BridgeHealth["token_source"]): BridgeHealth {
  const out: BridgeHealth = { reachable: false, token_source: tokenSource };
  try {
    const h = t.request({
      method: "GET",
      url: bridge.url.replace(/\/+$/, "") + "/health",
      headers: bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {},
      timeoutSecs: 3,
    });
    if (h.status === 401 || h.status === 403) {
      // It answered, so it's running — but every call will fail.
      out.auth_failed = true;
      out.error = tokenSource === "none" ? "print-bridge requires a token, and none was found (~/.config/print-bridge/token)" : TOKEN_REJECTED;
      return out;
    }
    const body = jsonBody(expectOk(h, "bridge /health"), "bridge health");
    out.reachable = true;
    if (typeof body?.version === "string" && body.version) out.version = body.version;
  } catch (e) {
    // Connection refused etc.: the transport's text is noise in a banner.
    const msg = (e as Error).message;
    out.error = /HTTP \d{3}|expected JSON/.test(msg) ? `print-bridge at ${bridge.url}: ${msg}` : `print-bridge isn't reachable at ${bridge.url} — is it installed and running?`;
  }
  return out;
}
/// The diagnostics `bridge` section: probed only when a Bambu printer exists
/// or the caller asked (`?bridge=1`), so non-Bambu farms see no noise.
export function bridgeDiagnostics(
  hasBambu: boolean,
  asked: boolean,
  t: Transport,
  bridge: BridgeConfig & { token_source: BridgeHealth["token_source"] },
): BridgeHealth | null {
  return hasBambu || asked ? bridgeHealth(t, bridge, bridge.token_source) : null;
}

/// Push (or refresh) a Bambu printer's connection details to the sidecar.
export function registerWithBridge(p: PrinterRecord, t: Transport, bridge: BridgeConfig): void {
  if (!p.bambu) throw new Error("bambu printer has no serial/access code");
  const body: Record<string, unknown> = { host: p.host, serial: p.bambu.serial, access_code: p.bambu.access_code };
  if (p.bambu.model) body.model = p.bambu.model;
  expectOk(
    t.request({
      method: "PUT",
      url: bridge.url.replace(/\/+$/, "") + "/printers/" + encodeURIComponent(p.id),
      headers: { "Content-Type": "application/json", ...(bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {}) },
      body: JSON.stringify(body),
      timeoutSecs: 10,
    }),
    "bridge register",
  );
}

export function unregisterFromBridge(id: string, t: Transport, bridge: BridgeConfig): void {
  t.request({
    method: "DELETE",
    url: bridge.url.replace(/\/+$/, "") + "/printers/" + encodeURIComponent(id),
    headers: bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {},
    timeoutSecs: 10,
  });
}

/// `GET /printers` on the bridge: its registry, with `detected_serial` (bridge
/// >= 0.1.3) when the printer's certificate names a different serial.
export function fetchBridgePrinters(t: Transport, bridge: BridgeConfig): any {
  const r = t.request({
    method: "GET",
    url: bridge.url.replace(/\/+$/, "") + "/printers",
    headers: bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {},
    timeoutSecs: 5,
  });
  return jsonBody(expectOk(r, "bridge printers"), "bridge printers");
}

/// Serial corrections the bridge reports: entries whose `detected_serial`
/// differs from the serial we stored for that (Bambu) printer. Pure — tested.
export function serialFixes(stored: PrinterRecord[], bridgeBody: any): { id: string; from: string; to: string }[] {
  const list: any[] = Array.isArray(bridgeBody) ? bridgeBody : Array.isArray(bridgeBody?.printers) ? bridgeBody.printers : [];
  const out: { id: string; from: string; to: string }[] = [];
  for (const e of list) {
    const det = typeof e?.detected_serial === "string" ? e.detected_serial.trim() : "";
    if (!/^[A-Za-z0-9]{8,32}$/.test(det)) continue;
    const p = stored.find((x) => x.id === e?.id && x.type === "bambu" && x.bambu);
    if (p && p.bambu!.serial !== det) out.push({ id: p.id, from: p.bambu!.serial, to: det });
  }
  return out;
}
