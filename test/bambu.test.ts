import { describe, it, expect } from "vitest";
import { bambuDriver, coerceStatus } from "../src/drivers/bambu";
import { FakeTransport, json } from "./fakeTransport";
import { PrinterRecord } from "../src/drivers/types";

const P: PrinterRecord = {
  id: "p4",
  name: "X1C",
  type: "bambu",
  host: "192.168.1.60",
  bambu: { serial: "00M00A000000000", access_code: "12345678", model: "X1C" },
};
const BRIDGE = { url: "http://127.0.0.1:7781/", token: "tok" };

const STATUS = {
  state: "printing",
  progress: 0.5,
  file: "plate.gcode.3mf",
  elapsed_s: 100,
  eta_s: 100,
  layer: 3,
  total_layers: 6,
  temps: { nozzle: { actual: 220, target: 220 }, bed: { actual: 55, target: 55 }, chamber: { actual: 30, target: null } },
  message: null,
};

describe("bambu via print-bridge", () => {
  it("passes the normalised status through with the bearer token", () => {
    const t = new FakeTransport([["GET /printers/p4/status", json(STATUS)]]);
    expect(bambuDriver(P, t, BRIDGE).status()).toEqual(STATUS);
    expect(t.calls[0].url).toBe("http://127.0.0.1:7781/printers/p4/status");
    expect(t.calls[0].headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("coerces a malformed status defensively", () => {
    expect(coerceStatus({ state: "weird", progress: 7 })).toMatchObject({ state: "offline", progress: 1, temps: {} });
  });

  it("re-registers the printer when the bridge has forgotten it", () => {
    let n = 0;
    const t = new FakeTransport([
      ["GET /printers/p4/status", () => (n++ === 0 ? { status: 404 } : json(STATUS))],
      ["PUT /printers/p4", json({ ok: true })],
    ]);
    expect(bambuDriver(P, t, BRIDGE).status().state).toBe("printing");
    const put = t.calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ host: "192.168.1.60", serial: "00M00A000000000", access_code: "12345678", model: "X1C" });
  });

  it("uploads raw from disk and starts with plate/ams options", () => {
    const t = new FakeTransport([["POST /printers/p4/upload", json({ ok: true })], ["POST /printers/p4/start", json({ ok: true })]]);
    const d = bambuDriver(P, t, BRIDGE);
    d.upload("cube.gcode.3mf", { path: "/s/f2-cube.gcode.3mf" });
    d.start("cube.gcode.3mf", { use_ams: true });
    expect(t.calls[0]).toMatchObject({ url: "http://127.0.0.1:7781/printers/p4/upload?name=cube.gcode.3mf", bodyFile: "/s/f2-cube.gcode.3mf" });
    expect(JSON.parse(t.calls[1].body!)).toEqual({ file: "cube.gcode.3mf", plate: 1, use_ams: true, bed_leveling: true });
  });

  it("maps cancel to /stop and a 404 snapshot to null", () => {
    const t = new FakeTransport([["POST /printers/p4/stop", json({ ok: true })], ["GET /printers/p4/snapshot", { status: 404 }]]);
    const d = bambuDriver(P, t, BRIDGE);
    d.cancel();
    expect(t.calls[0].url).toMatch(/\/stop$/);
    expect(d.snapshot()).toBeNull();
  });

  it("reports an unreachable bridge in test()", () => {
    const t = new FakeTransport([["GET /health", new Error("connection refused")]]);
    expect(bambuDriver(P, t, BRIDGE).test()).toMatchObject({ ok: false, detail: expect.stringMatching(/unreachable/) });
  });
});
