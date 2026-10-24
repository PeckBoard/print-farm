import { describe, it, expect } from "vitest";
import { prusalinkDriver } from "../src/drivers/prusalink";
import { parseControl } from "../src/control";
import { FakeTransport, json } from "./fakeTransport";
import { PrinterRecord } from "../src/drivers/types";

const P: PrinterRecord = { id: "p3", name: "MK4", type: "prusalink", host: "192.168.1.50", password: "pw" };

const STATUS = {
  job: { id: 297, progress: 66, time_remaining: 600, time_printing: 1200 },
  printer: { state: "PRINTING", temp_nozzle: 214.9, target_nozzle: 215, temp_bed: 59.8, target_bed: 60 },
};
const JOB = { id: 297, state: "PRINTING", progress: 66, time_remaining: 600, time_printing: 1200, file: { name: "SHAPE~1.BGC", display_name: "shape.bgcode" } };

describe("prusalink", () => {
  it("normalises status + job and authenticates with digest", () => {
    const t = new FakeTransport([["GET /api/v1/status", json(STATUS)], ["GET /api/v1/job", json(JOB)]]);
    const st = prusalinkDriver(P, t).status();
    expect(st).toMatchObject({
      state: "printing",
      progress: 0.66,
      file: "shape.bgcode",
      elapsed_s: 1200,
      eta_s: 600,
      temps: { nozzle: { actual: 214.9, target: 215 }, bed: { actual: 59.8, target: 60 } },
    });
    expect(t.calls[0].digest).toEqual({ user: "maker", pass: "pw" });
  });

  it("uses X-Api-Key when no password is set", () => {
    const t = new FakeTransport([["GET /api/v1/status", json({ printer: { state: "IDLE" } })]]);
    const st = prusalinkDriver({ ...P, password: undefined, api_key: "AK" }, t).status();
    expect(st.state).toBe("idle");
    expect(t.calls[0].headers).toMatchObject({ "X-Api-Key": "AK" });
    expect(t.calls[0].digest).toBeUndefined();
    expect(t.calls.length).toBe(1); // no job → no /job call
  });

  it("maps ATTENTION to error with a message", () => {
    const t = new FakeTransport([["GET /api/v1/status", json({ printer: { state: "ATTENTION" } })]]);
    expect(prusalinkDriver(P, t).status()).toMatchObject({ state: "error", message: expect.stringMatching(/attention/) });
  });

  it("uploads with PUT from disk, then starts with POST", () => {
    const t = new FakeTransport([["PUT /api/v1/files/usb/", { status: 201 }], ["POST /api/v1/files/usb/", { status: 204 }]]);
    const d = prusalinkDriver(P, t);
    d.upload("my part.gcode", { path: "/s/f9-my part.gcode" });
    d.start("my part.gcode");
    expect(t.calls[0]).toMatchObject({
      method: "PUT",
      url: "http://192.168.1.50/api/v1/files/usb/my%20part.gcode",
      bodyFile: "/s/f9-my part.gcode",
      headers: { "Content-Type": "text/x.gcode", Overwrite: "?1", "Print-After-Upload": "?0" },
    });
    expect(t.calls[1].method).toBe("POST");
  });

  it("pauses/resumes/cancels the active job by id", () => {
    const t = new FakeTransport([
      ["GET /api/v1/status", json(STATUS)],
      ["PUT /api/v1/job/297/pause", { status: 204 }],
      ["PUT /api/v1/job/297/resume", { status: 204 }],
      ["DELETE /api/v1/job/297", { status: 204 }],
    ]);
    const d = prusalinkDriver(P, t);
    d.pause();
    d.resume();
    d.cancel();
    expect(t.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.replace("http://192.168.1.50", "")}`)).toEqual([
      "PUT /api/v1/job/297/pause",
      "PUT /api/v1/job/297/resume",
      "DELETE /api/v1/job/297",
    ]);
  });

  it("refuses to pause without an active job", () => {
    const t = new FakeTransport([["GET /api/v1/status", json({ printer: { state: "IDLE" } })]]);
    expect(() => prusalinkDriver(P, t).pause()).toThrow(/no active job/);
  });

describe("prusalink start", () => {
  const PRINTING = { job: { id: 5 }, printer: { state: "PRINTING" } };
  const JOB5 = { id: 5, file: { name: "PART~1.BGC", display_name: "part.bgcode" } };

  it("waits up to 60 s for the start answer", () => {
    const t = new FakeTransport([["POST /api/v1/files/usb/part.bgcode", { status: 204 }]]);
    prusalinkDriver(P, t, () => {}).start("part.bgcode");
    expect(t.calls[0].timeoutSecs).toBe(60);
  });

  it("treats a timed-out start as started once the printer runs the file", () => {
    let polls = 0;
    const t = new FakeTransport([
      ["POST /api/v1/files/usb/", new Error("request to http://192.168.1.50/api/v1/files/usb/part.bgcode timed out")],
      ["GET /api/v1/status", () => (++polls < 3 ? json({ printer: { state: "BUSY" } }) : json(PRINTING))],
      ["GET /api/v1/job", json(JOB5)],
    ]);
    const waits: number[] = [];
    prusalinkDriver(P, t, (s) => waits.push(s)).start("part.bgcode");
    expect(waits).toEqual([5, 5]);
  });

  it("fails without consuming anything when the printer never confirms", () => {
    const t = new FakeTransport([
      ["POST /api/v1/files/usb/", { status: 503 }],
      ["GET /api/v1/status", json({ printer: { state: "IDLE" } })],
    ]);
    expect(() => prusalinkDriver(P, t, () => {}).start("part.bgcode")).toThrow(/didn't confirm .*HTTP 503.*still queued/);
  });

  it("fails at once on a definite refusal", () => {
    const t = new FakeTransport([["POST /api/v1/files/usb/", { status: 404, body: "no such file" }]]);
    expect(() => prusalinkDriver(P, t, () => {}).start("part.bgcode")).toThrow(/prusalink start failed: HTTP 404/);
    expect(t.calls.length).toBe(1);
  });

  it("can't set temperatures and says why", () => {
    const caps = prusalinkDriver(P, new FakeTransport([])).capabilities();
    expect(caps.temps).toEqual({ nozzle: null, bed: null, chamber: null });
    expect(() => parseControl({ action: "temp", heater: "bed", target: 60 }, caps)).toThrow(/PrusaLink has no API to set heater temperatures/);
  });
});
});
