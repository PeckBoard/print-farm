// Plugin settings with their defaults applied (core returns null for unset).

import { getSetting } from "./host";
import { BridgeConfig } from "./drivers/bambu";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7781";
export const DEFAULT_ORCA_PATH = "orca-slicer";

function str(key: string): string {
  const v = getSetting(key);
  return typeof v === "string" ? v.trim() : "";
}

export function bridgeConfig(): BridgeConfig {
  return { url: str("bridge_url") || DEFAULT_BRIDGE_URL, token: str("bridge_token") };
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
