import { describe, it, expect } from "vitest";
import { buildOrcaArgs, parsePoll, settle } from "../src/slice";

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

  it("fails with result.json's error, else the log tail", () => {
    const withResult = parsePoll(poll("1", "0", ["result.json"], "x", '{"return_code": -5, "error_string": "Nothing to be sliced"}'));
    expect(settle(withResult, "gcode")).toEqual({ status: "failed", error: "Nothing to be sliced" });
    const withLog = parsePoll(poll("134", "0", [], "loading...\nerror: profile mismatch\n"));
    expect(settle(withLog, "gcode").error).toMatch(/profile mismatch/);
  });

  it("fails when the process died without an exit code", () => {
    expect(settle(parsePoll(poll("", "0", [])), "gcode").status).toBe("failed");
  });
});
