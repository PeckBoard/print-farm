import { describe, it, expect } from "vitest";
import {
  defaultFarmSettings,
  mergeFarmSettings,
  resolveSlice,
  applyPrinterSettings,
  printerSettingsView,
  farmPresetCandidates,
  withoutIgnoredHms,
} from "../src/farmsettings";
import { applyResolved, effectiveBlock } from "../src/slice";
import { parseEffective } from "../src/gcode";
import { userPresetJson, normaliseOwn, presetVersion, validPresetName } from "../src/userpresets";
import { noCapabilities, PrinterRecord } from "../src/drivers/types";
import { ApiError } from "../src/apierror";

const P1S: PrinterRecord = {
  id: "p2",
  name: "P1S",
  type: "bambu",
  host: "10.0.0.2",
  bambu: { serial: "01P00A000000000", access_code: "x" },
  orca_printer_profile: "Bambu Lab P1S 0.4 nozzle",
  orca_process_profile: "0.20mm Standard @BBL X1C",
  orca_filament_profile: "Bambu PLA Basic @BBL X1C",
};

describe("farm settings", () => {
  it("defaults to a Textured PEI plate and validates partial updates by field", () => {
    const d = defaultFarmSettings();
    expect(d.plate_type).toBe("Textured PEI Plate");
    const next = mergeFarmSettings(d, { brim: { width_mm: 3 }, monitoring: { ignored_hms: ["0500_0400_0001_0002"] } });
    expect(next.brim).toEqual({ mode: "auto", width_mm: 3 });
    expect(next.monitoring.snapshot_interval_s).toBe(60);
    expect(next.monitoring.ignored_hms).toEqual(["0500_0400_0001_0002"]);
    try {
      mergeFarmSettings(d, { plate_type: "Glass" });
      throw new Error("expected a field error");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).extra).toEqual({ field: "plate_type" });
    }
    expect(() => mergeFarmSettings(d, { bed_temp_override: { first_layer: 500 } })).toThrow(/first_layer/);
  });

  it("filters ignored HMS codes regardless of separators", () => {
    const d = { errors: [{ code: "0300_3100_0001_0001", text: "x", severity: "w" }, { code: "HMS_0700-2000-0002-0001", text: "y", severity: "e" }] };
    expect(withoutIgnoredHms(d, ["03003100-0001-0001"]).errors.map((e) => e.code)).toEqual(["HMS_0700-2000-0002-0001"]);
  });
});

describe("slice resolution: call → printer → farm → preset", () => {
  const farm = defaultFarmSettings();

  it("uses the farm plate, brim and arrange when nothing else says", () => {
    const r = resolveSlice({}, P1S, farm);
    expect(r).toMatchObject({ bed_type: "Textured PEI Plate", brim: { type: "auto_brim", width: 5 }, arrange: true, orient: false });
    expect(r.bed_temp).toEqual({ first_layer: null, other_layers: null });
  });

  it("printer settings beat the farm; call arguments beat both", () => {
    const p = applyPrinterSettings(P1S, { plate_type: "High Temp Plate", capabilities: { heaters: false } });
    expect(resolveSlice({}, p, farm).bed_type).toBe("High Temp Plate");
    const farm2 = mergeFarmSettings(farm, { bed_temp_override: { first_layer: 62 } });
    const r = resolveSlice({ bed_type: "Cool Plate", brim_width: 0, bed_temp: { other_layers: 58 }, orient: true }, p, farm2);
    expect(r).toMatchObject({ bed_type: "Cool Plate", brim: { type: "no_brim", width: 0 }, orient: true, arrange: true });
    expect(r.bed_temp).toEqual({ first_layer: 62, other_layers: 58 });
  });

  it("writes curr_bed_type, brim, plate bed temps and overrides into the presets in Orca's shapes", () => {
    const r = resolveSlice({ bed_temp: { first_layer: 60, other_layers: 60 }, overrides: { wall_loops: 3, nozzle_temperature: 225, gcode_flavor: "marlin" } }, P1S, farm);
    const out = applyResolved(
      {
        machine: { gcode_flavor: "klipper" },
        process: { brim_type: "no_brim", wall_loops: "2" },
        filament: { textured_plate_temp: ["55"], textured_plate_temp_initial_layer: ["55"], nozzle_temperature: ["220"] },
      },
      r,
    );
    expect(out.process).toMatchObject({ curr_bed_type: "Textured PEI Plate", brim_type: "auto_brim", brim_width: "5", wall_loops: "3" });
    expect(out.filament).toMatchObject({ textured_plate_temp: ["60"], textured_plate_temp_initial_layer: ["60"], nozzle_temperature: ["225"] });
    expect(out.machine.gcode_flavor).toBe("marlin");
  });

  it("swaps the farm quality into the machine's default process", () => {
    const c = farmPresetCandidates({ process: "0.20mm Standard @BBL X1C", filament: "Bambu PLA Basic @BBL X1C" }, { quality: "0.16mm Optimal", material: "PETG" });
    expect(c.process).toEqual(["0.16mm Optimal @BBL X1C", "0.20mm Standard @BBL X1C"]);
    expect(c.filament).toEqual(["Generic PETG @BBL X1C", "Generic PETG", "Bambu PLA Basic @BBL X1C"]);
    expect(farmPresetCandidates({ process: "p", filament: "Bambu PLA Basic @BBL X1C" }, { quality: "", material: "PLA" }).filament).toEqual([
      "Bambu PLA Basic @BBL X1C",
    ]);
  });

  it("exposes printer settings with effective values and capabilities", () => {
    const caps = noCapabilities();
    caps.camera = true;
    const v = printerSettingsView(applyPrinterSettings(P1S, { nozzle_mm: 0.6 }), farm, caps);
    expect(v).toMatchObject({
      plate_type: null,
      nozzle_mm: 0.6,
      capabilities: { heaters: false, camera: true, gcode: false },
      effective: { plate_type: "Textured PEI Plate", printer_preset: "Bambu Lab P1S 0.6 nozzle" },
    });
    expect(applyPrinterSettings(P1S, { filament_preset: null }).orca_filament_profile).toBeUndefined();
    expect(() => applyPrinterSettings(P1S, { nozzle_mm: 0.5 })).toThrow(/nozzle_mm/);
  });
});

describe("G-code readback", () => {
  // Shape of a Bambu (P1S) plate G-code: config block at the top, start
  // G-code heats the nozzle to probing temperatures before the print temp.
  const BAMBU = [
    "; CONFIG_BLOCK_START",
    "; curr_bed_type = Textured PEI Plate",
    "; textured_plate_temp = 60",
    "; textured_plate_temp_initial_layer = 60",
    "; nozzle_temperature = 220",
    "; nozzle_temperature_initial_layer = 220",
    "; brim_width = 5",
    "; brim_type = auto_brim",
    '; filament_settings_id = "PF PLA Textured 60"',
    "; print_settings_id = 0.20mm Standard @BBL X1C",
    "; printer_settings_id = Bambu Lab P1S 0.4 nozzle",
    "; CONFIG_BLOCK_END",
    "M104 S75 ;set extruder temp",
    "M140 S60 ;set bed temp",
    "M190 S60 ;wait for bed temp",
    "M109 S250 ;flush temp",
    "M104 S140 ; down for probing",
    "M109 S220",
    "; CHANGE_LAYER",
    "G1 X1",
    "; CHANGE_LAYER",
    "M140 S60",
    "M140 S0 ; turn off bed",
  ].join("\n");

  it("reads the first-layer heater commands and the config block", () => {
    expect(parseEffective(BAMBU)).toEqual({
      bed_type: "Textured PEI Plate",
      bed_temp_first_layer: 60,
      bed_temp_other_layers: 60,
      nozzle_temp_first_layer: 220,
      nozzle_temp_other_layers: 220,
      brim_width: 5,
      brim_type: "auto_brim",
      printer_preset: "Bambu Lab P1S 0.4 nozzle",
      process_preset: "0.20mm Standard @BBL X1C",
      filament_preset: "PF PLA Textured 60",
    });
  });

  it("takes other-layer temperatures from after the first layer, config at the end (Marlin)", () => {
    const marlin = ["M190 S65", "M109 S215", ";LAYER_CHANGE", "G1", ";LAYER_CHANGE", "M140 S60", "M104 S210", "; curr_bed_type = Cool Plate", "; cool_plate_temp = 35"].join("\n");
    expect(parseEffective(marlin)).toMatchObject({ bed_type: "Cool Plate", bed_temp_first_layer: 65, bed_temp_other_layers: 60, nozzle_temp_first_layer: 215, nozzle_temp_other_layers: 210 });
  });

  it("falls back to the requested values when the G-code can't be read", () => {
    const r = resolveSlice({}, P1S, defaultFarmSettings());
    const e = effectiveBlock(undefined, { requested: r, profiles: { printer: "a", process: "b", filament: "c" } });
    expect(e).toMatchObject({ bed_type: "Textured PEI Plate", bed_temp_first_layer: null, brim_width: 5, printer_preset: "a", source: "requested" });
  });
});

describe("Orca user presets", () => {
  it("writes the JSON Orca itself writes: diff keys + identity, keys sorted", () => {
    const own = normaliseOwn({ textured_plate_temp: 60, textured_plate_temp_initial_layer: "60", name: "ignored" }, {
      textured_plate_temp: ["55"],
      textured_plate_temp_initial_layer: ["55"],
    });
    const doc = userPresetJson("filament", "PLA Textured 60", "Bambu PLA Basic @BBL X1C", own, presetVersion("2.4.2"));
    expect(doc).toEqual({
      filament_settings_id: ["PLA Textured 60"],
      from: "User",
      inherits: "Bambu PLA Basic @BBL X1C",
      is_custom_defined: "0",
      name: "PLA Textured 60",
      textured_plate_temp: ["60"],
      textured_plate_temp_initial_layer: ["60"],
      version: "2.4.2.0",
    });
    expect(Object.keys(doc)).toEqual([...Object.keys(doc)].sort());
    expect(userPresetJson("process", "Fast", "0.20mm Standard @BBL X1C", {}, "2.4.2.0").print_settings_id).toBe("Fast");
    expect(userPresetJson("printer", "My P1S", "Bambu Lab P1S 0.4 nozzle", {}, "2.4.2.0").printer_settings_id).toBe("My P1S");
  });

  it("rejects names Orca or the file system can't hold", () => {
    expect(validPresetName("  My PLA ")).toBe("My PLA");
    expect(() => validPresetName("a/b")).toThrow(/can't contain/);
    expect(() => validPresetName("")).toThrow(/required/);
  });
});
