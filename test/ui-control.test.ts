import { describe, it, expect } from "vitest";
import { clampTemp, busyReason, extrudeReason, needsDevBanner, cssColor, loadChoices, newestFirst, toDate } from "../ui/control";

describe("printer control rules", () => {
  it("clamps temperature targets to the capability max", () => {
    expect(clampTemp(260, 250)).toBe(250);
    expect(clampTemp(219.6, 300)).toBe(220);
    expect(clampTemp(-5, 300)).toBe(0);
    expect(clampTemp(NaN, 300)).toBe(0);
  });

  it("locks motion while printing/paused and extrude below 170 °C", () => {
    expect(busyReason("printing", "Motion")).toMatch(/running/);
    expect(busyReason("paused", "Motion")).toMatch(/paused/);
    expect(busyReason("idle", "Motion")).toBeNull();
    expect(extrudeReason({ state: "idle", temps: { nozzle: { actual: 120, target: 0 } } })).toMatch(/170 °C.*now 120/);
    expect(extrudeReason({ state: "idle", temps: { nozzle: { actual: 215, target: 215 } } })).toBeNull();
  });

  it("shows the developer-mode banner when off or refused", () => {
    expect(needsDevBanner(false, false)).toBe(true);
    expect(needsDevBanner(null, true)).toBe(true);
    expect(needsDevBanner(null, false)).toBe(false);
    expect(needsDevBanner(true, false)).toBe(false);
  });

  it("builds load choices from the AMS shape and normalises colours", () => {
    const ch = loadChoices({ trays: [{ slot: 0, unit: 0, tray: 0, type: "PLA", color: "FF9016FF" }], external: { type: "ASA", color: "000000" } });
    expect(ch).toEqual([
      { value: "0", label: "AMS 1 · Slot 1 — PLA" },
      { value: "external", label: "External spool — ASA" },
    ]);
    expect(cssColor("FF9016FF")).toBe("#FF9016");
    expect(cssColor(null)).toBeNull();
  });

  it("sorts captures newest first across epoch s/ms/ISO", () => {
    const xs = [{ taken_at: 1_700_000_000 }, { taken_at: "2024-01-01T00:00:00Z" }, { taken_at: 1_600_000_000_000 }];
    expect(newestFirst(xs).map((x) => toDate(x.taken_at)!.getUTCFullYear())).toEqual([2024, 2023, 2020]);
  });
});
