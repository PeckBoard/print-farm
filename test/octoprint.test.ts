import { describe, it, expect } from "vitest";
import { octoprintDriver, octoprintSnapshotUrl, rebaseSnapshotUrl } from "../src/drivers/octoprint";
import { FakeTransport, json } from "./fakeTransport";
import { PrinterRecord } from "../src/drivers/types";

const P: PrinterRecord = { id: "p2", name: "Ender", type: "octoprint", host: "octopi.local", api_key: "OK" };

const JOB = {
  job: { file: { name: "part.gcode" } },
  progress: { completion: 42.5, printTime: 1200, printTimeLeft: 1600 },
  state: "Printing",
};
const PRINTER = {
  temperature: { tool0: { actual: 210, target: 210 }, bed: { actual: 60, target: 60 } },
  state: { text: "Printing", flags: { printing: true, paused: false, error: false, ready: false, operational: true } },
};

describe("octoprint", () => {
  it("normalises a printing status", () => {
    const t = new FakeTransport([["GET /api/job", json(JOB)], ["GET /api/printer", json(PRINTER)]]);
    const st = octoprintDriver(P, t).status();
    expect(st).toMatchObject({
      state: "printing",
      progress: 0.425,
      file: "part.gcode",
      elapsed_s: 1200,
      eta_s: 1600,
      temps: { nozzle: { actual: 210, target: 210 }, bed: { actual: 60, target: 60 } },
    });
    expect(t.calls[0].url).toBe("http://octopi.local/api/job");
    expect(t.calls[0].headers).toMatchObject({ "X-Api-Key": "OK" });
  });

  it("is offline when the printer is disconnected (409)", () => {
    const t = new FakeTransport([["GET /api/job", json({ state: "Offline", job: {}, progress: {} })], ["GET /api/printer", json({ error: "Printer is not operational" }, 409)]]);
    expect(octoprintDriver(P, t).status()).toMatchObject({ state: "offline", message: "Offline" });
  });

  it("maps paused and finished", () => {
    const paused = { ...PRINTER, state: { text: "Paused", flags: { paused: true, printing: false } } };
    let t = new FakeTransport([["GET /api/job", json(JOB)], ["GET /api/printer", json(paused)]]);
    expect(octoprintDriver(P, t).status().state).toBe("paused");
    const done = { ...JOB, progress: { completion: 100, printTime: 3000, printTimeLeft: 0 } };
    const idle = { ...PRINTER, state: { text: "Operational", flags: { operational: true, ready: true } } };
    t = new FakeTransport([["GET /api/job", json(done)], ["GET /api/printer", json(idle)]]);
    expect(octoprintDriver(P, t).status()).toMatchObject({ state: "finished", progress: 1, eta_s: null });
  });

  it("uploads multipart and starts with a select+print command", () => {
    const t = new FakeTransport([["POST /api/files/local", json({ done: true }, 201)]]);
    const d = octoprintDriver(P, t);
    d.upload("a b.gcode", { path: "/s/f1-a b.gcode" });
    d.start("a b.gcode");
    expect(t.calls[0].form?.fields).toEqual({ select: "false", print: "false" });
    expect(t.calls[1].url).toBe("http://octopi.local/api/files/local/a%20b.gcode");
    expect(JSON.parse(t.calls[1].body!)).toEqual({ command: "select", print: true });
  });

  it("sends pause/resume/cancel job commands", () => {
    const t = new FakeTransport([["POST /api/job", { status: 204 }]]);
    const d = octoprintDriver(P, t);
    d.pause();
    d.resume();
    d.cancel();
    expect(t.calls.map((c) => JSON.parse(c.body!))).toEqual([
      { command: "pause", action: "pause" },
      { command: "pause", action: "resume" },
      { command: "cancel" },
    ]);
  });

  it("finds and rebases the snapshot url", () => {
    expect(octoprintSnapshotUrl({ plugins: { classicwebcam: { snapshot: "http://127.0.0.1:8080/?action=snapshot" } } })).toBe(
      "http://127.0.0.1:8080/?action=snapshot",
    );
    expect(octoprintSnapshotUrl({ webcam: { snapshotUrl: "/webcam/?action=snapshot" } })).toBe("/webcam/?action=snapshot");
    expect(rebaseSnapshotUrl("http://octopi.local", "http://127.0.0.1:8080/?action=snapshot")).toBe("http://octopi.local:8080/?action=snapshot");
    expect(rebaseSnapshotUrl("http://octopi.local", "/webcam/?action=snapshot")).toBe("http://octopi.local/webcam/?action=snapshot");
  });

  it("returns null snapshot without a configured webcam", () => {
    const t = new FakeTransport([["GET /api/settings", json({ webcam: {} })]]);
    expect(octoprintDriver(P, t).snapshot()).toBeNull();
  });
});
