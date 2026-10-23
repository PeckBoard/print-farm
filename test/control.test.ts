// Printer controls: validation, the mid-print guard, per-driver mapping, and
// the bridge's developer-mode refusal surfacing as a 409 with the fix.

import { describe, it, expect } from "vitest";
import { parseControl, guardControl, runControl, validRemoteName, describeAction } from "../src/control";
import { bambuDriver, bambuCapabilities, bridgeCommand, coerceDetail } from "../src/drivers/bambu";
import { moonrakerDriver, moonrakerCapabilities, gcodeFor, moonrakerDetail } from "../src/drivers/moonraker";
import { octoprintRequest, flattenOctoprintFiles, octoprintCapabilities } from "../src/drivers/octoprint";
import { prusalinkFiles, prusalinkDriver } from "../src/drivers/prusalink";
import { DriverError, PrinterRecord, emptyStatus } from "../src/drivers/types";
import { errorBody, errorStatus } from "../src/http";
import { confirmationVerdict } from "../src/prints";
import { FakeTransport, json } from "./fakeTransport";

const BAMBU: PrinterRecord = {
  id: "p2",
  name: "P1S",
  type: "bambu",
  host: "192.168.1.55",
  bambu: { serial: "01P00A000000000", access_code: "12345678", model: "P1S" },
};
const BRIDGE = { url: "http://127.0.0.1:7781", token: "tok" };

function thrown(f: () => unknown): DriverError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(DriverError);
    return e as DriverError;
  }
  throw new Error("did not throw");
}

describe("parseControl", () => {
  const caps = bambuCapabilities("P1S");
  it("accepts valid actions and normalises them", () => {
    expect(parseControl({ action: "cancel" }, caps)).toEqual({ action: "stop" });
    expect(parseControl({ action: "temp", heater: "bed", target: "60.4" }, caps)).toEqual({ action: "temp", heater: "bed", target: 60 });
    expect(parseControl({ action: "jog", axis: "Z", distance: -1 }, caps)).toEqual({ action: "jog", axis: "z", distance: -1 });
    expect(parseControl({ action: "load", slot: "external" }, caps)).toEqual({ action: "load", slot: "external" });
    expect(parseControl({ action: "speed", level: 3 }, caps)).toEqual({ action: "speed", level: 3 });
    // A speed level on a percent-only printer maps to Bambu's percentages.
    expect(parseControl({ action: "speed", level: 4 }, moonrakerCapabilities())).toEqual({ action: "speed", percent: 166 });
  });
  it("rejects out-of-range values and unsupported controls with 400", () => {
    for (const body of [
      { action: "temp", heater: "nozzle", target: 301 },
      { action: "temp", heater: "chamber", target: 40 },
      { action: "fan", fan: "chamber", percent: 101 },
      { action: "jog", axis: "x", distance: 100.5 },
      { action: "gcode", line: "G28\nM18" },
      { action: "gcode", line: "x".repeat(257) },
      { action: "load", slot: 16 },
      { action: "speed", percent: 120 },
      { action: "explode" },
    ]) {
      expect(thrown(() => parseControl(body, caps)).status, JSON.stringify(body)).toBe(400);
    }
    expect(thrown(() => parseControl({ action: "fan", fan: "aux", percent: 10 }, bambuCapabilities("A1 mini"))).message).toMatch(/not supported/);
    expect(thrown(() => parseControl({ action: "home" }, prusalinkDriver({ ...BAMBU, type: "prusalink" }, new FakeTransport([])).capabilities())).status).toBe(400);
  });
});

describe("guardControl", () => {
  const printing = { ...emptyStatus("printing"), temps: { nozzle: { actual: 220, target: 220 } } };
  it("refuses motion mid-print and cold extrusion, allows tuning", () => {
    expect(thrown(() => guardControl({ action: "home" }, printing)).status).toBe(409);
    expect(thrown(() => guardControl({ action: "gcode", line: "M115" }, { ...printing, state: "paused" })).status).toBe(409);
    expect(() => guardControl({ action: "fan", fan: "part", percent: 50 }, printing)).not.toThrow();
    const cold = { ...emptyStatus("idle"), temps: { nozzle: { actual: 25, target: 0 } } };
    expect(thrown(() => guardControl({ action: "extrude", mm: 5 }, cold)).message).toMatch(/170/);
    expect(() => guardControl({ action: "extrude", mm: 5 }, { ...cold, temps: { nozzle: { actual: 200, target: 200 } } })).not.toThrow();
  });
});

describe("bambu controls via print-bridge", () => {
  it("maps actions onto the bridge's command bodies", () => {
    expect(bridgeCommand({ action: "fan", fan: "aux", percent: 40 })).toEqual({ path: "/command", body: { type: "fan", fan: "aux", percent: 40 } });
    expect(bridgeCommand({ action: "motors_off" })).toEqual({ path: "/command", body: { type: "motors_off" } });
    expect(bridgeCommand({ action: "stop" }).path).toBe("/stop");
    expect(() => bridgeCommand({ action: "speed", percent: 120 })).toThrow(DriverError);
  });

  it("surfaces a developer-mode refusal as 409 with the fix", () => {
    const refusal = json({ ok: false, error: "printer refused", reason: "mqtt message verify failed", err_code: 84033543, needs_developer_mode: true }, 409);
    const t = new FakeTransport([
      ["GET /printers/p2/status", json({ state: "idle", temps: {} })],
      ["POST /printers/p2/command", refusal],
      ["POST /printers/p2/start", refusal],
    ]);
    const d = bambuDriver(BAMBU, t, BRIDGE);
    const e = thrown(() => runControl(d, { action: "light", on: true }));
    expect(e.status).toBe(409);
    expect(errorBody(e)).toEqual({
      error: "Printer refused the command",
      hint: "On the printer: Settings → enable LAN Only Mode, then Developer Mode.",
      needs_developer_mode: true,
    });
    expect(errorStatus(e)).toBe(409);
    // Start no longer reports success when the printer refuses it.
    expect(thrown(() => d.start("cube.gcode.3mf")).needs_developer_mode).toBe(true);
  });

  it("returns confirmed:false when the printer didn't answer, and passes other errors through", () => {
    const t = new FakeTransport([
      ["GET /printers/p2/status", json({ state: "idle", temps: { nozzle: { actual: 25, target: 0 } } })],
      ["POST /printers/p2/command", (req) => (JSON.parse(req.body!).type === "home" ? json({ ok: true, confirmed: false }) : json({ ok: false, error: "printer refused the command: busy" }, 502))],
    ]);
    const d = bambuDriver(BAMBU, t, BRIDGE);
    expect(runControl(d, { action: "home" })).toEqual({ ok: true, confirmed: false });
    const e = thrown(() => runControl(d, { action: "temp", heater: "bed", target: 60 }));
    expect([e.status, e.message, e.needs_developer_mode]).toEqual([502, "printer refused the command: busy", undefined]);
  });

  it("reads the detail fields and printer files", () => {
    const d = coerceDetail({
      state: "idle",
      temps: {},
      speed_level: 2,
      fans: { part: 100, aux: 0 },
      light: "on",
      wifi_signal: "-48dBm",
      firmware: "01.07.00.00",
      developer_mode: false,
      errors: [{ code: "0500_0500_0001_0007", text: "MQTT command verification failed", severity: "fatal", url: "https://x" }],
    });
    expect(d).toMatchObject({ speed_level: 2, speed_percent: null, fans: { part: 100, aux: 0 }, light: "on", firmware: "01.07.00.00", developer_mode: false, ams: null });
    expect(d.errors[0]).toEqual({ code: "0500_0500_0001_0007", text: "MQTT command verification failed", severity: "fatal", url: "https://x" });
    expect(coerceDetail({ state: "idle" })).toMatchObject({ developer_mode: null, errors: [], light: null });

    const t = new FakeTransport([
      ["GET /printers/p2/files", json({ files: [{ name: "a.3mf", size: 10, mtime: 1700000000 }, { name: "cache/b.3mf", size: 5, mtime: null }] })],
      ["DELETE /printers/p2/files", json({ ok: true })],
    ]);
    const drv = bambuDriver(BAMBU, t, BRIDGE);
    expect(drv.files()).toEqual([
      { name: "a.3mf", size: 10, mtime: 1700000000 },
      { name: "cache/b.3mf", size: 5, mtime: null },
    ]);
    drv.deleteFile("cache/b.3mf");
    expect(t.calls[1].url).toBe("http://127.0.0.1:7781/printers/p2/files?name=cache%2Fb.3mf");
  });

  it("hides fans the model doesn't have", () => {
    expect(bambuCapabilities("A1").fans).toEqual(["part"]);
    expect(bambuCapabilities("P1P").fans).toEqual(["part", "aux"]);
    expect(bambuCapabilities("P1S").temps.chamber).toBeNull();
  });
});

describe("moonraker / octoprint / prusalink controls", () => {
  it("builds G-code for moonraker and posts it as a script", () => {
    expect(gcodeFor({ action: "jog", axis: "x", distance: 10 })).toBe("G91\nG1 X10 F3000\nG90");
    expect(gcodeFor({ action: "fan", fan: "part", percent: 50 })).toBe("M106 S128");
    expect(gcodeFor({ action: "speed", percent: 150 })).toBe("M220 S150");
    const t = new FakeTransport([["POST /printer/gcode/script", json({ result: "ok" })]]);
    moonrakerDriver({ id: "k", name: "K", type: "moonraker", host: "10.0.0.2" }, t).control({ action: "home" });
    expect(t.calls[0].url).toBe("http://10.0.0.2:7125/printer/gcode/script?script=G28");
    expect(moonrakerDetail({ status: { print_stats: { state: "standby" }, gcode_move: { speed_factor: 1.5 }, fan: { speed: 0.25 } } })).toMatchObject({
      speed_percent: 150,
      fans: { part: 25 },
    });
  });

  it("lists and deletes moonraker files", () => {
    const t = new FakeTransport([
      ["GET /server/files/list", json({ result: [{ path: "sub/a.gcode", modified: 1700000000.6, size: 12 }] })],
      ["DELETE /server/files/gcodes/", json({ result: {} })],
    ]);
    const d = moonrakerDriver({ id: "k", name: "K", type: "moonraker", host: "10.0.0.2" }, t);
    expect(d.files()).toEqual([{ name: "sub/a.gcode", size: 12, mtime: 1700000001 }]);
    d.deleteFile("sub/my file.gcode");
    expect(t.calls[1].url).toBe("http://10.0.0.2:7125/server/files/gcodes/sub/my%20file.gcode");
  });

  it("maps octoprint actions onto its REST API", () => {
    expect(octoprintRequest({ action: "jog", axis: "y", distance: -5 })).toEqual({ path: "/api/printer/printhead", body: { command: "jog", y: -5 } });
    expect(octoprintRequest({ action: "temp", heater: "nozzle", target: 210 })).toEqual({ path: "/api/printer/tool", body: { command: "target", targets: { tool0: 210 } } });
    expect(octoprintRequest({ action: "temp", heater: "bed", target: 60 }).path).toBe("/api/printer/bed");
    expect(octoprintRequest({ action: "extrude", mm: 5 })).toEqual({ path: "/api/printer/tool", body: { command: "extrude", amount: 5 } });
    expect(octoprintRequest({ action: "motors_off" })).toEqual({ path: "/api/printer/command", body: { commands: ["M18"] } });
    expect(octoprintCapabilities().load_unload).toBe(false);
    expect(
      flattenOctoprintFiles([
        { type: "folder", name: "d", children: [{ type: "machinecode", path: "d/a.gcode", size: 3, date: 5 }] },
        { type: "machinecode", path: "b.gcode", size: 4, date: null },
      ]),
    ).toEqual([
      { name: "d/a.gcode", size: 3, mtime: 5 },
      { name: "b.gcode", size: 4, mtime: null },
    ]);
  });

  it("reads prusalink's top-level files", () => {
    expect(
      prusalinkFiles({ children: [{ name: "A.BGC", type: "PRINT_FILE", size: 9, m_timestamp: 7 }, { name: "dir", type: "FOLDER" }] }),
    ).toEqual([{ name: "A.BGC", size: 9, mtime: 7 }]);
  });
});

describe("helpers", () => {
  it("validates printer storage paths", () => {
    expect(validRemoteName("cache/a.3mf")).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a\\b", "x\ny"]) expect(validRemoteName(bad), bad).toBe(false);
  });
  it("words confirmations and checks the confirm label", () => {
    expect(describeAction({ action: "extrude", mm: -3 })).toBe("retract 3 mm of filament");
    expect(confirmationVerdict({ status: "answered", answer: "Yes, do it" }, "Yes, do it")).toBe("start");
    expect(confirmationVerdict({ status: "answered", answer: "Start print" }, "Yes, do it")).toBe("declined");
    expect(confirmationVerdict({ status: "answered", answer: "Start print" })).toBe("start");
  });
});

describe("active AMS tray", () => {
  it("passes the bridge's ams.active through to detail", () => {
    const ams = { trays: [{ slot: 2, unit: 0, tray: 2, type: "PLA", color: "161616FF" }], external: null };
    expect(coerceDetail({ state: "idle", ams: { ...ams, active: 2 } }).ams?.active).toBe(2);
    expect(coerceDetail({ state: "idle", ams: { ...ams, active: "external" } }).ams?.active).toBe("external");
    expect(coerceDetail({ state: "idle", ams: { ...ams, active: "bogus" } }).ams?.active).toBeNull();
    expect(coerceDetail({ state: "idle", ams }).ams?.active).toBeNull();
  });
});
