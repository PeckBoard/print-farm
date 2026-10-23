import { describe, it, expect } from "vitest";
import { buildPrinter, redact } from "../src/printers";
import { checkCompatible, confirmationVerdict, CONFIRM_LABEL, publicJob } from "../src/prints";
import { baseUrl } from "../src/drivers/types";

const idf = () => "p1";

describe("printer registry", () => {
  it("creates a printer and never exposes secrets", () => {
    const p = buildPrinter({ type: "octoprint", host: "octopi.local", api_key: "SECRET" }, null, idf);
    expect(p).toMatchObject({ id: "p1", name: "octopi.local", api_key: "SECRET" });
    const r = redact(p);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(r.has_api_key).toBe(true);
  });

  it("keeps secrets on update when omitted or blank, clears on null", () => {
    const p = buildPrinter({ type: "prusalink", host: "h", password: "pw", username: "maker" }, null, idf);
    expect(buildPrinter({ name: "MK4" }, p, idf)).toMatchObject({ name: "MK4", password: "pw" });
    expect(buildPrinter({ password: "" }, p, idf).password).toBe("pw");
    expect(buildPrinter({ password: null }, p, idf).password).toBeUndefined();
  });

  it("requires serial + access code for Bambu and redacts the code", () => {
    expect(() => buildPrinter({ type: "bambu", host: "1.2.3.4" }, null, idf)).toThrow(/serial/);
    const p = buildPrinter({ type: "bambu", host: "1.2.3.4", bambu: { serial: "S1", access_code: "AC123" } }, null, idf);
    const r = redact(p);
    expect(r.bambu).toEqual({ serial: "S1", has_access_code: true });
    expect(JSON.stringify(r)).not.toContain("AC123");
    // Update without the code keeps it.
    expect(buildPrinter({ bambu: { serial: "S1" } }, p, idf).bambu?.access_code).toBe("AC123");
  });

  it("validates type, host, and port", () => {
    expect(() => buildPrinter({ type: "resin", host: "h" }, null, idf)).toThrow(/type/);
    expect(() => buildPrinter({ type: "moonraker" }, null, idf)).toThrow(/host/);
    expect(() => buildPrinter({ type: "moonraker", host: "h", port: 70000 }, null, idf)).toThrow(/port/);
  });

  it("builds base urls", () => {
    expect(baseUrl({ id: "x", name: "x", type: "moonraker", host: "voron" }, 7125)).toBe("http://voron:7125");
    expect(baseUrl({ id: "x", name: "x", type: "octoprint", host: "https://octo.lan/" }, 80)).toBe("https://octo.lan");
    expect(baseUrl({ id: "x", name: "x", type: "octoprint", host: "octo:5000" }, 80)).toBe("http://octo:5000");
    expect(baseUrl({ id: "x", name: "x", type: "moonraker", host: "voron", port: 80 }, 7125)).toBe("http://voron");
  });
});

describe("print safety", () => {
  it("only starts on an explicit, non-rejected 'Start print' answer", () => {
    expect(confirmationVerdict({ status: "answered", answer: CONFIRM_LABEL })).toBe("start");
    expect(confirmationVerdict({ status: "answered", answer: CONFIRM_LABEL, rejected: true })).toBe("declined");
    expect(confirmationVerdict({ status: "answered", answer: "yes" })).toBe("declined");
    expect(confirmationVerdict({ status: "pending" })).toBe("pending");
    expect(confirmationVerdict({ status: "unknown" })).toBe("unknown");
  });

  it("checks file kinds per printer type", () => {
    expect(() => checkCompatible("bambu", "gcode")).toThrow(/gcode\.3mf/);
    expect(() => checkCompatible("prusalink", "bgcode")).not.toThrow();
    expect(() => checkCompatible("moonraker", "model")).toThrow();
  });

  it("never leaks the confirmation token", () => {
    const j = publicJob({ id: "r1", printer_id: "p", file_id: "f", remote_name: "a", status: "awaiting_confirmation", requested_by: "agent", token: "pf-x" });
    expect("token" in j).toBe(false);
  });
});
