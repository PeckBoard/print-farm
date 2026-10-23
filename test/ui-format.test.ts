import { describe, it, expect } from "vitest";
import { fmtDuration, fmtBytes, fmtPercent, fmtTemp, fmtFilament, statePill, controlsFor, accepts, isQueued, matchesQuery, previewKind } from "../ui/format";
import { validatePrinter, printerBody, PrinterDraft } from "../ui/validate";
import { PAGE } from "../src/page";

describe("ui format helpers", () => {
  it("formats durations humanely", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(37)).toBe("37s");
    expect(fmtDuration(45 * 60 + 12)).toBe("45m 12s");
    expect(fmtDuration(2 * 3600 + 5 * 60)).toBe("2h 05m");
    expect(fmtDuration(26 * 3600)).toBe("1d 2h");
  });

  it("formats bytes, percent, temps, filament", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(12 * 1024 * 1024)).toBe("12 MB");
    expect(fmtPercent(0.423)).toBe("42%");
    expect(fmtPercent(0.051)).toBe("5.1%");
    expect(fmtPercent(2)).toBe("100%");
    expect(fmtTemp({ actual: 214.6, target: 215 })).toBe("215° / 215°");
    expect(fmtTemp({ actual: 24.2, target: 0 })).toBe("24°");
    expect(fmtFilament({ filament_g: 12.34, filament_mm: 4100 })).toBe("12 g · 4.10 m");
  });

  it("maps printer states to pills and allowed controls", () => {
    expect(statePill("printing")).toEqual({ label: "Printing", tone: "busy" });
    expect(statePill("paused").tone).toBe("warn");
    expect(statePill("error").tone).toBe("bad");
    expect(statePill("offline").tone).toBe("muted");
    expect(statePill("weird").label).toBe("Unknown");
    expect(controlsFor("printing")).toEqual({ pause: true, resume: false, cancel: true });
    expect(controlsFor("paused")).toEqual({ pause: false, resume: true, cancel: true });
    expect(controlsFor("idle")).toEqual({ pause: false, resume: false, cancel: false });
  });

  it("knows file compatibility, queue states, search and preview kinds", () => {
    expect(accepts("bambu", "gcode.3mf")).toBe(true);
    expect(accepts("bambu", "gcode")).toBe(false);
    expect(accepts("prusalink", "bgcode")).toBe(true);
    expect(isQueued("uploaded") && isQueued("awaiting_confirmation")).toBe(true);
    expect(isQueued("started")).toBe(false);
    expect(matchesQuery("Bambu Lab X1 Carbon 0.4 nozzle", "x1 0.4")).toBe(true);
    expect(matchesQuery("Bambu Lab X1 Carbon 0.4 nozzle", "p1s")).toBe(false);
    expect(previewKind("part.STL", "model")).toBe("stl");
    expect(previewKind("part.step", "model")).toBeNull();
    expect(previewKind("a.gcode.3mf", "gcode.3mf")).toBe("gcode.3mf");
  });
});

describe("printer form validation", () => {
  const base: PrinterDraft = {
    name: "",
    type: "moonraker",
    host: "",
    port: "",
    api_key: "",
    username: "",
    password: "",
    storage: "",
    tls_insecure: false,
    serial: "",
    access_code: "",
    model: "",
    orca_printer_profile: "",
    orca_filament_profile: "",
    orca_process_profile: "",
    clear: {},
  };

  it("flags missing / bad fields per type", () => {
    expect(Object.keys(validatePrinter(base, null))).toEqual(["host"]);
    expect(validatePrinter({ ...base, host: "a b" }, null).host).toMatch(/spaces/);
    expect(validatePrinter({ ...base, host: "x", port: "70000" }, null).port).toBeTruthy();
    expect(validatePrinter({ ...base, type: "octoprint", host: "x" }, null).api_key).toBeTruthy();
    expect(validatePrinter({ ...base, type: "octoprint", host: "x" }, { has_api_key: true }).api_key).toBeUndefined();
    expect(validatePrinter({ ...base, type: "octoprint", host: "x", clear: { api_key: true } }, { has_api_key: true }).api_key).toBeTruthy();
    const b = validatePrinter({ ...base, type: "bambu", host: "10.0.0.5" }, null);
    expect(b.serial && b.access_code).toBeTruthy();
    expect(validatePrinter({ ...base, type: "bambu", host: "10.0.0.5", serial: "01S00C1", access_code: "12345678" }, null)).toEqual({});
  });

  it("builds the request body with the secret keep/clear rules", () => {
    expect(printerBody({ ...base, host: " h ", api_key: "k" }, false)).toEqual({ type: "moonraker", host: "h", tls_insecure: false, api_key: "k" });
    const edit = printerBody({ ...base, host: "h", clear: { api_key: true } }, true);
    expect(edit.api_key).toBeNull();
    expect(edit.port).toBeNull();
    expect("password" in printerBody({ ...base, type: "prusalink", host: "h" }, true)).toBe(false);
    expect(printerBody({ ...base, type: "bambu", host: "h", serial: "S1" }, true).bambu).toEqual({ serial: "S1", model: null });
  });
});

describe("page shell", () => {
  it("embeds the bundle without an early </script>", () => {
    const scripts = PAGE.match(/<\/script>/gi) || [];
    expect(scripts.length).toBe(2); // theme stamp + bundle
    expect(PAGE).toContain('id="app"');
  });
});
