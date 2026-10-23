import { describe, it, expect } from "vitest";
import { buildOrcaArgs, parsePoll, settle, resolveOrca, parseKv } from "../src/slice";

describe("orca command line", () => {
  it("builds a plain G-code slice", () => {
    expect(buildOrcaArgs({ orca: "orca-slicer", modelPath: "/s/files/f1-cube.stl", jobDir: "/s/jobs/j1", target: "gcode" })).toEqual([
      "orca-slicer",
      "--arrange", "1",
      "--slice", "0",
      "--load-settings", "/s/jobs/j1/printer.json;/s/jobs/j1/process.json",
      "--load-filaments", "/s/jobs/j1/filament.json",
      "--outputdir", "/s/jobs/j1/out",
      "/s/files/f1-cube.stl",
    ]);
  });

  it("exports a .gcode.3mf for Bambu and honours orient/arrange", () => {
    const a = buildOrcaArgs({ orca: "/opt/Orca.AppImage", modelPath: "/m.3mf", jobDir: "/j", target: "gcode.3mf", orient: true, arrange: false });
    expect(a.slice(0, 5)).toEqual(["/opt/Orca.AppImage", "--arrange", "0", "--orient", "1"]);
    expect(a).toContain("--export-3mf");
    expect(a[a.indexOf("--export-3mf") + 1]).toBe("result.gcode.3mf");
    expect(a[a.length - 1]).toBe("/m.3mf");
  });
});
describe("orca resolution", () => {
  const S = "/data/print-farm";

  it("uses the configured command when it is on PATH", () => {
    expect(resolveOrca("orca-slicer", parseKv("path=/usr/bin/orca-slicer\nlocal=/h/.local/bin/orca-slicer"), S)).toEqual({
      argv: ["orca-slicer"],
      resolved: "/usr/bin/orca-slicer",
      via: "path",
    });
  });

  it("falls back to ~/.local/bin, then flatpak, for the default only", () => {
    expect(resolveOrca("orca-slicer", parseKv("path=\nlocal=/h/.local/bin/orca-slicer\nflatpak=com.orcaslicer.OrcaSlicer"), S)?.argv).toEqual([
      "/h/.local/bin/orca-slicer",
    ]);
    const fp = resolveOrca("orca-slicer", parseKv("path=\nflatpak=io.github.softfever.OrcaSlicer"), S);
    expect(fp).toEqual({
      argv: ["flatpak", "run", "--filesystem=/data/print-farm", "io.github.softfever.OrcaSlicer"],
      resolved: "flatpak run io.github.softfever.OrcaSlicer",
      via: "flatpak",
    });
    expect(buildOrcaArgs({ orca: fp!.argv, modelPath: "/m.stl", jobDir: "/j", target: "gcode" }).slice(0, 5)).toEqual([
      "flatpak", "run", "--filesystem=/data/print-farm", "io.github.softfever.OrcaSlicer", "--arrange",
    ]);
  });

  it("runs a non-flatpak OrcaSlicer with the fetched host libraries on LD_LIBRARY_PATH", () => {
    const kv = "extralib=/h/.local/share/orca-slicer/extra-lib\npath=\nlocal=/h/.local/bin/orca-slicer\nflatpak=com.orcaslicer.OrcaSlicer";
    expect(resolveOrca("orca-slicer", parseKv(kv), S)?.argv).toEqual([
      "env", "LD_LIBRARY_PATH=/h/.local/share/orca-slicer/extra-lib", "/h/.local/bin/orca-slicer",
    ]);
    expect(resolveOrca("orca-slicer", parseKv("extralib=/x\npath=\nflatpak=com.orcaslicer.OrcaSlicer"), S)?.argv[0]).toBe("flatpak");
  });

  it("is null when nothing is found or a custom path is missing", () => {
    expect(resolveOrca("orca-slicer", parseKv("path="), S)).toBeNull();
    expect(resolveOrca("/opt/Orca.AppImage", parseKv("path=\nlocal=/h/.local/bin/orca-slicer"), S)).toBeNull();
  });
});


describe("job polling", () => {
  const poll = (exit: string, alive: string, ls: string[], log = "", result = "") =>
    ["@@EXIT", ...(exit ? [exit] : []), "@@ALIVE", alive, "@@LS", ...ls, "@@RESULT", ...(result ? [result] : []), "@@LOG", log, ""].join("\n");

  it("is running while the pid lives and no exit code exists", () => {
    const p = parsePoll(poll("", "1", []));
    expect(p).toMatchObject({ exited: false, alive: true });
    expect(settle(p, "gcode").status).toBe("running");
  });

  it("succeeds with plate_1.gcode / result.gcode.3mf", () => {
    expect(settle(parsePoll(poll("0", "0", ["plate_1.gcode", "result.json"])), "gcode")).toEqual({ status: "succeeded", output: "plate_1.gcode" });
    expect(settle(parsePoll(poll("0", "0", ["result.gcode.3mf"])), "gcode.3mf")).toEqual({ status: "succeeded", output: "result.gcode.3mf" });
  });

  it("fails with result.json's error verbatim (plus Orca's code), else the log tail", () => {
    const withResult = parsePoll(poll("1", "0", ["result.json"], "x", '{"return_code": -5, "error_string": "Nothing to be sliced"}'));
    expect(settle(withResult, "gcode")).toEqual({ status: "failed", error: "Nothing to be sliced (OrcaSlicer error -5)" });
    const compat = '{"return_code": 239, "error_string": "The selected printer is not compatible with the process preset in the 3mf."}';
    expect(settle(parsePoll(poll("239", "0", ["result.json"], "", compat)), "gcode").error).toBe(
      "The selected printer is not compatible with the process preset in the 3mf. (OrcaSlicer error 239)",
    );
    const withLog = parsePoll(poll("134", "0", [], "loading...\nerror: profile mismatch\n"));
    expect(settle(withLog, "gcode").error).toMatch(/profile mismatch/);
    // A "Success." result with no output file isn't the reason — the log is.
    const ok = parsePoll(poll("0", "0", ["result.json"], "no plates\n", '{"return_code": 0, "error_string": "Success."}'));
    expect(settle(ok, "gcode").error).toBe("no plates");
  });

  it("fails when the process died without an exit code", () => {
    expect(settle(parsePoll(poll("", "0", [])), "gcode").status).toBe("failed");
  });
});
