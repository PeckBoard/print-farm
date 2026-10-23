// Plugin settings with their defaults applied (core returns null for unset).

import { getSetting, execAny } from "./host";
import { BridgeConfig } from "./drivers/bambu";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7781";
export const DEFAULT_ORCA_PATH = "orca-slicer";

function str(key: string): string {
  const v = getSetting(key);
  return typeof v === "string" ? v.trim() : "";
}

export type TokenSource = "setting" | "file" | "none";

/// The explicit `bridge_token` setting wins; otherwise the token App
/// Manager's print-bridge install wrote to disk. Pure (reader injected).
export function resolveBridgeToken(setting: string, readFile: () => string): { token: string; source: TokenSource } {
  const s = setting.trim();
  if (s) return { token: s, source: "setting" };
  let f = "";
  try {
    f = readFile().trim();
  } catch (_e) {
    f = "";
  }
  return f ? { token: f, source: "file" } : { token: "", source: "none" };
}

// Re-read at most this often, so a reinstall's new token is picked up
// without an exec on every status poll.
const TOKEN_FILE_TTL_MS = 30_000;
let tokenFile: { value: string; at: number } | null = null;

/// Forget the cached token file (an install may just have written it).
export function invalidateBridgeToken(): void {
  tokenFile = null;
}

/// `${XDG_CONFIG_HOME:-~/.config}/print-bridge/token`, or "" when absent.
/// The token is never logged or returned to the UI.
function readBridgeTokenFile(): string {
  const now = Date.now();
  if (tokenFile && now - tokenFile.at < TOKEN_FILE_TTL_MS) return tokenFile.value;
  const r = execAny("sh", ["-c", 'f="${XDG_CONFIG_HOME:-$HOME/.config}/print-bridge/token"; [ -r "$f" ] && head -c 4096 "$f" || true'], 10);
  const value = r.exit_code === 0 ? r.stdout.trim() : "";
  tokenFile = { value, at: now };
  return value;
}

export function bridgeConfig(): BridgeConfig & { token_source: TokenSource } {
  const { token, source } = resolveBridgeToken(str("bridge_token"), readBridgeTokenFile);
  return { url: str("bridge_url") || DEFAULT_BRIDGE_URL, token, token_source: source };
}

export function orcaPath(): string {
  return str("orca_path") || DEFAULT_ORCA_PATH;
}

/// Explicit profile roots (`:`-separated), or empty = auto-detect.
export function orcaProfilesDir(): string {
  return str("orca_profiles_dir");
}

/// "auto" (wrap in xvfb-run when there's no display and it's installed),
/// "always", or "never".
export function orcaHeadless(): "auto" | "always" | "never" {
  const v = str("orca_headless");
  return v === "always" || v === "never" ? v : "auto";
}

/// Override for the on-disk storage dir; empty = the XDG default.
export function storageDirSetting(): string {
  return str("storage_dir");
}
