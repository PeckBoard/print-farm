import { describe, it, expect } from "vitest";
import { parseSliceInfo, coerceAms, autoMatch, explicitMatch, mappingFor, describeMatches, spoolLabel, AmsState, Filament } from "../src/ams";

// The user's P1S: one AMS with four PLA trays, ASA on the external spool,
// as print-bridge >= 0.1.6 reports it.
const P1S: AmsState = coerceAms({
  trays: [
    { slot: 0, unit: 0, tray: 0, type: "PLA", color: "FF9016FF" },
    { slot: 1, unit: 0, tray: 1, type: "PLA", color: "F7E6DEFF" },
    { slot: 2, unit: 0, tray: 2, type: "PLA", color: "161616FF" },
    { slot: 3, unit: 0, tray: 3, type: "PLA", color: "E8DBB7FF" },
  ],
  external: { type: "ASA", color: "FFFFFFFF" },
})!;

const fil = (id: number, type: string, color = ""): Filament => ({ id, type, color });

describe("slice_info parsing", () => {
  it("reads filaments per plate", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="1234"/>
    <object identify_id="7" name="cube" skipped="false" />
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#161616" used_m="1.20" used_g="3.58" />
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <filament id="3" type="PETG" color="#00FF00" used_m="0.5" used_g="1.5" />
    <filament id="1" type="PLA" color="#ff9016" used_m="0.1" used_g="0.3" />
  </plate>
</config>`;
    const by = parseSliceInfo(xml);
    expect(by.get(1)).toEqual([{ id: 1, type: "PLA", color: "161616", used_g: 3.58 }]);
    expect(by.get(2)!.map((f) => [f.id, f.type, f.color])).toEqual([
      [1, "PLA", "FF9016"],
      [3, "PETG", "00FF00"],
    ]);
    expect(parseSliceInfo("").size).toBe(0);
  });
});

describe("auto-match", () => {
  it("puts a PLA print on the nearest-colour AMS PLA tray", () => {
    const [m] = autoMatch([fil(1, "PLA", "1A1A1A")], P1S);
    expect(m.spool).toBe("ams:2");
    expect(m.warning).toBeUndefined();
    expect(mappingFor([m])).toEqual({ use_ams: true, ams_mapping: [2] });
    // Type compare is case-insensitive; no colour → first tray.
    expect(autoMatch([fil(1, "pla")], P1S)[0].spool).toBe("ams:0");
  });

  it("puts an ASA print on the external spool (no AMS)", () => {
    const [m] = autoMatch([fil(1, "ASA", "FFFFFF")], P1S);
    expect(m.spool).toBe("external");
    expect(m.warning).toBeUndefined();
    expect(mappingFor([m])).toEqual({ use_ams: false });
  });

  it("falls back with a warning when nothing loaded matches", () => {
    const [m] = autoMatch([fil(1, "PETG", "FF9016")], P1S);
    expect(m.spool).toBe("ams:0");
    expect(m.warning).toMatch(/PETG.*PLA/);
    // Same family (PLA-CF vs PLA) beats an unrelated external type.
    const [cf] = autoMatch([fil(1, "PLA-CF", "161616")], P1S);
    expect(cf.spool).toBe("ams:2");
    expect(cf.warning).toBeTruthy();
    // Unknown type keeps the old behaviour: external spool, flagged.
    const [u] = autoMatch([fil(1, "")], P1S);
    expect(u.spool).toBe("external");
    expect(u.warning).toMatch(/unknown/);
  });

  it("maps multi-filament plates by filament id, -1 for unused ids", () => {
    const ms = autoMatch([fil(1, "PLA", "FF9016"), fil(3, "PLA", "E8DBB7")], P1S);
    expect(mappingFor(ms)).toEqual({ use_ams: true, ams_mapping: [0, -1, 3] });
    // Mixed AMS + external: the external spool is vt_tray 254.
    const mixed = autoMatch([fil(1, "PLA", "161616"), fil(2, "ASA")], P1S);
    expect(mappingFor(mixed)).toEqual({ use_ams: true, ams_mapping: [2, 254] });
  });
});

describe("override", () => {
  it("honours explicit choices and flags type mismatches", () => {
    const ms = explicitMatch([fil(1, "PLA", "161616")], P1S, ["external"]);
    expect(ms[0].spool).toBe("external");
    expect(ms[0].warning).toMatch(/PLA.*ASA/);
    expect(mappingFor(ms)).toEqual({ use_ams: false });
    const tray = explicitMatch([fil(1, "PLA")], P1S, ["ams:3"]);
    expect(mappingFor(tray)).toEqual({ use_ams: true, ams_mapping: [3] });
    expect(explicitMatch([fil(1, "PLA", "161616")], P1S, ["auto"])[0].spool).toBe("ams:2");
  });

  it("rejects unknown spools and wrong counts", () => {
    expect(() => explicitMatch([fil(1, "PLA")], P1S, ["ams:7"])).toThrow(/not a loaded spool/);
    expect(() => explicitMatch([fil(1, "PLA")], P1S, ["ams:0", "external"])).toThrow(/expected 1/);
  });

  it("describes the choice for the confirmation question", () => {
    expect(spoolLabel("ams:1", P1S)).toBe("AMS 1 · slot 2 (PLA #F7E6DE)");
    expect(spoolLabel("external", P1S)).toBe("External spool (ASA #FFFFFF)");
    const text = describeMatches(autoMatch([fil(1, "PETG")], P1S), P1S);
    expect(text).toMatch(/^filament 1 \(PETG\) → AMS 1 · slot 1 \(PLA #FF9016\) — WARNING: /);
  });
});

describe("bridge status coercion", () => {
  it("drops malformed trays and returns null without spools", () => {
    expect(coerceAms(null)).toBeNull();
    expect(coerceAms({ trays: [], external: null })).toBeNull();
    expect(coerceAms({ trays: [{ slot: 5, type: "PLA" }, { slot: "x" }, { slot: 1, type: "" }] })).toEqual({
      trays: [{ slot: 5, unit: 1, tray: 1, type: "PLA", color: null }],
      external: null,
      active: null,
    });
  });
});
