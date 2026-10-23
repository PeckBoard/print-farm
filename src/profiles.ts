// OrcaSlicer profile catalog.
//
// Layout on disk (both Orca's bundled `resources/profiles` and the per-user
// copy `~/.config/OrcaSlicer/system`):
//   <root>/<Vendor>.json                       vendor index
//   <root>/<Vendor>/{machine,filament,process}/**.json
// User presets: `~/.config/OrcaSlicer/user/<user-id>/{machine,filament,process}/*.json`.
//
// Each profile JSON names its parent with `inherits` (by preset NAME, usually
// within the same vendor; filaments also inherit from `OrcaFilamentLibrary`,
// user presets from any system preset). The CLI's `--load-settings` /
// `--load-filaments` want a self-contained file, so we flatten the chain
// (root → leaf, later keys win) and drop `inherits`.

import { sh } from "./storage";
import { orcaPath, orcaProfilesDir } from "./config";
import { storeGet, storePut } from "./host";

export type ProfileKind = "printer" | "filament" | "process";
export const KIND_DIR: Record<ProfileKind, string> = { printer: "machine", filament: "filament", process: "process" };
const KIND_TYPE: Record<ProfileKind, string> = { printer: "machine", filament: "filament", process: "process" };

export interface ProfileRoot {
  kind: "system" | "user";
  path: string;
}

export interface ProfileEntry {
  name: string;
  vendor: string;
  type: string;
  inherits: string;
  instantiable: boolean;
  /// Absolute path of the JSON file.
  path: string;
  source: "system" | "user";
}

// ── pure ────────────────────────────────────────────────────────────────────

export function parseKind(v: unknown): ProfileKind {
  const s = String(v ?? "").toLowerCase();
  if (s === "printer" || s === "machine") return "printer";
  if (s === "filament") return "filament";
  if (s === "process" || s === "print") return "process";
  throw new Error("kind must be printer, filament, or process");
}

/// Parse the root-detection script output ("system\t/path" lines), deduped.
export function parseRoots(out: string): ProfileRoot[] {
  const seen = new Set<string>();
  const roots: ProfileRoot[] = [];
  for (const line of out.split("\n")) {
    const [kind, path] = line.split("\t");
    if ((kind !== "system" && kind !== "user") || !path || seen.has(path)) continue;
    seen.add(path);
    roots.push({ kind, path });
  }
  return roots;
}

/// Parse the scan script's TSV (relpath, type, name, inherits, instantiation).
export function parseScan(out: string, root: string, vendor: string, source: "system" | "user"): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [rel, type, name, inherits, inst] = line.split("\t");
    if (!rel || !name) continue;
    entries.push({
      name,
      vendor,
      type: type || "",
      inherits: inherits || "",
      instantiable: inst !== "false",
      path: rel.startsWith("/") ? rel : `${root}/${rel.replace(/^\.\//, "")}`,
      source,
    });
  }
  return entries;
}

/// Flatten an `inherits` chain into one self-contained profile. `lookup`
/// returns a parsed profile by preset name (null = not found). Pure — tested.
export function flattenProfile(leaf: string, lookup: (name: string) => Record<string, unknown> | null): Record<string, unknown> {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let name = leaf;
  while (name) {
    if (seen.has(name)) throw new Error(`inherits cycle at '${name}'`);
    if (chain.length >= 16) throw new Error(`inherits chain too deep at '${name}'`);
    seen.add(name);
    const obj = lookup(name);
    if (!obj) {
      throw new Error(chain.length === 0 ? `profile '${name}' not found` : `parent profile '${name}' not found (inherited by '${leaf}')`);
    }
    chain.unshift(obj);
    name = typeof obj.inherits === "string" ? obj.inherits.trim() : "";
  }
  const merged: Record<string, unknown> = {};
  for (const obj of chain) Object.assign(merged, obj);
  delete merged.inherits;
  merged.name = leaf;
  // A flattened copy is no longer the vendor's system preset.
  merged.from = "User";
  return merged;
}

/// Is this machine profile a Bambu Lab printer (→ slice to .gcode.3mf)?
export function isBambuMachine(profile: Record<string, unknown>, vendor?: string): boolean {
  const model = String(profile.printer_model ?? "");
  return vendor === "BBL" || /^Bambu Lab/i.test(model) || /@BBL/.test(String(profile.name ?? ""));
}

// ── root detection ──────────────────────────────────────────────────────────

/// The program a wrapper script hands off to: the first `exec <path> …` line
/// (App Manager's `~/.local/bin/orca-slicer` is `exec "$HOME/.local/share/
/// orca-slicer/AppRun" "$@"`), with `$HOME` / `${HOME}` / `~` expanded.
/// Null when there's no such line or the path still has unexpanded `$`. Pure.
export function parseWrapperExec(text: string, home: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^exec\s+(.+)$/.exec(line);
    if (!m) continue;
    const rest = m[1].trim();
    let p: string;
    if (rest[0] === '"' || rest[0] === "'") {
      const end = rest.indexOf(rest[0], 1);
      if (end < 0) return null;
      p = rest.slice(1, end);
    } else {
      p = rest.split(/\s+/)[0];
    }
    p = p.replace(/\$\{HOME\}|\$HOME\b/g, home);
    if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
    if (!p || p.includes("$") || !p.startsWith("/")) return null;
    return p;
  }
  return null;
}

// $1 = configured command. Prints the resolved binary and, when it is a small
// script, its text (so a wrapper's exec target can be followed).
const BIN_PROBE = `
o=$1
b=$(command -v "$o" 2>/dev/null) || b=""
if [ -z "$b" ] && [ "$o" = orca-slicer ] && [ -x "$HOME/.local/bin/orca-slicer" ]; then b="$HOME/.local/bin/orca-slicer"; fi
printf 'home=%s\\n' "$HOME"
[ -n "$b" ] || exit 0
r=$(readlink -f "$b" 2>/dev/null) || r=$b
printf 'bin=%s\\n' "$r"
if [ -f "$r" ] && [ "$(wc -c < "$r")" -lt 4096 ] && [ "$(head -c 2 "$r")" = '#!' ]; then echo @@WRAPPER; cat "$r"; fi
true
`;

/// Parse BIN_PROBE output into the binary and (for a wrapper) its target. Pure.
export function parseBinProbe(out: string): { bin: string; target: string } {
  const at = out.indexOf("@@WRAPPER\n");
  const head = at >= 0 ? out.slice(0, at) : out;
  const kv: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const target = at >= 0 && kv.home ? parseWrapperExec(out.slice(at + 10), kv.home) ?? "" : "";
  return { bin: kv.bin ?? "", target };
}

// $1 = explicit roots, $2 = the resolved binary, $3 = a wrapper's exec target.
const ROOTS_SCRIPT = `
explicit=$1
emit() { [ -d "$2" ] && printf '%s\\t%s\\n' "$1" "$(cd "$2" && pwd -P)"; }
if [ -n "$explicit" ]; then
  old=$IFS; IFS=:; for d in $explicit; do emit system "$d"; done; IFS=$old
fi
for b in "$2" "$3"; do
  [ -n "$b" ] || continue
  b=$(readlink -f "$b" 2>/dev/null) || continue
  bd=$(dirname "$b")
  emit system "$bd/resources/profiles"; emit system "$bd/../resources/profiles"
  emit system "$bd/../share/OrcaSlicer/resources/profiles"; emit system "$bd/usr/share/OrcaSlicer/resources/profiles"
done
for d in "$HOME/.local/share/orca-slicer/resources/profiles" "$HOME/.local/share/orca-slicer/usr/share/OrcaSlicer/resources/profiles" \\
  "$HOME/Applications/squashfs-root/resources/profiles" \\
  /usr/share/OrcaSlicer/resources/profiles /usr/local/share/OrcaSlicer/resources/profiles \\
  /opt/OrcaSlicer/resources/profiles /opt/orca-slicer/resources/profiles /app/share/OrcaSlicer/resources/profiles \\
  /var/lib/flatpak/app/com.orcaslicer.OrcaSlicer/current/active/files/share/OrcaSlicer/resources/profiles \\
  "$HOME/.local/share/flatpak/app/com.orcaslicer.OrcaSlicer/current/active/files/share/OrcaSlicer/resources/profiles" \\
  /var/lib/flatpak/app/io.github.softfever.OrcaSlicer/current/active/files/share/OrcaSlicer/resources/profiles \\
  "$HOME/.local/share/flatpak/app/io.github.softfever.OrcaSlicer/current/active/files/share/OrcaSlicer/resources/profiles" \\
  "$HOME/.config/OrcaSlicer/system" "$HOME/.var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer/system" \\
  "$HOME/.var/app/io.github.softfever.OrcaSlicer/config/OrcaSlicer/system"; do
  emit system "$d"
done
for d in "$HOME/.config/OrcaSlicer/user" "$HOME/.var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer/user" \\
  "$HOME/.var/app/io.github.softfever.OrcaSlicer/config/OrcaSlicer/user"; do
  emit user "$d"
done
true
`;

// Detection runs a few execs; status polls and tool calls hit it often, and
// an install finishing calls invalidateRoots().
const ROOTS_TTL_MS = 20_000;
let rootsMemo: { key: string; at: number; roots: ProfileRoot[] } | null = null;

export function invalidateRoots(): void {
  rootsMemo = null;
}

export function detectRoots(): ProfileRoot[] {
  const key = orcaProfilesDir() + "\n" + orcaPath();
  const now = Date.now();
  if (rootsMemo && rootsMemo.key === key && now - rootsMemo.at < ROOTS_TTL_MS) return rootsMemo.roots;
  const { bin, target } = parseBinProbe(sh(BIN_PROBE, [orcaPath()], 30));
  const roots = parseRoots(sh(ROOTS_SCRIPT, [orcaProfilesDir(), bin, target], 30));
  rootsMemo = { key, at: now, roots };
  return roots;
}

/// Identity of the current roots — cache keys change when an install adds one.
export function rootsSig(roots: ProfileRoot[]): string {
  return roots.map((r) => r.path).join(":");
}

// ── scanning ────────────────────────────────────────────────────────────────

// awk pulls the top-level type/name/inherits/instantiation string fields out
// of each (pretty-printed) profile JSON; one TSV line per file.
const AWK = `
function emit() { if (p != "") printf "%s\\t%s\\t%s\\t%s\\t%s\\n", p, t, n, h, s }
FNR == 1 { emit(); p = FILENAME; t = ""; n = ""; h = ""; s = "" }
/^[ \\t]*"(type|name|inherits|instantiation)"[ \\t]*:[ \\t]*"/ {
  line = $0; sub(/^[ \\t]*"/, "", line); k = line; sub(/".*/, "", k)
  v = line; sub(/^[^:]*:[ \\t]*"/, "", v); sub(/".*$/, "", v)
  if (k == "type" && t == "") t = v
  else if (k == "name" && n == "") n = v
  else if (k == "inherits" && h == "") h = v
  else if (k == "instantiation" && s == "") s = v
}
END { emit() }
`;

/// Vendors present in the system roots (dirs holding machine/filament/process).
export function listVendors(roots: ProfileRoot[]): string[] {
  const vendors = new Set<string>();
  for (const r of roots.filter((x) => x.kind === "system")) {
    const out = sh(
      'cd "$1" && for d in */; do d=${d%/}; [ -d "$d/machine" ] || [ -d "$d/filament" ] || [ -d "$d/process" ] && echo "$d"; done; true',
      [r.path],
      30,
    );
    for (const v of out.split("\n")) if (v.trim()) vendors.add(v.trim());
  }
  const list = [...vendors].sort((a, b) => a.localeCompare(b));
  if (roots.some((r) => r.kind === "user")) list.unshift("User");
  return list;
}

function scanSystem(root: string, vendor: string, kind: ProfileKind): ProfileEntry[] {
  const out = sh(
    'cd "$1" && [ -d "$2/$3" ] || exit 0; find "$2/$3" -type f -name "*.json" -exec awk "$4" {} +',
    [root, vendor, KIND_DIR[kind], AWK],
    120,
  );
  return parseScan(out, root, vendor, "system");
}

function scanUser(root: string, kind: ProfileKind): ProfileEntry[] {
  const out = sh(
    'cd "$1" && find . -path "*/$2/*" -type f -name "*.json" -exec awk "$3" {} + ; true',
    [root, KIND_DIR[kind], AWK],
    60,
  );
  return parseScan(out, root, "User", "user");
}

const INDEX = "profile_index";
const CACHE_MAX = 200 * 1024;

/// All profiles of `kind` for `vendor` ("User" = user presets). Cached in
/// data_store per (vendor, kind) when small enough; `refresh` rescans.
export function scanProfiles(roots: ProfileRoot[], vendor: string, kind: ProfileKind, refresh = false): ProfileEntry[] {
  const key = `${vendor}|${kind}`;
  if (!refresh) {
    const hit = storeGet(INDEX, key);
    if (hit && Array.isArray(hit.entries) && hit.entries.length && hit.roots === rootsSig(roots)) return hit.entries;
  }
  let entries: ProfileEntry[] = [];
  if (vendor === "User") {
    for (const r of roots.filter((x) => x.kind === "user")) entries = entries.concat(scanUser(r.path, kind));
  } else {
    // First system root that carries this vendor wins (bundled resources
    // before the ~/.config copy only if listed first; both are equivalent).
    for (const r of roots.filter((x) => x.kind === "system")) {
      const found = scanSystem(r.path, vendor, kind);
      if (found.length) {
        entries = found;
        break;
      }
    }
  }
  entries = entries.filter((e) => !e.type || e.type === KIND_TYPE[kind]);
  // Never cache an empty scan: it would outlive the install that fills it.
  const doc = { roots: rootsSig(roots), entries };
  if (entries.length && JSON.stringify(doc).length < CACHE_MAX) storePut(INDEX, key, doc);
  return entries;
}

/// Parse `<Vendor>/machine/<Name>.json` lines. Pure.
export function parseMachineFiles(out: string): { vendor: string; name: string }[] {
  const res: { vendor: string; name: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^/]+)\/machine\/(.+)\.json$/.exec(line.trim());
    if (m) res.push({ vendor: m[1], name: m[2] });
  }
  return res;
}

/// Every vendor machine preset by file name (Orca names files after the
/// preset), across the system roots; the first root carrying a vendor wins.
export function listMachineFiles(roots: ProfileRoot[]): { vendor: string; name: string }[] {
  const seen = new Set<string>();
  const out: { vendor: string; name: string }[] = [];
  for (const r of roots.filter((x) => x.kind === "system")) {
    const files = parseMachineFiles(sh('cd "$1" && for f in */machine/*.json; do [ -f "$f" ] && echo "$f"; done; true', [r.path], 60));
    const vendors = new Set(files.map((f) => f.vendor));
    for (const f of files) if (!seen.has(f.vendor)) out.push(f);
    vendors.forEach((v) => seen.add(v));
  }
  return out;
}

function readJson(path: string): Record<string, unknown> {
  const text = sh('cat -- "$1"', [path], 30);
  try {
    return JSON.parse(text);
  } catch (_e) {
    throw new Error(`profile ${path} is not valid JSON`);
  }
}

/// Find a preset file by name anywhere in the system roots (slow path for a
/// parent we didn't find in the likely vendors).
function grepByName(roots: ProfileRoot[], name: string, kind: ProfileKind): ProfileEntry | null {
  for (const r of roots) {
    const out = sh(
      'cd "$1" && grep -rlF --include="*.json" -- "\\"$2\\"" . 2>/dev/null | while read -r f; do ' +
        'case "$f" in */$3/*) awk "$4" "$f";; esac; done; true',
      [r.path, name, KIND_DIR[kind], AWK],
      120,
    );
    const hit = parseScan(out, r.path, "?", r.kind).find((e) => e.name === name);
    if (hit) {
      hit.vendor = r.kind === "user" ? "User" : hit.path.slice(r.path.length + 1).split("/")[0];
      return hit;
    }
  }
  return null;
}

/// Resolve and flatten a named preset. `vendor` is where to look first
/// (the UI passes the vendor the user picked the preset from).
export function resolveProfile(name: string, kind: ProfileKind, vendor?: string): { profile: Record<string, unknown>; vendor: string } {
  const roots = detectRoots();
  if (!roots.length) throw new Error("no OrcaSlicer profile directories found; set orca_profiles_dir");
  const search: string[] = [];
  if (vendor) search.push(vendor);
  search.push("User");
  if (kind === "filament") search.push("OrcaFilamentLibrary");
  const indexes: ProfileEntry[][] = [];
  const indexFor = (i: number) => (indexes[i] ??= scanProfiles(roots, search[i], kind));
  const cache = new Map<string, Record<string, unknown> | null>();
  let leafVendor = vendor ?? "";
  const lookup = (n: string): Record<string, unknown> | null => {
    if (cache.has(n)) return cache.get(n)!;
    let entry: ProfileEntry | null = null;
    for (let i = 0; i < search.length && !entry; i++) entry = indexFor(i).find((e) => e.name === n) ?? null;
    if (!entry) entry = grepByName(roots, n, kind);
    const obj = entry ? readJson(entry.path) : null;
    if (obj && n === name && entry) leafVendor = entry.vendor;
    cache.set(n, obj);
    return obj;
  };
  const profile = flattenProfile(name, lookup);
  return { profile, vendor: leafVendor };
}
