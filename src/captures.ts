// Camera stills a user (or agent) chose to keep: JPEG/PNG files under the
// storage dir's `captures/`, metadata in data_store ("captures"). The WASM
// sandbox has no reliable clock, so `taken_at` comes from the host's `date`.

import { storeGet, storePut, storeList, storeDelete } from "./host";
import { nextSeq } from "./counter";
import { storageDir, writeB64, readB64, removePath, sh, MAX_READ } from "./storage";
import { PrinterRecord, DriverError } from "./drivers/types";
import { driverFor } from "./drivers";
import { defaultTransport } from "./transport";
import { bridgeConfig } from "./config";

const CAPTURES = "captures";

export interface Capture {
  id: string;
  printer_id: string;
  /// ISO-8601 UTC.
  taken_at: string;
  size: number;
  content_type: string;
  path: string;
}

export interface PublicCapture {
  id: string;
  printer_id: string;
  taken_at: string;
  size: number;
  content_type: string;
  /// Relative to the plugin UI API root.
  url: string;
}

export function publicCapture(c: Capture): PublicCapture {
  return { id: c.id, printer_id: c.printer_id, taken_at: c.taken_at, size: c.size, content_type: c.content_type, url: `captures/${c.id}` };
}

export function getCapture(id: string): Capture | null {
  return (storeGet(CAPTURES, id) as Capture) ?? null;
}

export function requireCapture(id: string): Capture {
  const c = getCapture(id);
  if (!c) throw new DriverError(404, `unknown capture '${id}'`);
  return c;
}

/// Newest first; `printer` filters by printer id.
export function listCaptures(printer?: string): Capture[] {
  return storeList(CAPTURES)
    .map((i) => i.value as Capture)
    .filter((c) => c && c.id && (!printer || c.printer_id === printer))
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
}

/// Grab a frame from `p`'s camera and keep it. Returns it with its data.
export function takeCapture(p: PrinterRecord): { capture: Capture; data_base64: string } {
  const snap = driverFor(p, defaultTransport, bridgeConfig()).snapshot();
  if (!snap) throw new DriverError(404, "this printer has no camera");
  const ext = /png/i.test(snap.content_type) ? "png" : "jpg";
  const id = "c" + nextSeq("capture_seq");
  const path = `${storageDir()}/captures/${id}.${ext}`;
  const size = writeB64(path, snap.data_base64, true);
  const taken_at = sh("date -u +%Y-%m-%dT%H:%M:%SZ").trim();
  const capture: Capture = { id, printer_id: p.id, taken_at, size, content_type: snap.content_type || "image/jpeg", path };
  storePut(CAPTURES, id, capture);
  return { capture, data_base64: snap.data_base64 };
}

/// A capture's bytes as base64, ranged like `GET files/:id` (≤768 KiB per call).
export function readCapture(c: Capture, offset = 0, length = MAX_READ) {
  const r = readB64(c.path, offset, length);
  const got = Math.floor((r.data_base64.length * 3) / 4) - (r.data_base64.endsWith("==") ? 2 : r.data_base64.endsWith("=") ? 1 : 0);
  return { capture: publicCapture(c), content_type: c.content_type, offset, length: got, size: r.size, eof: offset + got >= r.size, data_base64: r.data_base64 };
}

/// Largest image handed to an agent: vision APIs reject much past ~5 MB.
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;

/// A whole stored image as base64, for an MCP image block. MAX_READ is a
/// multiple of 3, so the chunks' base64 concatenates without padding.
export function readImageB64(path: string): { size: number; data_base64: string } {
  let off = 0;
  let out = "";
  for (;;) {
    const r = readB64(path, off, MAX_READ);
    if (off === 0 && r.size > MAX_VIEW_BYTES) throw new DriverError(413, `image is ${r.size} bytes; agents can view up to ${MAX_VIEW_BYTES}`);
    out += r.data_base64;
    off += MAX_READ;
    if (off >= r.size || !r.data_base64) return { size: r.size, data_base64: out };
  }
}

export function deleteCapture(id: string): void {
  const c = requireCapture(id);
  removePath(c.path);
  storeDelete(CAPTURES, id);
}
