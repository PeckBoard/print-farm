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

import { storeGet, storePut, storePutIfAbsent, storeDelete } from "./host";
import { sh, storageDir, JOB_HEARTBEAT, JOB_ALIVE } from "./storage";
import { detectRoots, invalidateRoots } from "./profiles";
import { orcaProfilesDir, orcaPath, bridgeConfig, invalidateBridgeToken, DEFAULT_BRIDGE_URL, DEFAULT_ORCA_PATH } from "./config";
import { findOrca } from "./slice";
import { listPrinters, putPrinter, withCorrectedSerial } from "./printers";
import { bridgeHealth, fetchBridgePrinters, serialFixes, registerWithBridge, BridgeHealth } from "./drivers/bambu";
import { defaultTransport } from "./transport";
import { PrinterRecord } from "./drivers/types";

export const MIN_BRIDGE_VERSION = "0.1.7";

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
  /// Bridge installs: the MIN_BRIDGE_VERSION this install was started for.
  target?: string;
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
  job: Pick<SetupJob, "status" | "started_at" | "finished_at" | "target"> | null,
  need: { kind: "missing" | "upgrade"; target?: string } | null,
  now: number,
  force: boolean,
): boolean {
  if (job?.status === "running") return false;
  if (!need) return false;
  if (force || !job) return true;
  // A newer minimum than the last install aimed for: not a retry loop.
  if (need.kind === "upgrade" && job.status === "succeeded" && need.target && job.target !== need.target) return true;
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

/// Shared libraries OrcaSlicer's Linux AppImage links against but doesn't
/// bundle, which minimal / server hosts often lack (Ubuntu 26.04 ships no
/// libGLU by default) → candidate packages per package format, first that
/// downloads wins (Ubuntu 24.04+ renamed some with a `t64` suffix). Unmapped
/// libraries fall back to the Debian naming guess `libfoo.so.N` → `libfooN`.
export const LIB_PACKAGES: Record<string, { deb: string[]; rpm: string[] }> = {
  "libGLU.so.1": { deb: ["libglu1-mesa"], rpm: ["mesa-libGLU"] },
  "libGL.so.1": { deb: ["libgl1"], rpm: ["libglvnd-glx"] },
  "libOpenGL.so.0": { deb: ["libopengl0"], rpm: ["libglvnd-opengl"] },
  "libEGL.so.1": { deb: ["libegl1"], rpm: ["libglvnd-egl"] },
  "libGLX.so.0": { deb: ["libglx0"], rpm: ["libglvnd-glx"] },
  "libGLdispatch.so.0": { deb: ["libglvnd0"], rpm: ["libglvnd"] },
  "libgtk-3.so.0": { deb: ["libgtk-3-0t64", "libgtk-3-0"], rpm: ["gtk3"] },
  "libgdk-3.so.0": { deb: ["libgtk-3-0t64", "libgtk-3-0"], rpm: ["gtk3"] },
  "libwebkit2gtk-4.1.so.0": { deb: ["libwebkit2gtk-4.1-0"], rpm: ["webkit2gtk4.1"] },
  "libjavascriptcoregtk-4.1.so.0": { deb: ["libjavascriptcoregtk-4.1-0"], rpm: ["webkit2gtk4.1"] },
  "libsoup-3.0.so.0": { deb: ["libsoup-3.0-0"], rpm: ["libsoup3"] },
  "libgstreamer-1.0.so.0": { deb: ["libgstreamer1.0-0"], rpm: ["gstreamer1"] },
  "libgstbase-1.0.so.0": { deb: ["libgstreamer1.0-0"], rpm: ["gstreamer1"] },
  "libgstapp-1.0.so.0": { deb: ["libgstreamer-plugins-base1.0-0"], rpm: ["gstreamer1-plugins-base"] },
  "libgstvideo-1.0.so.0": { deb: ["libgstreamer-plugins-base1.0-0"], rpm: ["gstreamer1-plugins-base"] },
  "libgstaudio-1.0.so.0": { deb: ["libgstreamer-plugins-base1.0-0"], rpm: ["gstreamer1-plugins-base"] },
  "libgstpbutils-1.0.so.0": { deb: ["libgstreamer-plugins-base1.0-0"], rpm: ["gstreamer1-plugins-base"] },
  "libsecret-1.so.0": { deb: ["libsecret-1-0"], rpm: ["libsecret"] },
  "libnotify.so.4": { deb: ["libnotify4"], rpm: ["libnotify"] },
  "libSM.so.6": { deb: ["libsm6"], rpm: ["libSM"] },
  "libICE.so.6": { deb: ["libice6"], rpm: ["libICE"] },
  "libXxf86vm.so.1": { deb: ["libxxf86vm1"], rpm: ["libXxf86vm"] },
  "libxkbcommon.so.0": { deb: ["libxkbcommon0"], rpm: ["libxkbcommon"] },
  "libfuse.so.2": { deb: ["libfuse2t64", "libfuse2"], rpm: ["fuse-libs"] },
};

/// The shell `case` behind `pkgs_for <lib> <deb|rpm>` (LIB_PACKAGES plus the
/// Debian naming guess). Pure — tested.
export function libPackagesCase(): string {
  const arms: string[] = [];
  for (const [lib, p] of Object.entries(LIB_PACKAGES)) {
    arms.push(`    ${lib}:deb) echo ${p.deb.join(" ")} ;;`, `    ${lib}:rpm) echo ${p.rpm.join(" ")} ;;`);
  }
  return [
    "pkgs_for() {",
    '  case "$1:$2" in',
    ...arms,
    '    *:deb) b=${1%%.so*}; v=${1##*.so.}; [ "$v" = "$1" ] && v=""; g=$(printf %s "$b$v" | tr A-Z_ a-z-); echo "$g" "${g}t64" ;;',
    "    *) echo ;;",
    "  esac",
    "}",
  ].join("\n");
}

/// `fix_libs` (needs $d): find the shared libraries the extracted OrcaSlicer
/// can't load (`ldd` with the dirs its launcher adds), fetch each one's
/// package WITHOUT root (`apt-get download` + `dpkg-deb -x`, or `dnf
/// download` + `rpm2cpio | cpio`), and copy the library into
/// ~/.local/share/orca-slicer/extra-lib — which slice.ts puts on
/// LD_LIBRARY_PATH. Fails (listing them) if any stay missing.
export const ORCA_LIBFIX = `${libPackagesCase()}
fix_libs() (
  set +e
  O="$HOME/.local/share/orca-slicer"; X="$O/extra-lib"
  [ -x "$O/bin/orca-slicer" ] || exit 0
  command -v ldd >/dev/null 2>&1 || exit 0
  missing() { LD_LIBRARY_PATH="$X:$O/lib/orca-runtime:$O/lib:$O/bin" ldd "$O/bin/orca-slicer" 2>/dev/null | awk '/not found/{print $1}' | sort -u; }
  m=$(missing)
  [ -n "$m" ] || exit 0
  echo libs > "$d/phase"
  echo "OrcaSlicer can't load: $(echo $m)"
  if command -v apt-get >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1; then pm=deb
  elif command -v dnf >/dev/null 2>&1 && command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1; then pm=rpm
  else echo "OrcaSlicer needs $(echo $m), and this host has no apt-get or dnf to fetch them without root — install them with your package manager" >&2; exit 1; fi
  mkdir -p "$X"; t="$d/libtmp"
  for lib in $m; do
    got=""
    for p in $(pkgs_for "$lib" "$pm"); do
      rm -rf "$t"; mkdir -p "$t/pkg" "$t/x"
      if [ "$pm" = deb ]; then
        (cd "$t/pkg" && apt-get download "$p" >/dev/null 2>&1) || continue
        for f in "$t"/pkg/*.deb; do dpkg-deb -x "$f" "$t/x"; done
      else
        (cd "$t/pkg" && dnf download -q "$p" >/dev/null 2>&1) || continue
        for f in "$t"/pkg/*.rpm; do (cd "$t/x" && rpm2cpio "$f" | cpio -idm --quiet); done
      fi
      n=0
      for f in $(find "$t/x" \\( -type f -o -type l \\) -name "$lib*"); do cp -P "$f" "$X/" && n=$((n + 1)); done
      [ "$n" -gt 0 ] || continue
      echo "fetched $lib from $p"; got=1; break
    done
    [ -n "$got" ] || echo "couldn't fetch $lib automatically" >&2
  done
  rm -rf "$t"
  left=$(missing)
  [ -z "$left" ] || { echo "OrcaSlicer still can't load $(echo $left) — install the package(s) providing them" >&2; exit 1; }
  echo "OrcaSlicer's missing libraries are in $X"
)`;

export const ORCA_INSTALL = `set -e
d=$1
rel=\${PF_ORCA_RELEASES:-https://github.com/SoftFever/OrcaSlicer/releases}
${SIZE_OF}
${ORCA_LIBFIX}
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
keep="$tmp/extra-lib"; [ -d "$HOME/.local/share/orca-slicer/extra-lib" ] && mv "$HOME/.local/share/orca-slicer/extra-lib" "$keep"
rm -rf "$HOME/.local/share/orca-slicer"
mv "$tmp/squashfs-root" "$HOME/.local/share/orca-slicer"
[ -d "$keep" ] && mv "$keep" "$HOME/.local/share/orca-slicer/extra-lib"
echo "$ver" > "$HOME/.local/share/orca-slicer/VERSION"
printf '#!/bin/sh\\nexport LD_LIBRARY_PATH="$HOME/.local/share/orca-slicer/extra-lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\\n' > "$HOME/.local/bin/orca-slicer"
chmod +x "$HOME/.local/bin/orca-slicer"
rm -rf "$tmp"
echo "OrcaSlicer $ver installed to ~/.local/share/orca-slicer"
fix_libs
`;

/// An existing extracted install that can't load some libraries: fix only that.
export const ORCA_LIBS_INSTALL = `set -e
d=$1
${ORCA_LIBFIX}
fix_libs
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

const LOCKS = "setup_locks";
const LAUNCH_LOCK_SECS = 60;

/// Launch an install job. Calls run concurrently (manifest `concurrency`), so
/// two page loads can both decide an install is needed; an atomic claim lets
/// only one launch it — the loser reports whatever job is on record.
function startJob(name: SetupName, reason: string, script: string = SCRIPTS[name]): SetupJob | null {
  if (!storePutIfAbsent(LOCKS, name, Date.now(), LAUNCH_LOCK_SECS)) return getJob(name);
  const dir = `${storageDir()}/setup/${name}`;
  const pid = Number(sh(LAUNCH, [dir, script], 30).trim());
  const job: SetupJob = { name, status: "running", reason, dir, pid: isFinite(pid) ? pid : 0, started_at: Date.now() };
  if (name === "bridge") job.target = MIN_BRIDGE_VERSION;
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
    if (job.name === "orca") {
      invalidateRoots();
      libsMemo = null;
    } else invalidateBridgeToken();
  } else {
    next.status = "failed";
    next.error = failureReason(s.LOG ?? "", exited ? exitCode : null);
    if (exitCode === 3 && job.name === "bridge") next.no_systemd = true;
  }
  storePut(JOBS, job.name, next);
  storeDelete(LOCKS, job.name); // settled: the next launch may claim it
  if (next.status === "succeeded") return { job: next, view: { status: "ok" } };
  return { job: next, view: { status: "failed", reason: next.reason, error: next.error, log_tail: next.log_tail, no_systemd: next.no_systemd } };
}

// ── what's needed ───────────────────────────────────────────────────────────

// `ldd` the extracted install with the dirs its launcher (libexec/
// orca-slicer-env) and slice.ts put on LD_LIBRARY_PATH.
const LIBS_PROBE = `O="$HOME/.local/share/orca-slicer"
[ -x "$O/bin/orca-slicer" ] && command -v ldd >/dev/null 2>&1 || exit 0
LD_LIBRARY_PATH="$O/extra-lib:$O/lib/orca-runtime:$O/lib:$O/bin" ldd "$O/bin/orca-slicer" 2>/dev/null | awk '/not found/{print $1}' | sort -u
true`;

const LIBS_TTL_MS = 5 * 60_000;
let libsMemo: { at: number; libs: string[] } | null = null;

/// Shared libraries the extracted OrcaSlicer can't load (empty = fine, or not
/// an extracted install).
export function missingOrcaLibs(): string[] {
  const now = Date.now();
  if (libsMemo && now - libsMemo.at < LIBS_TTL_MS) return libsMemo.libs;
  const libs = sh(LIBS_PROBE, [], 30).split("\n").map((s) => s.trim()).filter(Boolean);
  libsMemo = { at: now, libs };
  return libs;
}

/// Why OrcaSlicer must be installed (no binary, or no profiles), "libs" when
/// the extracted install can't load some host libraries, "config" when the
/// user's own `orca_path` points nowhere (installing wouldn't help), or null
/// when slicing is ready.
function orcaNeed(): { kind: "missing" | "libs" | "config"; reason: string } | null {
  const profiles = !!orcaProfilesDir() || detectRoots().some((r) => r.kind === "system");
  const bin = findOrca();
  if (bin && bin.via !== "flatpak") {
    const libs = missingOrcaLibs();
    if (libs.length) return { kind: "libs", reason: `OrcaSlicer can't start: ${libs.join(", ")} ${libs.length === 1 ? "is" : "are"} missing on this host` };
  }
  if (profiles && bin) return null;
  if (!bin && orcaPath() !== DEFAULT_ORCA_PATH) {
    return { kind: "config", reason: `the “OrcaSlicer executable” setting (${orcaPath()}) doesn't point at a program on this host` };
  }
  // An extracted install we can't fully use: never clobber it.
  if (sh('[ -e "$HOME/.local/share/orca-slicer/AppRun" ] && echo y; true', [], 15).trim() === "y") return null;
  return { kind: "missing", reason: bin ? "no OrcaSlicer profiles on this host" : "OrcaSlicer isn't installed" };
}

/// Why print-bridge must be (re)installed, or null. Only for the default
/// loopback URL — a bridge the user runs elsewhere is theirs to manage. Pure.
export function bridgeNeed(health: BridgeHealth, url: string): { kind: "missing" | "upgrade"; reason: string; target?: string } | null {
  if (url.replace(/\/+$/, "") !== DEFAULT_BRIDGE_URL) return null;
  if (health.reachable) {
    return versionLt(health.version ?? "", MIN_BRIDGE_VERSION)
      ? { kind: "upgrade", reason: `print-bridge ${health.version ?? "(unknown version)"} is older than ${MIN_BRIDGE_VERSION}`, target: MIN_BRIDGE_VERSION }
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
  if (force) storeDelete(LOCKS, force);
  if (!force && okMemo && now - okMemo < OK_TTL_MS) return { orca: { status: "ok" }, bridge: null, notices: [] };

  let orcaJob = getJob("orca");
  const oNeed = orcaJob?.status === "running" ? null : orcaNeed();
  let orca: SetupView;
  if (oNeed?.kind === "config") {
    orca = { status: "failed", reason: oNeed.reason, error: `Slicing is unavailable: ${oNeed.reason}. Clear the setting to let Print Farm install OrcaSlicer itself.` };
  } else {
    const need = oNeed ? { kind: "missing" as const, reason: oNeed.reason } : null;
    if (shouldStart(orcaJob, need, now, force === "orca")) {
      orcaJob = startJob("orca", need!.reason, oNeed!.kind === "libs" ? ORCA_LIBS_INSTALL : ORCA_INSTALL);
    }
    orca = viewOf(orcaJob, need);
  }

  let bridge: SetupView | null = null;
  const notices: string[] = [];
  const printers = listPrinters();
  if (printers.some((p) => p.type === "bambu")) {
    let bJob = getJob("bridge");
    const cfg = bridgeConfig();
    let health: BridgeHealth | null = null;
    let bNeed: { kind: "missing" | "upgrade"; reason: string; target?: string } | null = null;
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
