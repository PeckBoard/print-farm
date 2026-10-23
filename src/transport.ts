// HTTP transport for the printer drivers. Two back ends behind one interface:
//
//   * host  — core's `peckboard_http_request`. No subprocess; used for plain
//             JSON calls. Limits: string bodies only (request AND response,
//             the response is lossy UTF-8), TLS always verified, no digest
//             auth (we add Digest ourselves, see digest.ts), 5 MiB cap.
//   * curl  — `peckboard_exec_any` running `curl`. Used whenever the request
//             needs something the host function can't do: a body streamed
//             from a file on disk, multipart upload, a binary response
//             (snapshots — returned base64), or a self-signed TLS printer.
//
// Drivers only see `Transport`; tests inject a fake.

import { httpRequest, execAny } from "./host";
import { parseDigestChallenge, digestAuthorization } from "./digest";

export interface MultipartForm {
  /// Plain string fields (sent with curl --form-string: no @/< magic).
  fields?: Record<string, string>;
  /// The file part.
  file?: { field: string; path: string; filename: string };
}

export interface HttpReq {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /// Text body (JSON etc.).
  body?: string;
  /// Absolute path of a file on disk to send as the raw body.
  bodyFile?: string;
  /// Multipart/form-data body.
  form?: MultipartForm;
  /// Return the body base64-encoded in `bodyBase64` (binary-safe).
  binaryResponse?: boolean;
  /// Accept a self-signed / invalid TLS certificate.
  insecure?: boolean;
  /// HTTP Digest credentials.
  digest?: { user: string; pass: string };
  timeoutSecs?: number;
}

export interface HttpRes {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBase64?: string;
  contentType?: string;
}

export interface Transport {
  request(req: HttpReq): HttpRes;
}

/// Does this request need the curl back end?
export function needsCurl(req: HttpReq): boolean {
  return !!(req.bodyFile || req.form || req.binaryResponse || req.insecure);
}

/// Build curl's argv (after `curl`) for a request. Pure — tested. Secrets
/// (digest password, bearer/api-key headers) end up in argv; see README.
export function curlArgs(req: HttpReq): string[] {
  const a: string[] = ["-sS", "-X", req.method.toUpperCase(), "-m", String(req.timeoutSecs ?? 30)];
  if (req.insecure) a.push("-k");
  for (const [k, v] of Object.entries(req.headers ?? {})) a.push("-H", `${k}: ${v}`);
  if (req.digest) a.push("--digest", "-u", `${req.digest.user}:${req.digest.pass}`);
  if (req.form) {
    for (const [k, v] of Object.entries(req.form.fields ?? {})) a.push("--form-string", `${k}=${v}`);
    if (req.form.file) {
      const f = req.form.file;
      a.push("-F", `${f.field}=@${f.path};filename=${safeFormFilename(f.filename)}`);
    }
  } else if (req.bodyFile) {
    a.push("--data-binary", "@" + req.bodyFile);
  } else if (typeof req.body === "string") {
    a.push("--data-raw", req.body);
  }
  a.push("--url", req.url);
  return a;
}

/// curl's -F value syntax treats `;` and `"` specially; strip them.
function safeFormFilename(name: string): string {
  return name.replace(/[;"\\\r\n]/g, "_");
}

// The wrapper runs curl with the body written to a temp file, then prints a
// meta line followed by the body (raw, or base64 for binary). curl's own
// exit code and the HTTP status are both reported so a network failure is
// distinguishable from an HTTP error.
const CURL_SCRIPT = [
  'mode=$1; shift',
  't=$(mktemp) || exit 90',
  'meta=$(curl -o "$t" -w "%{http_code} %{content_type}" "$@" 2>"$t.err"); rc=$?',
  'printf "PFMETA %s %s\\n" "$rc" "$meta"',
  'if [ "$mode" = b64 ]; then base64 -w0 "$t"; else cat "$t"; fi',
  'if [ "$rc" -ne 0 ]; then cat "$t.err" >&2; fi',
  'rm -f "$t" "$t.err"',
].join("\n");

/// Parse the wrapper's stdout. Pure — tested.
export function parseCurlOutput(stdout: string, binary: boolean): { rc: number; res: HttpRes } {
  const nl = stdout.indexOf("\n");
  const head = nl < 0 ? stdout : stdout.slice(0, nl);
  const rest = nl < 0 ? "" : stdout.slice(nl + 1);
  const m = /^PFMETA (\d+) (\d{3})?\s*(.*)$/.exec(head);
  if (!m) throw new Error("unexpected curl wrapper output");
  const rc = Number(m[1]);
  const status = m[2] ? Number(m[2]) : 0;
  const contentType = (m[3] || "").trim() || undefined;
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  const res: HttpRes = { status, headers, body: binary ? "" : rest, contentType };
  if (binary) res.bodyBase64 = rest.trim();
  return { rc, res };
}

function curlRequest(req: HttpReq): HttpRes {
  const binary = !!req.binaryResponse;
  const timeout = Math.min((req.timeoutSecs ?? 30) + 15, 600);
  const out = execAny("sh", ["-c", CURL_SCRIPT, "sh", binary ? "b64" : "text", ...curlArgs(req)], timeout);
  if (out.timed_out) throw new Error(`request to ${redactUrl(req.url)} timed out`);
  const { rc, res } = parseCurlOutput(out.stdout, binary);
  if (rc !== 0) {
    const msg = (out.stderr || "").trim().split("\n").pop() || `curl exit ${rc}`;
    throw new Error(`request to ${redactUrl(req.url)} failed: ${msg}`);
  }
  return res;
}

function hostRequest(req: HttpReq): HttpRes {
  const send = (extra: Record<string, string>) =>
    httpRequest({
      url: req.url,
      method: req.method,
      headers: { ...(req.headers ?? {}), ...extra },
      body: req.body,
      timeout_secs: req.timeoutSecs ?? 30,
    });
  let r = send({});
  if (r.status === 401 && req.digest) {
    const ch = parseDigestChallenge(headerOf(r.headers, "www-authenticate"));
    if (ch) {
      const uri = pathOf(req.url);
      r = send({ Authorization: digestAuthorization(ch, req.digest.user, req.digest.pass, req.method, uri, randomHex(16)) });
    }
  }
  return { status: r.status, headers: r.headers ?? {}, body: r.body ?? "", contentType: headerOf(r.headers, "content-type") };
}

export const defaultTransport: Transport = {
  request(req: HttpReq): HttpRes {
    return needsCurl(req) ? curlRequest(req) : hostRequest(req);
  },
};

// ── small helpers ───────────────────────────────────────────────────────────

export function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/// Path + query of a URL (the Digest `uri`).
export function pathOf(url: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(url);
  return m && m[1] ? m[1] : "/";
}

export function randomHex(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return s;
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***@");
}

/// Parse a JSON body, with a helpful error on non-JSON.
export function jsonBody(res: HttpRes, what: string): any {
  try {
    return res.body ? JSON.parse(res.body) : {};
  } catch (_e) {
    throw new Error(`${what}: expected JSON, got HTTP ${res.status} ${res.body.slice(0, 120)}`);
  }
}

/// Throw unless the status is 2xx.
export function expectOk(res: HttpRes, what: string): HttpRes {
  if (res.status < 200 || res.status >= 300) {
    const detail = res.body ? `: ${res.body.slice(0, 200)}` : "";
    throw new Error(`${what} failed: HTTP ${res.status}${detail}`);
  }
  return res;
}
