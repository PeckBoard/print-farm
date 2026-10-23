// FFI layer: the Peckboard core host functions this plugin calls. Host calls
// are kept LAZY (inside functions) so the pure modules load under vitest
// without an Extism runtime. See peckboard/src/plugin/host.rs for the Rust
// side of every function called here.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset as unknown as bigint);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

// ── Settings ────────────────────────────────────────────────────────────────

export function getSetting(key: string): any {
  const result = hostCall("peckboard_get_plugin_setting", { key });
  return result?.value ?? null;
}

// ── Plugin document store (data_store; 256 KiB per document) ────────────────

export function storePut(collection: string, key: string, data: unknown): void {
  hostCall("peckboard_store_put", { collection, key, data });
}

export function storeGet(collection: string, key: string): any {
  const result = hostCall("peckboard_store_get", { collection, key });
  return result?.value ?? null;
}

/// Atomic create: true when this call wrote the row, false when it existed.
/// `ttlSecs` > 0 lets a call steal a row older than that (a stale lock).
export function storePutIfAbsent(collection: string, key: string, data: unknown, ttlSecs = 0): boolean {
  return hostCall("peckboard_store_put_if_absent", { collection, key, data, ttl_secs: ttlSecs })?.acquired === true;
}
export function storeList(collection: string): Array<{ key: string; value: any }> {
  const result = hostCall("peckboard_store_list", { collection });
  return result?.items ?? [];
}

export function storeDelete(collection: string, key: string): void {
  hostCall("peckboard_store_delete", { collection, key });
}

// ── Process exec (process_exec_any) ─────────────────────────────────────────
// One-shot, argv (no shell unless we run `sh -c`), stdin is /dev/null, 1 MiB
// per output stream, timeout clamped to 600s, stdout decoded lossy-UTF-8 —
// binary output must be base64-encoded by the command itself.

export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
}

export function execAny(command: string, args: string[], timeoutSecs?: number): ExecResult {
  const input: any = { command, args };
  if (typeof timeoutSecs === "number") input.timeout_secs = timeoutSecs;
  return hostCall("peckboard_exec_any", input) as ExecResult;
}

// ── Outbound HTTP (http_request) ────────────────────────────────────────────
// String bodies only (request and response — the response is lossy UTF-8),
// 5 MiB response cap, no redirects followed, TLS verified (no self-signed),
// timeout 1..300s (default 30).

export interface HostHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export function httpRequest(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_secs?: number;
}): HostHttpResponse {
  return hostCall("peckboard_http_request", input) as HostHttpResponse;
}

// ── Ask the user (ask_user) ─────────────────────────────────────────────────

export function askUser(question: string, options: string[], token: string): void {
  hostCall("peckboard_ask_user", { question, options, token });
}

export function getAnswer(token: string): { status: string; answer?: string; rejected?: boolean } {
  return hostCall("peckboard_get_answer", { token });
}

/// The trusted scope core resolved for this call; `authority` is true for an
/// authenticated plugin-UI request, false for an MCP tool invocation.
export function callerScope(): { folder_id: string | null; session_id: string | null; authority: boolean } {
  const r = hostCall("peckboard_caller_scope", {});
  return {
    folder_id: r?.folder_id ?? null,
    session_id: r?.session_id ?? null,
    authority: r?.authority === true,
  };
}
