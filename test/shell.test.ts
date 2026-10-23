// Runs the plugin's real shell scripts (storage I/O, profile scan, the
// detached slice job) by backing the host functions with child_process and an
// in-memory store. Uses a fake `orca-slicer` that writes Orca-style output.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, ".tmp-shell");
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
    const r = spawnSync(command, args, { encoding: "utf8", timeout: (timeout ?? 120) * 1000, maxBuffer: 4 << 20 });
    return { exit_code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", stdout_truncated: false, stderr_truncated: false, timed_out: false };
  },
  httpRequest: () => {
    throw new Error("no http in shell tests");
  },
}));

import { storageDir, newFileRecord, putFile, uploadChunk, readB64 } from "../src/storage";
import { detectRoots, listVendors, scanProfiles, resolveProfile } from "../src/profiles";
import { startSlice, pollSlice } from "../src/slice";
import { bytesToBase64, base64ToBytes } from "../src/b64";
import { defaultTransport } from "../src/transport";

function writeJson(path: string, v: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 4));
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  settings.storage_dir = join(ROOT, "store");
  const prof = join(ROOT, "profiles");
  settings.orca_profiles_dir = prof;
  settings.orca_headless = "never";
  // A tiny vendor tree with an inherits chain per kind.
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, "Acme.json"), "{}");
  writeJson(join(prof, "Acme/machine/fdm_machine_common.json"), { type: "machine", name: "fdm_machine_common", instantiation: "false", nozzle_diameter: ["0.4"] });
  writeJson(join(prof, "Acme/machine/Acme One 0.4 nozzle.json"), { type: "machine", name: "Acme One 0.4 nozzle", inherits: "fdm_machine_common", instantiation: "true", printer_model: "Acme One" });
  writeJson(join(prof, "Acme/machine/Acme One.json"), { type: "machine_model", name: "Acme One" });
  writeJson(join(prof, "Acme/process/0.20mm Standard @Acme.json"), { type: "process", name: "0.20mm Standard @Acme", instantiation: "true", layer_height: "0.2" });
  writeJson(join(prof, "Acme/filament/base/fdm_filament_pla.json"), { type: "filament", name: "fdm_filament_pla", instantiation: "false", nozzle_temperature: ["210"] });
  writeJson(join(prof, "Acme/filament/Acme PLA.json"), { type: "filament", name: "Acme PLA", inherits: "fdm_filament_pla", instantiation: "true" });
  // Fake orca-slicer: checks its args, writes plate_1.gcode with Orca comments.
  const fake = join(ROOT, "fake-orca");
  writeFileSync(
    fake,
    `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = --outputdir ] && out=$a; prev=$a; done
[ -n "$out" ] || { echo "no outputdir" >&2; exit 2; }
grep -q '"nozzle_diameter"' "$(dirname "$out")/printer.json" || { echo "printer.json not flattened" >&2; exit 3; }
printf '; total estimated time: 1h 2m 3s\\nG28\\n; filament used [g] = 12.5\\n; total layers count = 99\\n' > "$out/plate_1.gcode"
echo "sliced"
`,
  );
  chmodSync(fake, 0o755);
  settings.orca_path = fake;
});

describe("storage scripts", () => {
  it("writes chunked base64 and reads ranges back byte-exact", () => {
    expect(storageDir()).toBe(join(ROOT, "store"));
    const bytes = Array.from({ length: 300_000 }, (_, i) => (i * 7) & 0xff);
    const rec = newFileRecord("part.stl", "upload");
    putFile(rec);
    const a = uploadChunk(rec, 0, bytesToBase64(bytes.slice(0, 200_001)), false);
    expect(a.size).toBe(200_001);
    expect(() => uploadChunk(a, 5, "AAAA", false)).toThrow(/expected 200001/);
    const b = uploadChunk(a, 200_001, bytesToBase64(bytes.slice(200_001)), true);
    expect(b).toMatchObject({ size: 300_000, complete: true, kind: "model" });
    const r = readB64(b.path, 199_990, 20);
    expect(r.size).toBe(300_000);
    expect(base64ToBytes(r.data_base64)).toEqual(bytes.slice(199_990, 200_010));
  });
});

describe("profile scan + resolve", () => {
  it("lists vendors and instantiable presets, resolving inherits from disk", () => {
    const roots = detectRoots();
    expect(roots[0]).toEqual({ kind: "system", path: join(ROOT, "profiles") });
    expect(listVendors([roots[0]])).toEqual(["Acme"]);
    const printers = scanProfiles([roots[0]], "Acme", "printer", true);
    expect(printers.map((p) => p.name).sort()).toEqual(["Acme One 0.4 nozzle", "fdm_machine_common"]); // machine_model filtered
    const fil = scanProfiles([roots[0]], "Acme", "filament", true);
    expect(fil.find((f) => f.name === "Acme PLA")).toMatchObject({ inherits: "fdm_filament_pla", instantiable: true });
    const r = resolveProfile("Acme PLA", "filament", "Acme");
    expect(r.profile).toMatchObject({ name: "Acme PLA", nozzle_temperature: ["210"], type: "filament" });
    expect(r.vendor).toBe("Acme");
  });
});

describe("slice job", () => {
  it("launches detached, then registers the G-code with estimates", async () => {
    const model = newFileRecord("cube.stl", "upload");
    putFile(model);
    const m = uploadChunk(model, 0, bytesToBase64([1, 2, 3]), true);
    const job = startSlice({
      file_id: m.id,
      printer_profile: "Acme One 0.4 nozzle",
      filament_profile: "Acme PLA",
      process_profile: "0.20mm Standard @Acme",
      vendor: "Acme",
    });
    expect(job).toMatchObject({ status: "running", target: "gcode" });
    expect(job.pid).toBeGreaterThan(0);
    let cur = job;
    for (let i = 0; i < 50 && cur.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      cur = pollSlice(job.id);
    }
    expect(cur.status, cur.error).toBe("succeeded");
    expect(cur.estimate).toMatchObject({ print_time_s: 3723, filament_g: 12.5, layers: 99 });
    const out = store.get(`files/${cur.result_file_id}`) as any;
    expect(out).toMatchObject({ name: "cube.gcode", kind: "gcode", complete: true, source: "slice" });
    expect(readFileSync(out.path, "utf8")).toContain("G28");
  });
});
describe("curl wrapper", () => {
  it("returns a binary body as base64 and surfaces curl failures", () => {
    const p = join(ROOT, "blob.bin");
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0x00, 0x10, 0x80]));
    const r = defaultTransport.request({ method: "GET", url: "file://" + p, binaryResponse: true });
    expect(base64ToBytes(r.bodyBase64!)).toEqual([0xff, 0xd8, 0x00, 0x10, 0x80]);
    expect(() => defaultTransport.request({ method: "GET", url: "http://127.0.0.1:1/x", binaryResponse: true, timeoutSecs: 3 })).toThrow(
      /failed/,
    );
  });
});
