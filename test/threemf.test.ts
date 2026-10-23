// 3MF parsing for the preview, built around a synthetic Bambu Studio /
// OrcaSlicer project with the same structure as a real one: the root model
// only holds <components> pointing (3MF Production `p:path`) at
// 3D/Objects/object_N.model files, plus plates in
// Metadata/model_settings.config and plate thumbnails.

import { describe, it, expect } from "vitest";
import { zipSync, unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { parse3mf, parseTransform, compose, parsePlates, plateThumbnail } from "../ui/threemf";

const enc = (s: string) => new TextEncoder().encode(s);

// A unit tetrahedron-ish mesh (4 vertices, 2 triangles) at the origin.
const mesh = (dx = 0) => `<mesh><vertices>
  <vertex x="${0 + dx}" y="0" z="0"/><vertex x="${1 + dx}" y="0" z="0"/>
  <vertex x="${0 + dx}" y="1" z="0"/><vertex x="${0 + dx}" y="0" z="1"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/></triangles></mesh>`;

const objectFile = (id: string, dx = 0) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="${id}" type="model">${mesh(dx)}</object></resources><build/></model>`;

const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
  <object id="2" p:UUID="a" type="model" name="Lizard body">
   <components>
    <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/>
   </components>
  </object>
  <object id="4" type="model" name="Tail">
   <components><component p:path="/3D/Objects/object_2.model" objectid="3"/></components>
  </object>
  <object id="6" type="model" name="Plate 2 part">
   <components><component p:path="/3D/Objects/object_3.model" objectid="5"/></components>
  </object>
 </resources>
 <build p:UUID="b">
  <item objectid="2" p:UUID="c" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/>
  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 120 100 0" printable="1"/>
  <item objectid="6" transform="1 0 0 0 1 0 0 0 1 400 100 0" printable="1"/>
 </build>
</model>`;

const CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2"><metadata key="name" value="Lizard body"/></object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>
    <model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <model_instance><metadata key="object_id" value="6"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
</config>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function project(): Record<string, Uint8Array> {
  return {
    "[Content_Types].xml": enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "_rels/.rels": enc('<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    "3D/3dmodel.model": enc(ROOT),
    "3D/_rels/3dmodel.model.rels": enc('<Relationships><Relationship Target="/3D/Objects/object_1.model" Id="rel-1"/></Relationships>'),
    "3D/Objects/object_1.model": enc(objectFile("1")),
    "3D/Objects/object_2.model": enc(objectFile("3")),
    "3D/Objects/object_3.model": enc(objectFile("5", 2)),
    "Metadata/model_settings.config": enc(CONFIG),
    "Metadata/plate_1.png": PNG,
  };
}

describe("3MF Production extension", () => {
  it("follows component p:path into object files, with component + item transforms", () => {
    const r = parse3mf(unzipSync(zipSync(project())));
    expect(r.objects.map((o) => [o.id, o.name, o.plate, o.parts.length])).toEqual([
      ["2", "Lizard body", 1, 2],
      ["4", "Tail", 1, 1],
      ["6", "Plate 2 part", 2, 1],
    ]);
    expect(r.plates).toEqual([1, 2]);
    const [a, b] = r.objects[0].parts;
    // Item moves +100/+100; the second component also lifts +5 in Z.
    expect(Array.from(a.positions.slice(0, 6))).toEqual([100, 100, 0, 101, 100, 0]);
    expect(Array.from(b.positions.slice(0, 3))).toEqual([100, 100, 5]);
    expect(Array.from(a.indices)).toEqual([0, 1, 2, 0, 1, 3]);
    expect(r.objects[2].parts[0].positions[0]).toBe(402);
  });

  it("reads a plain single-file 3MF and the unit attribute", () => {
    const files = {
      "3D/3dmodel.model": enc(
        `<model unit="centimeter"><resources><object id="1" type="model">${mesh()}</object></resources><build><item objectid="1"/></build></model>`,
      ),
    };
    const r = parse3mf(files);
    expect(r.plates).toEqual([]);
    expect(Array.from(r.objects[0].parts[0].positions.slice(3, 6))).toEqual([10, 0, 0]);
  });

  it("explains files with nothing to show", () => {
    expect(() => parse3mf({ "Metadata/plate_1.png": PNG })).toThrow(/no 3D model/);
    const dangling = { "3D/3dmodel.model": enc(ROOT) }; // object files missing
    expect(() => parse3mf(dangling)).toThrow(/no printable meshes/);
  });

  it("composes transforms (apply a, then b)", () => {
    const rot = parseTransform("0 1 0 -1 0 0 0 0 1 0 0 0"); // +90° about Z
    const move = parseTransform("1 0 0 0 1 0 0 0 1 10 0 0");
    const m = compose(rot, move); // rotate, then move
    // (1,0,0) → rotate → (0,1,0) → move → (10,1,0)
    expect([1 * m[0] + m[9], 1 * m[1] + m[10], 1 * m[2] + m[11]]).toEqual([10, 1, 0]);
    expect(parseTransform("garbage")).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("maps plates and finds the plate thumbnail", () => {
    expect([...parsePlates(CONFIG)]).toEqual([
      ["2", 1],
      ["4", 1],
      ["6", 2],
    ]);
    expect(plateThumbnail(project(), 1)).toBe(PNG);
    expect(plateThumbnail({}, 1)).toBeNull();
  });
});
