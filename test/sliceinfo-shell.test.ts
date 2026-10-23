// The slice_info reader (src/spools.ts) run with the real sh + unzip/python3
// on a synthetic .gcode.3mf, then parsed.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { READ_SLICE_INFO } from "../src/spools";
import { parseSliceInfo } from "../src/ams";

const DIR = resolve(__dirname, ".tmp-sliceinfo");
const hasTool = spawnSync("sh", ["-c", "command -v unzip || command -v python3"]).status === 0;

const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="1" tray_info_idx="GFB99" type="ASA" color="#FFFFFF" used_m="2.1" used_g="6.4" />
  </plate>
</config>`;

function read(files: Record<string, string>): string {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const f = join(DIR, "a.gcode.3mf");
  writeFileSync(f, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]))));
  const r = spawnSync("sh", ["-c", READ_SLICE_INFO, "sh", f], { encoding: "utf8" });
  rmSync(DIR, { recursive: true, force: true });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe.skipIf(!hasTool)("slice_info reader", () => {
  it("extracts the filament list from a .gcode.3mf", () => {
    const out = read({ "Metadata/slice_info.config": SLICE_INFO, "Metadata/plate_1.gcode": "G28\n" });
    expect(parseSliceInfo(out).get(1)).toEqual([{ id: 1, type: "ASA", color: "FFFFFF", used_g: 6.4 }]);
  });

  it("prints nothing when the entry is missing", () => {
    expect(read({ "Metadata/plate_1.gcode": "G28\n" })).toBe("");
  });
});
