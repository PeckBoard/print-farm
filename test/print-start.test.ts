// print_start's confirmation survives a failed / timed-out start: the print
// stays queued with its token, and a retry with the same token either starts
// it or notices the earlier attempt already did.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrinterStatus, emptyStatus } from "../src/drivers/types";

const store = new Map<string, unknown>();
const fake = { start: vi.fn(), status: vi.fn((): PrinterStatus => emptyStatus("idle")) };

vi.mock("../src/host", () => ({
  getSetting: () => null,
  storePut: (c: string, k: string, v: unknown) => void store.set(`${c}/${k}`, JSON.parse(JSON.stringify(v))),
  storeGet: (c: string, k: string) => store.get(`${c}/${k}`) ?? null,
  storeList: (c: string) => [...store.entries()].filter(([k]) => k.startsWith(c + "/")).map(([k, value]) => ({ key: k, value })),
  storeDelete: (c: string, k: string) => void store.delete(`${c}/${k}`),
  getAnswer: () => ({ status: "answered", answer: "Start print" }),
  execAny: () => ({ exit_code: 0, stdout: "", stderr: "" }),
}));
vi.mock("../src/drivers", () => ({ driverFor: () => fake }));

import { printStart } from "../src/tools";
import { PrintJob } from "../src/prints";

const PRINTER = { id: "p1", name: "MK4S", type: "prusalink", host: "10.0.0.5" };

function queued(): PrintJob {
  const job: PrintJob = { id: "r18", printer_id: "p1", file_id: "f1", remote_name: "part.bgcode", status: "awaiting_confirmation", requested_by: "agent", token: "pf-tok" };
  store.set("prints/r18", job);
  return job;
}

describe("print_start confirmation token", () => {
  beforeEach(() => {
    store.clear();
    store.set("printers/p1", PRINTER);
    fake.start.mockReset();
    fake.status.mockReset();
    fake.status.mockReturnValue(emptyStatus("idle"));
  });

  it("keeps the print queued with its token when the start times out, and a retry starts it", () => {
    queued();
    fake.start.mockImplementationOnce(() => {
      throw new Error("request to http://10.0.0.5/api/v1/files/usb/part.bgcode timed out");
    });
    expect(() => printStart({ print_id: "r18", confirmation_token: "pf-tok" })).toThrow(/timed out/);
    const after = store.get("prints/r18") as PrintJob;
    expect(after).toMatchObject({ status: "awaiting_confirmation", token: "pf-tok", start_error: expect.stringMatching(/timed out/) });

    const r = printStart({ print_id: "r18", confirmation_token: "pf-tok" }) as any;
    expect(r.print.status).toBe("started");
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect((store.get("prints/r18") as PrintJob).token).toBeUndefined();
  });

  it("doesn't start twice when the timed-out attempt went through", () => {
    queued();
    fake.start.mockImplementationOnce(() => {
      throw new Error("timed out");
    });
    expect(() => printStart({ print_id: "r18", confirmation_token: "pf-tok" })).toThrow();
    fake.status.mockReturnValue({ ...emptyStatus("printing"), file: "part.bgcode" });
    const r = printStart({ print_id: "r18", confirmation_token: "pf-tok" }) as any;
    expect(r.print.status).toBe("started");
    expect(fake.start).toHaveBeenCalledTimes(1);
  });
});
