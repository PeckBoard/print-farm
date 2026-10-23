import { describe, it, expect } from "vitest";
import { moonrakerDriver, moonrakerStatus, absoluteUrl } from "../src/drivers/moonraker";
import { FakeTransport, json } from "./fakeTransport";
import { PrinterRecord } from "../src/drivers/types";

const P: PrinterRecord = { id: "p1", name: "Voron", type: "moonraker", host: "voron.lan" };

const PRINTING = {
  result: {
    status: {
      print_stats: { state: "printing", filename: "benchy.gcode", print_duration: 600, message: "", info: { current_layer: 12, total_layer: 120 } },
      virtual_sdcard: { progress: 0.25 },
      extruder: { temperature: 239.6, target: 240 },
      heater_bed: { temperature: 59.9, target: 60 },
    },
  },
};

describe("moonraker", () => {
  it("normalises a printing status with an eta", () => {
    const t = new FakeTransport([["GET /printer/objects/query", json(PRINTING)]]);
    const st = moonrakerDriver(P, t).status();
    expect(st).toMatchObject({
      state: "printing",
      progress: 0.25,
      file: "benchy.gcode",
      elapsed_s: 600,
      eta_s: 1800,
      layer: 12,
      total_layers: 120,
      temps: { nozzle: { actual: 239.6, target: 240 }, bed: { actual: 59.9, target: 60 } },
      message: null,
    });
    expect(t.calls[0].url).toBe("http://voron.lan:7125/printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed");
  });

  it("maps complete → finished with progress 1, standby → idle", () => {
    expect(moonrakerStatus({ status: { print_stats: { state: "complete" }, virtual_sdcard: { progress: 0.99 } } })).toMatchObject({
      state: "finished",
      progress: 1,
    });
    expect(moonrakerStatus({ status: { print_stats: { state: "standby" } } }).state).toBe("idle");
  });

  it("is offline when unreachable and error when Klippy is not ready", () => {
    expect(moonrakerDriver(P, new FakeTransport([["GET /printer", new Error("connect refused")]])).status()).toMatchObject({
      state: "offline",
      message: "connect refused",
    });
    const t = new FakeTransport([["GET /printer", json({ error: { message: "Klippy Disconnected" } }, 503)]]);
    expect(moonrakerDriver(P, t).status()).toMatchObject({ state: "error", message: "Klippy Disconnected" });
  });

  it("uploads multipart from disk and starts by filename", () => {
    const t = new FakeTransport([["POST /server/files/upload", json({ result: {} })], ["POST /printer/print/start", json({ result: "ok" })]]);
    const d = moonrakerDriver({ ...P, api_key: "K" }, t);
    d.upload("cube 1.gcode", { path: "/data/files/f1-cube 1.gcode" });
    d.start("cube 1.gcode");
    expect(t.calls[0].form).toEqual({ fields: { root: "gcodes" }, file: { field: "file", path: "/data/files/f1-cube 1.gcode", filename: "cube 1.gcode" } });
    expect(t.calls[0].headers).toMatchObject({ "X-Api-Key": "K" });
    expect(t.calls[1].url).toBe("http://voron.lan:7125/printer/print/start?filename=cube%201.gcode");
  });

  it("throws on a failed control call", () => {
    const t = new FakeTransport([["POST /printer/print/pause", json({ error: "nope" }, 400)]]);
    expect(() => moonrakerDriver(P, t).pause()).toThrow(/moonraker pause failed: HTTP 400/);
  });

  it("fetches a snapshot from the first enabled webcam", () => {
    const t = new FakeTransport([
      ["GET /server/webcams/list", json({ result: { webcams: [{ enabled: false, snapshot_url: "/x" }, { enabled: true, snapshot_url: "/webcam/?action=snapshot" }] } })],
      ["GET /webcam/", { status: 200, bodyBase64: "/9j/AA==", contentType: "image/jpeg" }],
    ]);
    expect(moonrakerDriver(P, t).snapshot()).toEqual({ content_type: "image/jpeg", data_base64: "/9j/AA==" });
    expect(t.calls[1].url).toBe("http://voron.lan/webcam/?action=snapshot");
    expect(t.calls[1].binaryResponse).toBe(true);
  });

  it("resolves absolute and relative webcam urls", () => {
    expect(absoluteUrl("http://h:7125", "http://cam/snap")).toBe("http://cam/snap");
    expect(absoluteUrl("http://h:7125", "webcam/snap")).toBe("http://h/webcam/snap");
  });
});
