// On-disk storage for uploaded models, sliced G-code, materialised profiles
// and slice-job scratch dirs.
//
// WHY DISK (and why this dir): models and G-code run to tens of MB, far past
// data_store's 256 KiB document cap, and the printer uploads stream them with
// curl straight from disk. Core gives plugins no private file API, so files
// are written with `peckboard_exec_any` — which runs inside Peckboard's agent
// sandbox: the Peckboard data dir is DENIED (read and write), the caller's
// project folder is writable only for MCP calls, and `<data_dir>/plugin-exec`
// only for UI calls. The one location writable from BOTH an agent's tool call
// and the UI is under $HOME's writable set, so the default is
// `${XDG_DATA_HOME:-~/.local/share}/peckboard-print-farm` (override with the
// `storage_dir` setting; it must stay inside the sandbox's writable set).
//
// Data crosses the wasm boundary as base64 in argv (no stdin on exec): writes
// go in ≤96 KiB argv pieces, reads come back ≤768 KiB per call (exec stdout is
// capped at 1 MiB). Metadata lives in data_store ("files").

import { execAny, storeGet, storePut, storeList, storeDelete } from "./host";
import { storageDirSetting } from "./config";
import { nextSeq } from "./counter";
import { utf8ToBase64 } from "./b64";
import type { GcodeEstimate } from "./gcode";

// ── shell helper ────────────────────────────────────────────────────────────

/// Run `sh -c script` with positional args; throws on non-zero exit.
export function sh(script: string, args: string[] = [], timeoutSecs = 60): string {
  const r = execAny("sh", ["-c", script, "sh", ...args], timeoutSecs);
  if (r.timed_out) throw new Error("command timed out");
  if (r.exit_code !== 0) {
    const msg = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(msg || `command failed (exit ${r.exit_code})`);
  }
  return r.stdout;
}

// ── detached jobs ─────────────────────────────────────────────────────────────
// Each exec may run in its own PID namespace, so a later poll's `kill -0`
// can't see a job started by an earlier call. Jobs (with `$d` = their dir)
// touch `$d/hb` every 5 s until they write `$d/exit`; polls (with `$d` and
// `$pid`) count a fresh heartbeat as alive. No single quotes: both go inside
// single-quoted `sh -c` scripts.

export const JOB_HEARTBEAT = '(while [ ! -e "$d/exit" ]; do touch "$d/hb"; sleep 5; done) &';
export const JOB_ALIVE =
  'if [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; then echo 1; ' +
  'elif [ -e "$d/hb" ] && [ $(( $(date +%s) - $(stat -c %Y "$d/hb") )) -lt 30 ]; then echo 1; else echo 0; fi';

// ── storage dir ─────────────────────────────────────────────────────────────

let cachedDir: string | null = null;

export function storageDir(): string {
  if (cachedDir) return cachedDir;
  const override = storageDirSetting();
  const out = sh(
    'd=${1:-${XDG_DATA_HOME:-$HOME/.local/share}/peckboard-print-farm}; ' +
      'mkdir -p "$d/files" "$d/jobs" "$d/snapshots" && cd "$d" && pwd -P',
    [override],
  ).trim();
  if (!out.startsWith("/")) throw new Error("could not resolve the storage dir");
  cachedDir = out;
  return out;
}

// ── pure helpers ────────────────────────────────────────────────────────────

/// Keep a file name safe for disk, curl -F, and printer file systems.
export function safeName(name: string): string {
  const base = String(name || "file").split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[^A-Za-z0-9._ +()-]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(0, 120);
}

export type FileKind = "model" | "gcode" | "gcode.3mf" | "bgcode" | "image" | "other";

export function kindOf(name: string): FileKind {
  const n = name.toLowerCase();
  if (n.endsWith(".gcode.3mf")) return "gcode.3mf";
  if (n.endsWith(".gcode") || n.endsWith(".gco") || n.endsWith(".g")) return "gcode";
  if (n.endsWith(".bgcode")) return "bgcode";
  if (/\.(stl|3mf|step|stp|obj|amf)$/.test(n)) return "model";
  if (/\.(jpe?g|png)$/.test(n)) return "image";
  return "other";
}

/// Split base64 into argv-sized pieces on 4-char boundaries.
export function splitB64(b64: string, piece = 96 * 1024): string[] {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) throw new Error("data_base64 is not valid base64 (length)");
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += piece) out.push(clean.slice(i, i + piece));
  return out;
}

// ── raw file I/O ────────────────────────────────────────────────────────────

export const MAX_CHUNK_B64 = 1024 * 1024; // per call; the UI request body is ≤2 MiB

/// Append (or, with truncate, create) base64 data to an absolute path.
/// Returns the file size afterwards.
export function writeB64(path: string, b64: string, truncate: boolean): number {
  if (b64.length > MAX_CHUNK_B64 * 2) throw new Error("chunk too large; send ≤1 MiB of base64 per call");
  const pieces = splitB64(b64);
  const out = sh(
    'f=$1; t=$2; shift 2; if [ "$t" = 1 ]; then : > "$f" || exit 1; fi; ' +
      '{ for a in "$@"; do printf %s "$a"; done; } | base64 -d >> "$f" && wc -c < "$f"',
    [path, truncate ? "1" : "0", ...pieces],
    120,
  );
  return Number(out.trim()) || 0;
}

export function writeText(path: string, text: string): void {
  // Text goes through base64 too so any byte survives argv intact.
  writeB64(path, utf8ToBase64(text), true);
}

export const MAX_READ = 768 * 1024;

/// Read `length` bytes at `offset` as base64, plus the total size.
export function readB64(path: string, offset: number, length: number): { size: number; data_base64: string } {
  const len = Math.max(0, Math.min(length, MAX_READ));
  const off = Math.max(0, Math.floor(offset));
  const out = sh(
    'f=$1; s=$(wc -c < "$f") || exit 1; echo "$s"; ' +
      'tail -c +$(($2 + 1)) "$f" | head -c "$3" | base64 -w0',
    [path, String(off), String(len)],
    60,
  );
  const nl = out.indexOf("\n");
  return { size: Number(out.slice(0, nl).trim()) || 0, data_base64: out.slice(nl + 1).trim() };
}

/// First and last `n` bytes of a text file (G-code header/footer comments).
export function headTail(path: string, n = 64 * 1024): string {
  return sh('head -c "$2" "$1"; echo; echo "; ---PF-TAIL---"; tail -c "$2" "$1"', [path, String(n)], 60);
}

export function removePath(path: string): void {
  sh('rm -rf -- "$1"', [path]);
}

// ── file registry ───────────────────────────────────────────────────────────

const FILES = "files";

export interface FileRecord {
  id: string;
  name: string;
  kind: FileKind;
  path: string;
  size: number;
  complete: boolean;
  source: "upload" | "slice" | "project" | "snapshot";
  /// Slice jobs: what produced it.
  slice_job?: string;
  /// G-code estimates (see gcode.ts).
  estimate?: GcodeEstimate;
}

export function newFileRecord(name: string, source: FileRecord["source"]): FileRecord {
  const id = "f" + nextSeq("file_seq");
  const safe = safeName(name);
  return { id, name: safe, kind: kindOf(safe), path: `${storageDir()}/files/${id}-${safe}`, size: 0, complete: false, source };
}

export function putFile(f: FileRecord): void {
  storePut(FILES, f.id, f);
}

export function getFile(id: string): FileRecord | null {
  return (storeGet(FILES, id) as FileRecord) ?? null;
}

export function requireFile(id: unknown): FileRecord {
  const f = typeof id === "string" ? getFile(id.trim()) : null;
  if (!f) throw new Error(`unknown file '${String(id)}'`);
  return f;
}

export function listFiles(): FileRecord[] {
  return storeList(FILES)
    .map((i) => i.value as FileRecord)
    .filter((f) => f && f.id)
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
}

export function deleteFile(id: string): void {
  const f = getFile(id);
  if (f) removePath(f.path);
  storeDelete(FILES, id);
}

/// Chunked upload: create (offset 0) or continue a file. Idempotent per
/// offset: a retried chunk whose offset doesn't match the current size fails
/// with the expected offset so the client can resume.
export function uploadChunk(
  file: FileRecord,
  offset: number,
  dataB64: string,
  done: boolean,
): FileRecord {
  if (file.complete) throw new Error("file upload already finished");
  if (offset !== file.size) throw new Error(`offset mismatch: expected ${file.size}`);
  const size = dataB64 ? writeB64(file.path, dataB64, offset === 0) : file.size;
  const next: FileRecord = { ...file, size, complete: done };
  putFile(next);
  return next;
}

/// Copy a file from the caller's project folder (MCP calls run exec with the
/// project folder as cwd) into storage.
export function importProjectFile(relPath: string): FileRecord {
  const p = String(relPath || "").trim();
  if (!p || p.startsWith("/") || p.split(/[\\/]/).includes("..")) {
    throw new Error("path must be relative to the project folder, without '..'");
  }
  const rec = newFileRecord(p, "project");
  const size = sh('cp -- "$1" "$2" && wc -c < "$2"', [p, rec.path], 120).trim();
  const done: FileRecord = { ...rec, size: Number(size) || 0, complete: true };
  putFile(done);
  return done;
}
