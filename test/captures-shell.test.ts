// capture_view / capture_list: stored stills come back as an MCP image
// (`_image_base64` + `_image_mime`, which core turns into an image block) —
// read through the real storage shell scripts, chunked past MAX_READ.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = resolve(__dirname, ".tmp-captures");
const settings: Record<string, string> = {};
const store = new Map<string, unknown>();

vi.mock("../src/host", () => ({
  getSetting: (k: string) => settings[k] ?? null,
  storePut: (c: string, k: string, v: unknown) => void store.set(`${c}/${k}`, JSON.parse(JSON.stringify(v))),
  storeGet: (c: string, k: string) => store.get(`${c}/${k}`) ?? null,
  storeDelete: (c: string, k: string) => void store.delete(`${c}/${k}`),
  storeList: (c: string) =>
    [...store.entries()].filter(([k]) => k.startsWith(c + "/")).map(([k, value]) => ({ key: k.slice(c.length + 1), value })),
  execAny: (command: string, args: string[], timeout?: number) => {
    const r = spawnSync(command, args, { encoding: "utf8", timeout: (timeout ?? 120) * 1000, maxBuffer: 16 << 20 });
    return { exit_code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", stdout_truncated: false, stderr_truncated: false, timed_out: false };
  },
}));

import { storageDir } from "../src/storage";
import { TOOLS } from "../src/tools";

let jpg: Buffer;
let big: Buffer;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  settings.storage_dir = join(ROOT, "store");
  const dir = storageDir();
  jpg = readFileSync(join(__dirname, "fixtures/snapshot.jpg"));
  big = randomBytes(1_000_003); // > MAX_READ (768 KiB), not a multiple of 3
  writeFileSync(join(dir, "captures/c1.jpg"), jpg);
  writeFileSync(join(dir, "captures/c2.png"), big);
  writeFileSync(join(dir, "files/f9-snap.jpg"), jpg);
  store.set("captures/c1", { id: "c1", printer_id: "p1", taken_at: "2026-10-23T10:00:00Z", size: jpg.length, content_type: "image/jpeg", path: join(dir, "captures/c1.jpg") });
  store.set("captures/c2", { id: "c2", printer_id: "p2", taken_at: "2026-10-23T11:00:00Z", size: big.length, content_type: "image/png", path: join(dir, "captures/c2.png") });
  store.set("files/f9", { id: "f9", name: "snap.jpg", kind: "image", path: join(dir, "files/f9-snap.jpg"), size: jpg.length, complete: true, source: "snapshot" });
  store.set("files/f8", { id: "f8", name: "part.stl", kind: "model", path: join(dir, "files/nope"), size: 1, complete: true, source: "upload" });
});

describe("capture tools", () => {
  it("capture_view returns a kept capture as an image block", () => {
    const r = TOOLS.capture_view({ capture_id: "c1" }) as any;
    expect(r._image_mime).toBe("image/jpeg");
    expect(r._image_base64).toBe(jpg.toString("base64"));
    expect(r.capture).toMatchObject({ id: "c1", printer_id: "p1", url: "captures/c1" });
    expect(r.data_base64).toBeUndefined();
  });

  it("reads images larger than one storage read intact", () => {
    const r = TOOLS.capture_view({ capture_id: "c2" }) as any;
    expect(r._image_mime).toBe("image/png");
    expect(Buffer.from(r._image_base64, "base64").equals(big)).toBe(true);
  });

  it("views image files (print_snapshot output) and refuses non-images", () => {
    const r = TOOLS.capture_view({ file_id: "f9" }) as any;
    expect(r._image_base64).toBe(jpg.toString("base64"));
    expect(r._image_mime).toBe("image/jpeg");
    expect(() => TOOLS.capture_view({ file_id: "f8" })).toThrow(/not an image/);
    expect(() => TOOLS.capture_view({ capture_id: "c404" })).toThrow(/unknown capture/);
    expect(() => TOOLS.capture_view({})).toThrow(/capture_id/);
  });

  it("capture_list lists newest first", () => {
    const r = TOOLS.capture_list({}) as any;
    expect(r.captures.map((c: any) => c.id)).toEqual(["c2", "c1"]);
    expect(r.captures[0].path).toBeUndefined();
  });
});
