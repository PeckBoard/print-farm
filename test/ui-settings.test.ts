import { describe, it, expect } from "vitest";
import {
  normalizeHms,
  hmsError,
  diffTop,
  deepEqual,
  withFarmDefaults,
  validateFarm,
  FARM_DEFAULTS,
  clone,
  lowBedTemp,
  materialOptions,
  qualityOptions,
  toOrca,
  fromOrca,
  fieldError,
  parseOwnJson,
  presetNameError,
  FieldDef,
} from "../ui/settingsModel";

describe("HMS codes", () => {
  it("normalises separators and case", () => {
    expect(normalizeHms("0300_3100_0001_0001")).toBe("0300_3100_0001_0001");
    expect(normalizeHms(" 0c00-0300 0002 0001 ")).toBe("0C00_0300_0002_0001");
    expect(normalizeHms("HMS_0300310000010001")).toBe("0300_3100_0001_0001");
    expect(normalizeHms("0300_3100_0001")).toBeNull();
    expect(normalizeHms("0300_3100_0001_00G1")).toBeNull();
  });
  it("explains why a code can't be added", () => {
    expect(hmsError("", [])).toMatch(/Enter/);
    expect(hmsError("nope", [])).toMatch(/XXXX_XXXX_XXXX_XXXX/);
    expect(hmsError("0300310000010001", ["0300_3100_0001_0001"])).toMatch(/already/);
    expect(hmsError("0300_3100_0001_0002", ["0300_3100_0001_0001"])).toBeNull();
  });
});

describe("dirty state", () => {
  it("diffs only changed top-level keys", () => {
    const a = withFarmDefaults(null);
    const b = clone(a);
    expect(diffTop(a, b)).toEqual({});
    b.monitoring.ignored_hms.push("0C00_0300_0002_0001");
    b.auto_orient = true;
    expect(Object.keys(diffTop(a, b)).sort()).toEqual(["auto_orient", "monitoring"]);
    expect(deepEqual({ x: 1, y: [1] }, { y: [1], x: 1 })).toBe(true);
  });
  it("fills a partial server answer with the contract defaults", () => {
    const s = withFarmDefaults({ plate_type: "Cool Plate", brim: { mode: "mm" } as any });
    expect(s.plate_type).toBe("Cool Plate");
    expect(s.brim).toEqual({ mode: "mm", width_mm: 5 });
    expect(s.monitoring).toEqual(FARM_DEFAULTS.monitoring);
  });
  it("validates brim width and bed temperatures", () => {
    const s = withFarmDefaults(null);
    expect(validateFarm(s)).toEqual({});
    s.brim = { mode: "mm", width_mm: 0 };
    s.bed_temp_override.first_layer = 200;
    expect(Object.keys(validateFarm(s)).sort()).toEqual(["bed_temp_override.first_layer", "brim.width_mm"]);
  });
});

describe("plates and options", () => {
  it("flags a cold bed on hot plates only", () => {
    expect(lowBedTemp("Textured PEI Plate", 35)).toBe(true);
    expect(lowBedTemp("Textured PEI Plate", 60)).toBe(false);
    expect(lowBedTemp("Cool Plate", 35)).toBe(false);
    expect(lowBedTemp("Engineering Plate", null)).toBe(false);
  });
  it("orders materials and keeps the current one", () => {
    expect(materialOptions(["PETG", "pla", undefined, "XYZ"]).slice(0, 3)).toEqual(["PLA", "PETG", "XYZ"]);
    expect(materialOptions([], "Nylon")[0]).toBe("Nylon");
  });
  it("derives quality names from process presets", () => {
    expect(qualityOptions(["0.20mm Standard @BBL X1C", "0.12mm Fine @BBL X1C", "0.20mm Standard @BBL P1P"])).toEqual(["0.12mm Fine", "0.20mm Standard"]);
  });
});

describe("Orca preset values", () => {
  const temp: FieldDef = { key: "textured_plate_temp", label: "Textured", type: "int", unit: "°C", min: 0, max: 120, per_extruder: true };
  const pct: FieldDef = { key: "sparse_infill_density", label: "Infill", type: "percent", min: 0, max: 100 };
  const boo: FieldDef = { key: "enable_support", label: "Supports", type: "bool" };
  it("round-trips on-disk shapes", () => {
    expect(fromOrca(temp, ["60"])).toBe("60");
    expect(toOrca(temp, "65", ["60"])).toEqual(["65"]);
    expect(toOrca(temp, "65", ["60", "60"])).toEqual(["65", "65"]);
    expect(fromOrca(pct, "15%")).toBe("15");
    expect(toOrca(pct, "20", "15%")).toBe("20%");
    expect(fromOrca(boo, "1")).toBe("1");
    expect(fromOrca(boo, "false")).toBe("0");
  });
  it("validates typed values", () => {
    expect(fieldError(temp, "60")).toBeNull();
    expect(fieldError(temp, "60.5")).toMatch(/Whole/);
    expect(fieldError(temp, "150")).toMatch(/At most 120/);
    expect(fieldError(pct, "")).toMatch(/Enter/);
  });
  it("parses the Advanced JSON", () => {
    expect(parseOwnJson('{"layer_height":"0.2","nozzle_temperature":["220"]}')).toEqual({ own: { layer_height: "0.2", nozzle_temperature: ["220"] } });
    expect("error" in parseOwnJson("[1]")).toBe(true);
    expect("error" in parseOwnJson('{"layer_height":0.2}')).toBe(true);
    expect("error" in parseOwnJson('{"inherits":"x"}')).toBe(true);
    expect("error" in parseOwnJson("{oops")).toBe(true);
  });
  it("validates preset names", () => {
    expect(presetNameError("  ", [])).toMatch(/Enter/);
    expect(presetNameError("a/b", [])).toMatch(/can't contain/);
    expect(presetNameError("Mine", ["mine"])).toMatch(/exists/);
    expect(presetNameError("Mine", ["Mine"], "Mine")).toBeNull();
  });
});
