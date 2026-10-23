// Bambu Lab driver — talks to the local print-bridge sidecar (MQTT + FTPS to
// the printer live there). Contract: JSON, `Authorization: Bearer <token>`.
//   GET  /health                       → {ok, version}
//   PUT  /printers/{id}                {host, serial, access_code, model?}
//   DELETE /printers/{id}
//   GET  /printers/{id}/status         → normalised status
//   POST /printers/{id}/upload?name=   raw body → {ok}
//   POST /printers/{id}/start          {file, plate?, use_ams?, bed_leveling?}
//   POST /printers/{id}/pause | /resume | /stop
//   GET  /printers/{id}/snapshot       → image/jpeg (404 = no camera)

import { Transport, HttpReq, jsonBody, expectOk } from "../transport";
import { PrinterDriver, PrinterRecord, PrinterStatus, emptyStatus, num, clamp01, Snapshot, StartOptions, PrinterState } from "./types";

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
  return st;
}

export function bambuDriver(p: PrinterRecord, t: Transport, bridge: BridgeConfig): PrinterDriver {
  const base = bridge.url.replace(/\/+$/, "") + "/printers/" + encodeURIComponent(p.id);
  const auth: Record<string, string> = bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {};
  const req = (r: Omit<HttpReq, "url"> & { path: string }) => {
    const { path, ...rest } = r;
    return t.request({ ...rest, url: base + path, headers: { ...auth, ...(rest.headers ?? {}) } });
  };
  const post = (path: string, body: unknown, what: string) =>
    expectOk(
      req({ method: "POST", path, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), timeoutSecs: 20 }),
      what,
    );

  return {
    status() {
      try {
        const r = req({ method: "GET", path: "/status", timeoutSecs: 8 });
        if (r.status === 404) {
          // Bridge restarted and forgot the printer — re-register, then retry once.
          registerWithBridge(p, t, bridge);
          return coerceStatus(jsonBody(expectOk(req({ method: "GET", path: "/status", timeoutSecs: 8 }), "bridge status"), "bridge status"));
        }
        return coerceStatus(jsonBody(expectOk(r, "bridge status"), "bridge status"));
      } catch (e) {
        return emptyStatus("offline", (e as Error).message);
      }
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
      post(
        "/start",
        { file, plate: opts?.plate ?? 1, use_ams: opts?.use_ams ?? false, bed_leveling: opts?.bed_leveling ?? true },
        "bridge start",
      );
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
      const img = req({ method: "GET", path: "/snapshot", binaryResponse: true, timeoutSecs: 15 });
      if (img.status !== 200 || !img.bodyBase64) return null;
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
