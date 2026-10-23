import { describe, it, expect } from "vitest";
import { flattenProfile, parseScan, parseRoots, parseKind, isBambuMachine, makeCliCompatible, cliSystemName } from "../src/profiles";

const DB: Record<string, Record<string, unknown>> = {
  "fdm_filament_common": { type: "filament", name: "fdm_filament_common", from: "system", instantiation: "false", nozzle_temperature: ["200"], filament_density: ["1.24"] },
  "fdm_filament_pla": { type: "filament", name: "fdm_filament_pla", inherits: "fdm_filament_common", instantiation: "false", nozzle_temperature: ["210"] },
  "Generic PLA": { type: "filament", name: "Generic PLA", inherits: "fdm_filament_pla", instantiation: "true", filament_vendor: ["Generic"] },
  "My PLA": { type: "filament", name: "My PLA", inherits: "Generic PLA", from: "User", nozzle_temperature: ["215"] },
  loopA: { name: "loopA", inherits: "loopB" },
  loopB: { name: "loopB", inherits: "loopA" },
  orphan: { name: "orphan", inherits: "missing parent" },
};
const lookup = (n: string) => DB[n] ?? null;

describe("flattenProfile", () => {
  it("merges the inherits chain root → leaf; a user preset inherits its nearest system preset", () => {
    const f = flattenProfile("My PLA", lookup);
    expect(f).toMatchObject({
      name: "My PLA",
      type: "filament",
      nozzle_temperature: ["215"], // leaf wins
      filament_density: ["1.24"], // from the root
      filament_vendor: ["Generic"],
      from: "User",
      // The CLI's system name for a user preset; the base presets
      // (instantiation false) are skipped.
      inherits: "Generic PLA",
    });
  });

  it("keeps a system preset system, so the CLI matches it by its own name", () => {
    const f = flattenProfile("Generic PLA", lookup);
    expect(f).toMatchObject({ name: "Generic PLA", from: "system", instantiation: "true" });
    expect("inherits" in f).toBe(false);
    expect(cliSystemName(f)).toBe("Generic PLA");
  });
});

describe("makeCliCompatible", () => {
  const machine = { type: "machine", name: "Bambu Lab P1S 0.4 nozzle", from: "system" };

  it("adds the printer's system name to a process list that lacks it, or is empty", () => {
    const listed = { name: "0.20mm Standard @BBL X1C", compatible_printers: ["Bambu Lab P1S 0.4 nozzle"] };
    expect(makeCliCompatible(machine, listed, {}).process.compatible_printers).toEqual(["Bambu Lab P1S 0.4 nozzle"]);
    const other = { name: "p", compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"], compatible_printers_condition: "x" };
    expect(makeCliCompatible(machine, other, {}).process).toMatchObject({
      compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle", "Bambu Lab P1S 0.4 nozzle"],
      compatible_printers_condition: "",
    });
    // An empty list is NOT "any printer" for the CLI's process check.
    expect(makeCliCompatible(machine, { name: "p", compatible_printers: [] }, {}).process.compatible_printers).toEqual(["Bambu Lab P1S 0.4 nozzle"]);
  });

  it("matches a user printer by the system preset it inherits; leaves an open filament list open", () => {
    const user = { name: "My P1S", from: "User", inherits: "Bambu Lab P1S 0.4 nozzle" };
    const r = makeCliCompatible(user, { name: "p" }, { name: "f", compatible_printers: [] });
    expect(r.process.compatible_printers).toEqual(["Bambu Lab P1S 0.4 nozzle"]);
    expect(r.filament.compatible_printers).toEqual([]);
  });
});

describe("flattenProfile errors", () => {
  it("reports a missing leaf, a missing parent, and cycles", () => {
    expect(() => flattenProfile("nope", lookup)).toThrow(/profile 'nope' not found/);
    expect(() => flattenProfile("orphan", lookup)).toThrow(/parent profile 'missing parent' not found/);
    expect(() => flattenProfile("loopA", lookup)).toThrow(/cycle/);
  });
});

describe("scan parsing", () => {
  it("parses the awk TSV into entries with absolute paths", () => {
    const out = [
      "BBL/filament/Bambu PLA Basic @BBL X1C.json\tfilament\tBambu PLA Basic @BBL X1C\tBambu PLA Basic @base\ttrue",
      "BBL/filament/base/fdm_filament_pla.json\tfilament\tfdm_filament_pla\tfdm_filament_common\tfalse",
      "",
    ].join("\n");
    const e = parseScan(out, "/opt/orca/profiles", "BBL", "system");
    expect(e).toHaveLength(2);
    expect(e[0]).toEqual({
      name: "Bambu PLA Basic @BBL X1C",
      vendor: "BBL",
      type: "filament",
      inherits: "Bambu PLA Basic @base",
      instantiable: true,
      path: "/opt/orca/profiles/BBL/filament/Bambu PLA Basic @BBL X1C.json",
      source: "system",
    });
    expect(e[1].instantiable).toBe(false);
  });

  it("strips ./ from user scan paths", () => {
    const e = parseScan("./1234/filament/My PLA.json\tfilament\tMy PLA\tGeneric PLA\t", "/home/u/.config/OrcaSlicer/user", "User", "user");
    expect(e[0].path).toBe("/home/u/.config/OrcaSlicer/user/1234/filament/My PLA.json");
    expect(e[0].instantiable).toBe(true);
  });

  it("dedupes detected roots", () => {
    expect(parseRoots("system\t/a\nsystem\t/a\nuser\t/u\nbogus\n")).toEqual([
      { kind: "system", path: "/a" },
      { kind: "user", path: "/u" },
    ]);
  });
});

describe("helpers", () => {
  it("parses kinds and detects Bambu machines", () => {
    expect(parseKind("machine")).toBe("printer");
    expect(() => parseKind("resin")).toThrow();
    expect(isBambuMachine({ printer_model: "Bambu Lab X1 Carbon" })).toBe(true);
    expect(isBambuMachine({ printer_model: "Voron 2.4 350" }, "Voron")).toBe(false);
  });
});
