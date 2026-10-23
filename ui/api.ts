// Parent-proxied fetch bridge. The page runs in a sandboxed iframe without
// same-origin, so the host performs authenticated /api/plugin-ui/* requests
// on its behalf (web/src/components/PluginFullPage.tsx). The JWT never enters
// the frame.

export const API = "/api/plugin-ui/print-farm";

let seq = 0;
const pending = new Map<number, (r: { status: number; body: string }) => void>();
// Has the host ever answered? A request posted before the host's message
// listener is attached is silently lost, so until the first reply arrives,
// idempotent GETs are re-posted (and the first reply to any copy wins).
let bridgeUp = false;
// Longest plugin call (core caps it near 610s) plus slack.
const TIMEOUT_MS = 630_000;

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.type === "plugin-ui-fetch-result" && pending.has(m.requestId)) {
    bridgeUp = true;
    pending.get(m.requestId)!({ status: m.status, body: m.body });
  }
});

function raw(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const ids: number[] = [];
    let done = false;
    const finish = (r: { status: number; body: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(resend);
      ids.forEach((i) => pending.delete(i));
      resolve(r);
    };
    const send = () => {
      const id = ++seq;
      ids.push(id);
      pending.set(id, finish);
      window.parent.postMessage({ type: "plugin-ui-fetch", requestId: id, method, path: API + "/" + path, body }, "*");
    };
    const timer = setTimeout(() => finish({ status: 504, body: JSON.stringify({ error: "the request timed out" }) }), TIMEOUT_MS);
    const resend = setInterval(() => {
      if (bridgeUp || method !== "GET" || ids.length >= 10) clearInterval(resend);
      else send();
    }, 1000);
    send();
  });
}

export class ApiError extends Error {
  /// The parsed error body (`{error, hint?, needs_developer_mode?}`), if any.
  constructor(public status: number, msg: string, public body: any = null) {
    super(msg);
  }
  get hint(): string | null {
    return typeof this.body?.hint === "string" && this.body.hint ? this.body.hint : null;
  }
  get needsDeveloperMode(): boolean {
    return this.body?.needs_developer_mode === true;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body === undefined ? undefined : JSON.stringify(body));
  let parsed: any = {};
  try {
    parsed = res.body ? JSON.parse(res.body) : {};
  } catch (_e) {
    parsed = { error: res.status >= 400 ? `request failed (${res.status})` : "bad response from the plugin" };
  }
  if (res.status >= 400 || (parsed && typeof parsed.error === "string")) {
    throw new ApiError(res.status, parsed?.error || `request failed (${res.status})`, parsed);
  }
  return parsed as T;
}

/// GET an image route as a data: URL. The fetch bridge carries text only, so
/// image routes answer `{content_type, data_base64}` (like `snapshot`).
export async function getImage(path: string): Promise<string> {
  const r = await get<{ content_type?: string; data_base64?: string }>(path);
  if (!r.data_base64) throw new ApiError(502, "the plugin returned no image data");
  return `data:${r.content_type || "image/jpeg"};base64,${r.data_base64}`;
}

export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const put = <T = any>(path: string, body: unknown) => api<T>("PUT", path, body);
export const del = <T = any>(path: string) => api<T>("DELETE", path);

/// Ask the host to open another plugin's page (App Manager deep link).
export function openPluginPage(plugin: string, item: string, query: string) {
  window.parent.postMessage({ type: "plugin-ui-open-page", plugin, item, query }, "*");
}

// ── base64 ↔ bytes ─────────────────────────────────────────────────────────

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
