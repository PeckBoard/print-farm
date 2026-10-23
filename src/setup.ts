// Zero-touch setup: Print Farm installs what it needs by itself.
//
//   - OrcaSlicer (for slicing AND its bundled vendor profiles) when no profile
//     tree is found: the AppImage-extract recipe App Manager uses — latest
//     release, `--appimage-extract` (no FUSE, no root) into
//     ~/.local/share/orca-slicer behind a ~/.local/bin/orca-slicer wrapper.
//   - print-bridge (the Bambu sidecar) when a Bambu printer exists and the
//     bridge on the default URL is missing, unreachable, or older than
//     MIN_BRIDGE_VERSION: the sha256-checked release binary, the existing
//     token kept (or a new one made), the systemd user unit written if
//     missing, and the service restarted.
//
// Both scripts mirror App Manager's catalog recipes (plugins can't call each
// other). Installs run as detached jobs (nohup, log + exit file under the
// storage dir), kicked off by the page loading or a tool call and polled by
// the page; nothing needs a click. A failed install is not retried
// automatically for an hour (the page's Retry starts it at once).

import { storeGet, storePut } from "./host";
import { sh, storageDir, JOB_HEARTBEAT, JOB_ALIVE } from "./storage";
import { detectRoots, invalidateRoots } from "./profiles";
import { orcaProfilesDir, bridgeConfig, invalidateBridgeToken, DEFAULT_BRIDGE_URL } from "./config";
import { listPrinters, putPrinter, withCorrectedSerial } from "./printers";
import { bridgeHealth, fetchBridgePrinters, serialFixes, registerWithBridge, BridgeHealth } from "./drivers/bambu";
import { defaultTransport } from "./transport";
import { PrinterRecord } from "./drivers/types";

export const MIN_BRIDGE_VERSION = "0.1.3";

export type SetupName = "orca" | "bridge";

export interface SetupJob {
  name: SetupName;
  status: "running" | "succeeded" | "failed";
  reason: string;
  dir: string;
  pid: number;
  started_at: number;
  finished_at?: number;
  error?: string;
  log_tail?: string;
  /// The bridge needs a systemd user manager; without one we can't install.
  no_systemd?: boolean;
}

export interface SetupView {
  status: "ok" | "running" | "failed";
  reason?: string;
  phase?: string;
  bytes?: number;
  total?: number;
  error?: string;
  log_tail?: string;
  no_systemd?: boolean;
  version?: string;
}

export interface SetupState {
  orca: SetupView;
  /// null when there's no Bambu printer (no bridge needed).
  bridge: SetupView | null;
  /// Things fixed automatically during this call (e.g. a corrected serial).
  notices: string[];
}

// ── pure ────────────────────────────────────────────────────────────────────

/// Is version `a` older than `b`? Leading `v` and pre-release suffixes are
/// ignored; an unparseable `a` counts as older. Pure — tested.
export function versionLt(a: string, b: string): boolean {
  const parse = (s: string) => {
    const m = /(\d+(?:\.\d+)*)/.exec(String(s ?? ""));
    return m ? m[1].split(".").map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b) ?? [0];
  if (!pa) return true;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/// Split `@@TAG` sections of a poll script's output. Pure.
export function parseSections(out: string): Record<string, string> {
  const sections: Record<string, string[]> = {};
  let cur = "";
  for (const line of out.split("\n")) {
    const m = /^@@([A-Z]+)$/.exec(line);
    if (m) sections[(cur = m[1])] = [];
    else if (cur) sections[cur].push(line);
  }
  const res: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) res[k] = v.join("\n").trim();
  return res;
}

const COOLDOWN_FAILED_MS = 60 * 60 * 1000;
const COOLDOWN_REINSTALL_MS = 30 * 60 * 1000;
const COOLDOWN_UPGRADE_MS = 12 * 60 * 60 * 1000;

/// Should an install start now? Pure — tested.
export function shouldStart(
  job: Pick<SetupJob, "status" | "started_at" | "finished_at"> | null,
  need: { kind: "missing" | "upgrade" } | null,
  now: number,
  force: boolean,
): boolean {
  if (job?.status === "running") return false;
  if (!need) return false;
  if (force || !job) return true;
  const since = now - (job.finished_at ?? job.started_at);
  if (job.status === "failed") return since >= COOLDOWN_FAILED_MS;
  return since >= (need.kind === "upgrade" ? COOLDOWN_UPGRADE_MS : COOLDOWN_REINSTALL_MS);
}

/// The last few meaningful log lines — the installer's real reason. Pure.
export function failureReason(log: string, exitCode: number | null): string {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.slice(-3).join(" | ");
  return last || (exitCode === null ? "the installer stopped unexpectedly" : `the installer exited with code ${exitCode}`);
}

// ── install scripts ($1 = the job dir) ──────────────────────────────────────

/// Content-Length of a URL after redirects, into $d/total (best effort).
const SIZE_OF = `size_of() { curl -fsSLI "$1" 2>/dev/null | awk 'tolower($1)=="content-length:"{n=$2} END{gsub(/[^0-9]/,"",n); print n+0}' > "$d/total" || true; }`;

export const ORCA_INSTALL = `set -e
d=$1
rel=\${PF_ORCA_RELEASES:-https://github.com/SoftFever/OrcaSlicer/releases}
${SIZE_OF}
case "$(uname -m)" in x86_64|amd64) arch="" ;; aarch64|arm64) arch="_aarch64" ;;
  *) echo "OrcaSlicer has no Linux build for this architecture ($(uname -m))" >&2; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this host" >&2; exit 1; }
echo resolve > "$d/phase"
tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$rel/latest") || { echo "couldn't reach $rel (no internet?)" >&2; exit 1; }
tag=\${tag##*/}; ver=\${tag#v}
url="$rel/download/$tag/OrcaSlicer_Linux_AppImage_Ubuntu2404\${arch}_V$ver.AppImage"
size_of "$url"
tmp="$d/tmp"; rm -rf "$tmp"; mkdir -p "$tmp"
echo "$tmp/orca.AppImage" > "$d/dlfile"
echo download > "$d/phase"
curl -fsSL -o "$tmp/orca.AppImage" "$url" || { echo "download failed: $url" >&2; exit 1; }
echo extract > "$d/phase"
chmod +x "$tmp/orca.AppImage"
(cd "$tmp" && ./orca.AppImage --appimage-extract >/dev/null)
[ -d "$tmp/squashfs-root" ] || { echo "the AppImage didn't extract" >&2; exit 1; }
echo install > "$d/phase"
mkdir -p "$HOME/.local/share" "$HOME/.local/bin"
rm -rf "$HOME/.local/share/orca-slicer"
mv "$tmp/squashfs-root" "$HOME/.local/share/orca-slicer"
echo "$ver" > "$HOME/.local/share/orca-slicer/VERSION"
printf '#!/bin/sh\\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\\n' > "$HOME/.local/bin/orca-slicer"
chmod +x "$HOME/.local/bin/orca-slicer"
rm -rf "$tmp"
echo "OrcaSlicer $ver installed to ~/.local/share/orca-slicer"
`;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/// Mirrors print-bridge.service in the print-bridge repo (and App Manager's).
const BRIDGE_UNIT_LINES = [
  "[Unit]",
  "Description=print-bridge: local HTTP bridge for Bambu Lab printers",
  "Wants=network-online.target",
  "After=network-online.target",
  "",
  "[Service]",
  "ExecStart=%h/.local/bin/print-bridge --bind 127.0.0.1:7781 --token-file %h/.config/print-bridge/token",
  "Environment=RUST_LOG=print_bridge=info",
  "Restart=on-failure",
  "RestartSec=5",
  "NoNewPrivileges=yes",
  "PrivateTmp=yes",
  "",
  "[Install]",
  "WantedBy=default.target",
];

/// Exit code 3 = no systemd user manager (nothing was touched).
export const BRIDGE_INSTALL = `set -e
d=$1
base=\${PF_BRIDGE_RELEASES:-https://github.com/PeckBoard/print-bridge/releases/latest/download}
${SIZE_OF}
if [ -z "\${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "no systemd user manager is reachable (systemctl --user failed), so print-bridge can't run as a service here" >&2; exit 3
fi
command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this host" >&2; exit 1; }
case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;;
  *) echo "print-bridge has no build for this architecture ($(uname -m))" >&2; exit 1 ;; esac
asset="print-bridge-linux-$arch"
tmp="$d/tmp"; rm -rf "$tmp"; mkdir -p "$tmp"
size_of "$base/$asset"
echo "$tmp/$asset" > "$d/dlfile"
echo download > "$d/phase"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || { echo "download failed: $base/$asset" >&2; exit 1; }
curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256" || { echo "download failed: $base/$asset.sha256" >&2; exit 1; }
want=$(cut -d" " -f1 "$tmp/$asset.sha256"); got=$(sha256sum "$tmp/$asset" | cut -d" " -f1)
[ "$want" = "$got" ] || { echo "sha256 mismatch for $asset — not installed" >&2; exit 1; }
echo install > "$d/phase"
mkdir -p "$HOME/.local/bin" "$HOME/.config/print-bridge" "$HOME/.config/systemd/user"
install -m 755 "$tmp/$asset" "$HOME/.local/bin/print-bridge.new"
mv -f "$HOME/.local/bin/print-bridge.new" "$HOME/.local/bin/print-bridge"
rm -rf "$tmp"
tok="$HOME/.config/print-bridge/token"
if [ ! -s "$tok" ]; then (umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \\n' > "$tok"); chmod 600 "$tok"; fi
unit="$HOME/.config/systemd/user/print-bridge.service"
[ -e "$unit" ] || printf '%s\\n' ${BRIDGE_UNIT_LINES.map(shQuote).join(" ")} > "$unit"
echo start > "$d/phase"
systemctl --user daemon-reload
systemctl --user enable print-bridge
systemctl --user restart print-bridge
loginctl enable-linger "\${USER:-$(id -un)}" 2>/dev/null || echo "warning: loginctl enable-linger failed; the service stops when you log out" >&2
"$HOME/.local/bin/print-bridge" --version || true
`;

const SCRIPTS: Record<SetupName, string> = { orca: ORCA_INSTALL, bridge: BRIDGE_INSTALL };

const LAUNCH = [
  'd=$1; s=$2',
  'rm -rf "$d"; mkdir -p "$d" || exit 1',
  `nohup sh -c 's=$1; d=$2; ${JOB_HEARTBEAT} sh -c "$s" sh "$d"; echo $? > "$d/exit"' sh "$s" "$d" > "$d/log" 2>&1 < /dev/null &`,
  'echo $!',
].join("\n");

const POLL = [
  'd=$1; pid=$2',
  'echo @@EXIT; cat "$d/exit" 2>/dev/null',
  `echo @@ALIVE; ${JOB_ALIVE}`,
  'echo @@PHASE; cat "$d/phase" 2>/dev/null',
  'echo @@TOTAL; cat "$d/total" 2>/dev/null',
  'echo @@BYTES; f=$(cat "$d/dlfile" 2>/dev/null); [ -n "$f" ] && [ -f "$f" ] && wc -c < "$f"',
  'echo @@LOG; tail -c 3000 "$d/log" 2>/dev/null',
  'true',
].join("\n");

// ── job store ───────────────────────────────────────────────────────────────

const JOBS = "setup_jobs";

function getJob(name: SetupName): SetupJob | null {
  return (storeGet(JOBS, name) as SetupJob) ?? null;
}

function startJob(name: SetupName, reason: string): SetupJob {
  const dir = `${storageDir()}/setup/${name}`;
  const pid = Number(sh(LAUNCH, [dir, SCRIPTS[name]], 30).trim());
  const job: SetupJob = { name, status: "running", reason, dir, pid: isFinite(pid) ? pid : 0, started_at: Date.now() };
  storePut(JOBS, name, job);
  return job;
}

/// Poll a running job; settle it when the script has exited.
function pollJob(job: SetupJob): { job: SetupJob; view: SetupView } {
  const s = parseSections(sh(POLL, [job.dir, String(job.pid)], 30));
  const exitCode = s.EXIT === "" || s.EXIT === undefined ? null : Number(s.EXIT);
  const exited = exitCode !== null && isFinite(exitCode);
  if (!exited && s.ALIVE === "1") {
    const view: SetupView = { status: "running", reason: job.reason, phase: s.PHASE || "starting" };
    if (Number(s.TOTAL) > 0) view.total = Number(s.TOTAL);
    if (s.BYTES) view.bytes = Number(s.BYTES) || 0;
    return { job, view };
  }
  const next: SetupJob = { ...job, finished_at: Date.now(), log_tail: (s.LOG ?? "").slice(-1500) };
  if (exited && exitCode === 0) {
    next.status = "succeeded";
    delete next.error;
    if (job.name === "orca") invalidateRoots();
    else invalidateBridgeToken();
  } else {
    next.status = "failed";
    next.error = failureReason(s.LOG ?? "", exited ? exitCode : null);
    if (exitCode === 3 && job.name === "bridge") next.no_systemd = true;
  }
  storePut(JOBS, job.name, next);
  if (next.status === "succeeded") return { job: next, view: { status: "ok" } };
  return { job: next, view: { status: "failed", reason: next.reason, error: next.error, log_tail: next.log_tail, no_systemd: next.no_systemd } };
}

// ── what's needed ───────────────────────────────────────────────────────────

/// Why OrcaSlicer must be installed, or null when profiles are available (or
/// the user pointed us at their own profile dirs).
function orcaNeed(): { kind: "missing"; reason: string } | null {
  if (orcaProfilesDir()) return null;
  if (detectRoots().some((r) => r.kind === "system")) return null;
  // An extracted install we can't read profiles from: never clobber it.
  if (sh('[ -e "$HOME/.local/share/orca-slicer/AppRun" ] && echo y; true', [], 15).trim() === "y") return null;
  return { kind: "missing", reason: "no OrcaSlicer profiles on this host" };
}

/// Why print-bridge must be (re)installed, or null. Only for the default
/// loopback URL — a bridge the user runs elsewhere is theirs to manage. Pure.
export function bridgeNeed(health: BridgeHealth, url: string): { kind: "missing" | "upgrade"; reason: string } | null {
  if (url.replace(/\/+$/, "") !== DEFAULT_BRIDGE_URL) return null;
  if (health.reachable) {
    return versionLt(health.version ?? "", MIN_BRIDGE_VERSION)
      ? { kind: "upgrade", reason: `print-bridge ${health.version ?? "(unknown version)"} is older than ${MIN_BRIDGE_VERSION}` }
      : null;
  }
  if (health.auth_failed) return null; // running; a token problem isn't fixed by reinstalling
  return { kind: "missing", reason: "print-bridge isn't running" };
}

function viewOf(job: SetupJob | null, need: { kind: "missing" | "upgrade"; reason: string } | null): SetupView {
  if (job?.status === "running") return pollJob(job).view;
  if (job?.status === "failed" && need) {
    return { status: "failed", reason: job.reason, error: job.error, log_tail: job.log_tail, no_systemd: job.no_systemd };
  }
  if (job?.status === "succeeded" && need?.kind === "missing" && job.name === "bridge") {
    // Installed, but still not answering: say so instead of looping.
    return { status: "failed", reason: need.reason, error: "print-bridge was installed but isn't answering on 127.0.0.1:7781", log_tail: job.log_tail };
  }
  return { status: "ok" };
}

/// Correct stored Bambu serials from the bridge's `detected_serial`.
export function syncSerials(printers: PrinterRecord[] = listPrinters()): string[] {
  const bambu = printers.filter((p) => p.type === "bambu");
  if (!bambu.length) return [];
  const cfg = bridgeConfig();
  let body: any;
  try {
    body = fetchBridgePrinters(defaultTransport, cfg);
  } catch (_e) {
    return [];
  }
  const notices: string[] = [];
  for (const fix of serialFixes(bambu, body)) {
    const p = bambu.find((x) => x.id === fix.id)!;
    const next = withCorrectedSerial(p, fix.to);
    putPrinter(next);
    try {
      registerWithBridge(next, defaultTransport, cfg);
    } catch (_e) {
      /* the next status poll re-registers */
    }
    notices.push(`${p.name}: serial corrected from ${fix.from} to ${fix.to} (read from the printer)`);
  }
  return notices;
}

// ── entry point ─────────────────────────────────────────────────────────────

let okMemo = 0;
const OK_TTL_MS = 60_000;

/// Forget the "all set up" memo (a Bambu printer was just added, etc.).
export function invalidateSetup(): void {
  okMemo = 0;
}

/// Check what's missing, start installs that should run, poll running ones.
/// `force` = the page's Retry. Cheap when everything is in place (memoised).
export function ensureSetup(force?: SetupName): SetupState {
  const now = Date.now();
  if (!force && okMemo && now - okMemo < OK_TTL_MS) return { orca: { status: "ok" }, bridge: null, notices: [] };

  let orcaJob = getJob("orca");
  const oNeed = orcaJob?.status === "running" ? null : orcaNeed();
  if (shouldStart(orcaJob, oNeed, now, force === "orca")) orcaJob = startJob("orca", oNeed!.reason);
  const orca = viewOf(orcaJob, oNeed);

  let bridge: SetupView | null = null;
  const notices: string[] = [];
  const printers = listPrinters();
  if (printers.some((p) => p.type === "bambu")) {
    let bJob = getJob("bridge");
    const cfg = bridgeConfig();
    let health: BridgeHealth | null = null;
    let bNeed: { kind: "missing" | "upgrade"; reason: string } | null = null;
    if (bJob?.status !== "running") {
      health = bridgeHealth(defaultTransport, cfg, cfg.token_source);
      bNeed = bridgeNeed(health, cfg.url);
      if (shouldStart(bJob, bNeed, now, force === "bridge")) bJob = startJob("bridge", bNeed!.reason);
    }
    bridge = viewOf(bJob, bNeed);
    if (health?.version) bridge.version = health.version;
    if (health?.reachable) notices.push(...syncSerials(printers));
  }
  // Memoise only a farm with nothing to watch: Bambu farms keep their bridge
  // health check and serial sync on every page load.
  okMemo = orca.status === "ok" && !bridge ? now : 0;
  return { orca, bridge, notices };
}

/// For tool calls: kick setup off if needed (never throws).
export function ensureSetupQuiet(): SetupState | null {
  try {
    return ensureSetup();
  } catch (_e) {
    return null;
  }
}
