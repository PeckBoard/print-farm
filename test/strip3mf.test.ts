// The project-3MF settings stripper (src/threemf.ts) run with the real
// python3 on a synthetic Bambu Studio project: Metadata/* gone, the
// Application / 3mfVersion stamps gone, geometry and components kept.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync, unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { STRIP_3MF_PY } from "../src/threemf";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const DIR = resolve(__dirname, ".tmp-strip3mf");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const ROOT_MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-02.08.04.57</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">Lizard</metadata>
 <resources>
  <object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1"/></components></object>
 </resources>
 <build><item objectid="2"/></build>
</model>`;

function run(files: Record<string, string>) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const src = join(DIR, "in.3mf");
  const dst = join(DIR, "out.3mf");
  writeFileSync(src, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)]))));
  const r = spawnSync("python3", ["-c", STRIP_3MF_PY, src, dst], { encoding: "utf8" });
  return { r, out: () => unzipSync(new Uint8Array(readFileSync(dst))) };
}

describe.skipIf(!hasPython)("project 3MF stripping", () => {
  it("drops Metadata/* and the version stamps, keeps geometry", () => {
    const { r, out } = run({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "3D/3dmodel.model": ROOT_MODEL,
      "3D/_rels/3dmodel.model.rels": "<Relationships/>",
      "3D/Objects/object_1.model": "<model><resources><object id=\"1\"><mesh/></object></resources></model>",
      "Metadata/project_settings.config": "{}",
      "Metadata/model_settings.config": "<config/>",
      "Metadata/plate_1.png": "png",
    });
    expect(r.stdout.trim(), r.stderr).toBe("stripped");
    const z = out();
    expect(Object.keys(z).sort()).toEqual(["3D/3dmodel.model", "3D/Objects/object_1.model", "3D/_rels/3dmodel.model.rels", "[Content_Types].xml", "_rels/.rels"]);
    const model = dec(z["3D/3dmodel.model"]);
    expect(model).not.toContain("Application");
    expect(model).not.toContain("3mfVersion");
    expect(model).toContain('<metadata name="Title">Lizard</metadata>');
    expect(model).toContain('p:path="/3D/Objects/object_1.model"');
  });

  it("leaves a plain 3MF alone", () => {
    const { r } = run({ "3D/3dmodel.model": ROOT_MODEL });
    expect(r.stdout.trim()).toBe("plain");
  });
});
