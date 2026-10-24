// Profile detail and OrcaSlicer User presets (create / update / rename /
// delete). User presets live where the Orca GUI keeps them —
// `<orca config>/user/<user id>/{machine,filament,process}/<name>.json`, with
// a `<name>.info` sidecar — and are written the way Orca writes them: only the
// keys that differ from the parent, plus `name`, `inherits` (a SYSTEM preset),
// `from: "User"`, `version`, `is_custom_defined` and the kind's
// `*_settings_id`. So the GUI lists them and the CLI flattens them like any
// other user preset (profiles.ts flattenProfile). System presets are read-only.

import { sh, writeText } from "./storage";
import { ApiError, fieldError } from "./apierror";
import { presetValue, PresetValue } from "./farmsettings";
import {
  ProfileKind,
  ProfileEntry,
  KIND_DIR,
  detectRoots,
  scanProfiles,
  grepByName,
  readJson,
  resolveProfile,
  invalidateRoots,
} from "./profiles";

export interface ProfileView {
  kind: string;
  name: string;
  vendor: string;
  user: boolean;
  inherits: string | null;
  own: Record<string, unknown>;
  resolved: Record<string, unknown> | null;
  resolve_error?: string;
  path: string;
}

/// Bookkeeping keys: not part of a preset's "own" settings.
const META = new Set([
  "name",
  "inherits",
  "from",
  "version",
  "type",
  "instantiation",
  "is_custom_defined",
  "setting_id",
  "base_id",
  "user_id",
  "updated_time",
  "filament_settings_id",
  "print_settings_id",
  "printer_settings_id",
]);

/// The `*_settings_id` key Orca stamps on each kind; filaments carry a list.
const SETTINGS_ID: Record<ProfileKind, string> = {
  printer: "printer_settings_id",
  process: "print_settings_id",
  filament: "filament_settings_id",
};

// ── pure ────────────────────────────────────────────────────────────────────

/// A preset name Orca (and every file system) accepts.
export function validPresetName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw fieldError("name", "name is required");
  if (s.length > 100) throw fieldError("name", "name is too long (max 100)");
  if (/[<>:"/\\|?*\x00-\x1f]/.test(s) || s.startsWith(".")) {
    throw fieldError("name", 'name can\'t contain < > : " / \\ | ? * or start with "."');
  }
  return s;
}

export function ownSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!META.has(k)) own[k] = v;
  return own;
}

/// Coerce edited values to Orca's on-disk shapes: strings, and string lists
/// wherever the parent has a list (per-extruder keys). Pure — tested.
export function normaliseOwn(ownIn: unknown, parent: Record<string, unknown> | null): Record<string, PresetValue> {
  if (ownIn === undefined || ownIn === null) return {};
  if (typeof ownIn !== "object" || Array.isArray(ownIn)) throw fieldError("own", "own must be an object of Orca settings");
  const out: Record<string, PresetValue> = {};
  for (const [k, v] of Object.entries(ownIn as Record<string, unknown>)) {
    if (!/^[a-z0-9_]+$/.test(k)) throw fieldError("own", `'${k}' is not an Orca setting name`);
    if (META.has(k)) continue;
    let val = presetValue(v, `own.${k}`);
    const p = parent?.[k];
    if (Array.isArray(p) && !Array.isArray(val)) val = p.length > 1 ? p.map(() => val as string) : [val];
    out[k] = val;
  }
  return out;
}

/// The JSON Orca writes for a user preset (keys sorted, as Orca's writer
/// does). Pure — tested.
export function userPresetJson(
  kind: ProfileKind,
  name: string,
  inherits: string,
  own: Record<string, PresetValue>,
  version: string,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    ...own,
    [SETTINGS_ID[kind]]: kind === "filament" ? [name] : name,
    from: "User",
    inherits,
    is_custom_defined: "0",
    name,
    version,
  };
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) sorted[k] = doc[k];
  return sorted;
}

/// Orca's `.info` sidecar (Preset::save_info). `base_id` = the parent's
/// setting_id. Pure.
export function userPresetInfo(baseId: string, now: number): string {
  return `sync_info = \nuser_id = \nsetting_id = \nbase_id = ${baseId}\nupdated_time = ${Math.floor(now / 1000)}\n`;
}

/// Orca's 4-part preset version from an app version ("2.4.2" → "2.4.2.0").
export function presetVersion(app: string): string {
  const parts = app.trim().split(".").filter((p) => /^\d+$/.test(p));
  if (!parts.length) return "2.3.0.0";
  while (parts.length < 4) parts.push("0");
  return parts.slice(0, 4).join(".");
}

// ── host-backed ─────────────────────────────────────────────────────────────

// $1 = a detected user root ("" = none yet). Prints the user-id dir to write
// into: the most recently used one, else `<root>/default` (Orca's dir when no
// account is signed in), created on demand.
const USER_DIR = `
r=$1
[ -n "$r" ] || r="$HOME/.config/OrcaSlicer/user"
if [ -d "$r" ]; then
  d=$(ls -1td "$r"/*/ 2>/dev/null | head -n 1)
  if [ -n "$d" ]; then echo "\${d%/}"; exit 0; fi
fi
mkdir -p "$r/default" && echo "$r/default"
`;

function userDir(): string {
  const root = detectRoots().find((r) => r.kind === "user")?.path ?? "";
  const dir = sh(USER_DIR, [root], 30).trim();
  if (!dir.startsWith("/")) throw new Error("could not find or create OrcaSlicer's user preset directory");
  if (!root) invalidateRoots();
  return dir;
}

function orcaVersion(): string {
  return presetVersion(sh('cat \"$HOME/.local/share/orca-slicer/VERSION\" 2>/dev/null; true', [], 15).split("\n")[0] ?? "");
}

function userEntries(kind: ProfileKind): ProfileEntry[] {
  return scanProfiles(detectRoots(), "User", kind, true);
}

/// A preset of `kind` by name: User presets first, then every system root.
export function findProfile(kind: ProfileKind, name: string): ProfileEntry | null {
  const user = userEntries(kind).find((e) => e.name === name);
  if (user) return user;
  return grepByName(detectRoots().filter((r) => r.kind === "system"), name, kind);
}

function requireProfile(kind: ProfileKind, name: string): ProfileEntry {
  const e = findProfile(kind, name);
  if (!e) throw new ApiError(404, `no ${KIND_DIR[kind]} preset named '${name}'`);
  return e;
}

export function profileView(kind: ProfileKind, e: ProfileEntry): ProfileView {
  const raw = readJson(e.path);
  const view: ProfileView = {
    kind: KIND_DIR[kind],
    name: e.name,
    vendor: e.vendor,
    user: e.source === "user",
    inherits: typeof raw.inherits === "string" && raw.inherits ? raw.inherits : null,
    own: ownSettings(raw),
    resolved: null,
    path: e.path,
  };
  try {
    view.resolved = resolveProfile(e.name, kind, e.vendor).profile;
  } catch (err) {
    view.resolve_error = (err as Error).message;
  }
  return view;
}

export function getProfile(kind: ProfileKind, name: string): ProfileView {
  return profileView(kind, requireProfile(kind, name));
}

/// A user preset's parent must be a system preset: inheriting from another
/// user preset folds that one's own settings in and takes ITS parent.
function parentFor(kind: ProfileKind, inherits: string, own: Record<string, unknown>): { inherits: string; own: Record<string, unknown>; baseId: string; flat: Record<string, unknown> | null } {
  if (!inherits) return { inherits: "", own, baseId: "", flat: null };
  const parent = findProfile(kind, inherits);
  if (!parent) throw fieldError("inherits", `no ${KIND_DIR[kind]} preset named '${inherits}'`);
  const raw = readJson(parent.path);
  if (parent.source === "user") {
    const grand = typeof raw.inherits === "string" ? raw.inherits : "";
    return parentFor(kind, grand, { ...ownSettings(raw), ...own });
  }
  const flat = resolveProfile(parent.name, kind, parent.vendor).profile;
  return { inherits: parent.name, own, baseId: typeof raw.setting_id === "string" ? raw.setting_id : "", flat };
}

function writePreset(kind: ProfileKind, name: string, inherits: string, ownIn: unknown): string {
  const ownRaw = ownIn === undefined || ownIn === null ? {} : ownIn;
  if (typeof ownRaw !== "object" || Array.isArray(ownRaw)) throw fieldError("own", "own must be an object of Orca settings");
  const p = parentFor(kind, inherits, ownRaw as Record<string, unknown>);
  const own = normaliseOwn(p.own, p.flat);
  const dir = `${userDir()}/${KIND_DIR[kind]}`;
  sh('mkdir -p -- "$1"', [dir]);
  const path = `${dir}/${name}.json`;
  writeText(path, JSON.stringify(userPresetJson(kind, name, p.inherits, own, orcaVersion()), null, 4) + "\n");
  writeText(`${dir}/${name}.info`, userPresetInfo(p.baseId, Date.now()));
  return path;
}

function removePreset(path: string): void {
  sh('rm -f -- "$1" "${1%.json}.info"', [path]);
}

function exists(kind: ProfileKind, name: string): boolean {
  return !!findProfile(kind, name);
}

export function createProfile(kind: ProfileKind, body: any): ProfileView {
  const name = validPresetName(body?.name);
  if (exists(kind, name)) throw new ApiError(409, "exists", { message: `a ${KIND_DIR[kind]} preset named '${name}' already exists` });
  const inherits = typeof body?.inherits === "string" ? body.inherits.trim() : "";
  if (!inherits && (!body?.own || !Object.keys(body.own).length)) {
    throw fieldError("inherits", "inherits (the preset to start from) is required unless own carries a full preset");
  }
  writePreset(kind, name, inherits, body?.own);
  userEntries(kind);
  return getProfile(kind, name);
}

function requireUser(kind: ProfileKind, name: string): ProfileEntry {
  const e = requireProfile(kind, name);
  if (e.source !== "user") throw new ApiError(403, "read_only", { message: `'${name}' is a system preset; duplicate it to edit` });
  return e;
}

export function updateProfile(kind: ProfileKind, name: string, body: any): ProfileView {
  const e = requireUser(kind, name);
  const raw = readJson(e.path);
  const newName = body?.name !== undefined ? validPresetName(body.name) : name;
  if (newName !== name && exists(kind, newName)) {
    throw new ApiError(409, "exists", { message: `a ${KIND_DIR[kind]} preset named '${newName}' already exists` });
  }
  const inherits = body?.inherits !== undefined ? String(body.inherits ?? "").trim() : typeof raw.inherits === "string" ? raw.inherits : "";
  const own = body?.own !== undefined ? body.own : ownSettings(raw);
  const path = writePreset(kind, newName, inherits, own);
  if (path !== e.path) removePreset(e.path);
  userEntries(kind);
  return getProfile(kind, newName);
}

export function deleteProfile(kind: ProfileKind, name: string): { ok: true } {
  const e = requireUser(kind, name);
  removePreset(e.path);
  userEntries(kind);
  return { ok: true };
}
