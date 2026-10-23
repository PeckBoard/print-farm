// Pure pieces of zero-touch setup: wrapper resolution, model → profile
// mapping, version comparison, install scheduling, and serial sync.

import { describe, it, expect } from "vitest";
import { parseWrapperExec, parseBinProbe, parseMachineFiles } from "../src/profiles";
import { bambuMachineName, matchMachine, presetDefaults } from "../src/autoprofiles";
import { versionLt, shouldStart, failureReason, parseSections, bridgeNeed } from "../src/setup";
import { serialFixes } from "../src/drivers/bambu";
import { withCorrectedSerial, buildPrinter } from "../src/printers";
import { PrinterRecord } from "../src/drivers/types";

describe("wrapper resolution", () => {
  it("follows App Manager's orca-slicer wrapper with $HOME expanded", () => {
    const text = '#!/bin/sh\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\n';
    expect(parseWrapperExec(text, "/home/u")).toBe("/home/u/.local/share/orca-slicer/AppRun");
  });
  it("handles ${HOME}, ~, single quotes and bare paths", () => {
    expect(parseWrapperExec("exec '${HOME}/x/AppRun' \"$@\"", "/h")).toBe("/h/x/AppRun");
    expect(parseWrapperExec("#!/bin/sh\nset -e\n  exec ~/apps/orca/AppRun \"$@\"", "/h")).toBe("/h/apps/orca/AppRun");
    expect(parseWrapperExec("exec /opt/orca/bin/orca-slicer", "/h")).toBe("/opt/orca/bin/orca-slicer");
  });
  it("gives up on no exec line, relative or unexpandable paths", () => {
    expect(parseWrapperExec("#!/bin/sh\necho hi\n", "/h")).toBeNull();
    expect(parseWrapperExec('exec "$APPDIR/AppRun"', "/h")).toBeNull();
    expect(parseWrapperExec("exec orca-slicer", "/h")).toBeNull();
  });
  it("parses the probe output", () => {
    const out = 'home=/home/u\nbin=/home/u/.local/bin/orca-slicer\n@@WRAPPER\n#!/bin/sh\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\n';
    expect(parseBinProbe(out)).toEqual({ bin: "/home/u/.local/bin/orca-slicer", target: "/home/u/.local/share/orca-slicer/AppRun" });
    expect(parseBinProbe("home=/h\nbin=/usr/bin/orca-slicer\n")).toEqual({ bin: "/usr/bin/orca-slicer", target: "" });
    expect(parseBinProbe("home=/h\n")).toEqual({ bin: "", target: "" });
  });
  it("parses machine file listings", () => {
    expect(parseMachineFiles("BBL/machine/Bambu Lab P1S 0.4 nozzle.json\nnoise\nPrusa/machine/Prusa MK4 0.4 nozzle.json\n")).toEqual([
      { vendor: "BBL", name: "Bambu Lab P1S 0.4 nozzle" },
      { vendor: "Prusa", name: "Prusa MK4 0.4 nozzle" },
    ]);
  });
});

describe("model → profile mapping", () => {
  it("maps Bambu models (and aliases) to Orca machine presets", () => {
    expect(bambuMachineName("P1S", "")).toBe("Bambu Lab P1S 0.4 nozzle");
    expect(bambuMachineName("X1C", "")).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
    expect(bambuMachineName("A1 mini", "")).toBe("Bambu Lab A1 mini 0.4 nozzle");
    expect(bambuMachineName("Bambu Lab P1P", "")).toBe("Bambu Lab P1P 0.4 nozzle");
    expect(bambuMachineName("Q9", "")).toBeNull();
  });
  it("falls back to the serial's model prefix", () => {
    expect(bambuMachineName(undefined, "01P00A431400749")).toBe("Bambu Lab P1S 0.4 nozzle");
    expect(bambuMachineName("", "00M09A123456789")).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
    expect(bambuMachineName("", "ZZZ")).toBeNull();
  });
  it("matches other printers by name, longest model wins", () => {
    const machines = [
      { vendor: "Prusa", name: "Prusa MK4 0.4 nozzle" },
      { vendor: "Prusa", name: "Prusa MK4S 0.4 nozzle" },
      { vendor: "Prusa", name: "Prusa MK4S 0.6 nozzle" },
      { vendor: "Voron", name: "Voron 2.4 350 0.4 nozzle" },
      { vendor: "Creality", name: "Creality Ender-3 V2 0.4 nozzle" },
    ];
    expect(matchMachine("Prusa MK4S", machines)).toEqual({ vendor: "Prusa", name: "Prusa MK4S 0.4 nozzle" });
    expect(matchMachine("Workshop Ender 3 V2", machines)).toEqual({ vendor: "Creality", name: "Creality Ender-3 V2 0.4 nozzle" });
    expect(matchMachine("Voron 2.4 350", machines)).toEqual({ vendor: "Voron", name: "Voron 2.4 350 0.4 nozzle" });
    expect(matchMachine("Garage printer", machines)).toBeNull();
  });
  it("reads a machine preset's default process and filament", () => {
    expect(presetDefaults({ default_print_profile: "0.20mm Standard @BBL X1C", default_filament_profile: ["Bambu PLA Basic @BBL X1C"] })).toEqual({
      process: "0.20mm Standard @BBL X1C",
      filament: "Bambu PLA Basic @BBL X1C",
    });
    expect(presetDefaults({ default_filament_profile: "A;B" })).toEqual({ process: "", filament: "A" });
  });
});

describe("version comparison", () => {
  it("compares dotted versions, ignoring v and suffixes", () => {
    expect(versionLt("0.1.2", "0.1.3")).toBe(true);
    expect(versionLt("v0.1.3", "0.1.3")).toBe(false);
    expect(versionLt("0.1.10", "0.1.3")).toBe(false);
    expect(versionLt("0.2", "0.1.3")).toBe(false);
    expect(versionLt("0.1.3-rc1", "0.1.3")).toBe(false);
    expect(versionLt("", "0.1.3")).toBe(true);
  });
  it("decides when the bridge needs an install", () => {
    const url = "http://127.0.0.1:7781";
    expect(bridgeNeed({ reachable: true, version: "0.1.2", token_source: "file" }, url)?.kind).toBe("upgrade");
    expect(bridgeNeed({ reachable: true, version: "0.1.3", token_source: "file" }, url)).toBeNull();
    expect(bridgeNeed({ reachable: false, token_source: "none" }, url)?.kind).toBe("missing");
    expect(bridgeNeed({ reachable: false, auth_failed: true, token_source: "file" }, url)).toBeNull();
    expect(bridgeNeed({ reachable: false, token_source: "none" }, "http://10.0.0.5:7781")).toBeNull();
  });
});

describe("install scheduling", () => {
  const need = { kind: "missing" as const };
  const t0 = 1_000_000_000;
  it("starts when needed and nothing ran yet; never twice at once", () => {
    expect(shouldStart(null, need, t0, false)).toBe(true);
    expect(shouldStart(null, null, t0, false)).toBe(false);
    expect(shouldStart({ status: "running", started_at: t0 }, need, t0, true)).toBe(false);
  });
  it("waits an hour after a failure unless retried", () => {
    const failed = { status: "failed" as const, started_at: t0, finished_at: t0 + 1000 };
    expect(shouldStart(failed, need, t0 + 60_000, false)).toBe(false);
    expect(shouldStart(failed, need, t0 + 60_000, true)).toBe(true);
    expect(shouldStart(failed, need, t0 + 2 * 3600_000, false)).toBe(true);
  });
  it("doesn't loop an upgrade the latest release can't satisfy", () => {
    const ok = { status: "succeeded" as const, started_at: t0, finished_at: t0 };
    expect(shouldStart(ok, { kind: "upgrade" }, t0 + 3600_000, false)).toBe(false);
    expect(shouldStart(ok, { kind: "upgrade" }, t0 + 13 * 3600_000, false)).toBe(true);
  });
  it("reports the installer's own last lines as the reason", () => {
    expect(failureReason("a\nb\n\ncurl: (6) Could not resolve host\n", 1)).toBe("a | b | curl: (6) Could not resolve host");
    expect(failureReason("", null)).toBe("the installer stopped unexpectedly");
    expect(parseSections("@@EXIT\n0\n@@LOG\nx\ny\n")).toEqual({ EXIT: "0", LOG: "x\ny" });
  });
});

describe("serial sync", () => {
  const p1: PrinterRecord = { id: "p1", name: "P1S", type: "bambu", host: "10.0.0.9", bambu: { serial: "01R00A431706531", access_code: "x" } };
  const p2: PrinterRecord = { id: "p2", name: "Voron", type: "moonraker", host: "voron" };
  it("finds detected serials that differ from the stored one", () => {
    const body = { printers: [{ id: "p1", serial: "01R00A431706531", detected_serial: "01P00A431400749" }, { id: "p2", detected_serial: "01P00A431400749" }] };
    expect(serialFixes([p1, p2], body)).toEqual([{ id: "p1", from: "01R00A431706531", to: "01P00A431400749" }]);
    expect(serialFixes([p1], [{ id: "p1", detected_serial: null }])).toEqual([]);
    expect(serialFixes([p1], [{ id: "p1", detected_serial: "01R00A431706531" }])).toEqual([]);
    expect(serialFixes([p1], [{ id: "p1", detected_serial: "bad serial!" }])).toEqual([]);
  });
  it("switches the serial and remembers the typed one until the user edits it", () => {
    const fixed = withCorrectedSerial(p1, "01P00A431400749");
    expect(fixed.bambu).toMatchObject({ serial: "01P00A431400749", serial_corrected_from: "01R00A431706531", access_code: "x" });
    // A save that keeps the serial keeps the note; typing a new one drops it.
    expect(buildPrinter({ name: "P1S" }, fixed, () => "x").bambu?.serial_corrected_from).toBe("01R00A431706531");
    expect(buildPrinter({ bambu: { serial: "01P00A000000001" } }, fixed, () => "x").bambu?.serial_corrected_from).toBeUndefined();
  });
});
