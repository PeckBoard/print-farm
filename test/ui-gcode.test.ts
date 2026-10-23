import { describe, it, expect } from "vitest";
import { parseGcode } from "../ui/gcode";

describe("G-code layer parser", () => {
  it("splits layers on extruding moves at a new Z, separating travel", () => {
    const g = [
      "G90",
      "M83",
      "G1 Z0.2 F600",
      "G0 X10 Y10", // travel before any extrusion — dropped with the pre-print layer
      "G1 X20 Y10 E1",
      "G1 X20 Y20 E1",
      "G1 Z0.6", // z-hop
      "G0 X0 Y0", // travel at hop height
      "G1 Z0.4",
      "G1 X10 Y0 E0.5 ; layer 2",
      "G1 E-0.8", // retraction only, not a move
      "G0 X30 Y30",
    ].join("\n");
    const p = parseGcode(g);
    expect(p.layers.length).toBe(2);
    expect(p.layers[0].z).toBeCloseTo(0.2);
    expect(p.layers[0].extrude.length).toBe(12); // 2 segments × 6
    expect(p.layers[0].travel.length).toBe(6); // the hop-height travel
    expect(p.layers[1].z).toBeCloseTo(0.4);
    expect(p.layers[1].extrude.length).toBe(6);
    expect(p.layers[1].travel.length).toBe(6);
    expect(p.bounds!.max[0]).toBe(20);
    expect(p.moves).toBe(3);
  });

  it("handles absolute E with G92 resets, relative positioning, and arcs", () => {
    const g = ["M82", "G92 E0", "G1 Z0.3", "G1 X0 Y0", "G1 X10 Y0 E1", "G92 E0", "G91", "G1 X0 Y10 E0.5", "G90", "G3 X-10 Y10 I-10 J0 E2"].join("\n");
    const p = parseGcode(g);
    expect(p.layers.length).toBe(1);
    // 2 straight segments + a flattened half-circle arc (>= 2 segments)
    expect(p.layers[0].extrude.length / 6).toBeGreaterThanOrEqual(4);
    const ys = p.layers[0].extrude.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(19); // CCW arc around (0,10) passes the top at y≈20
    const xs = p.layers[0].extrude.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeLessThan(0); // the arc bulges to x≈-10
  });

  it("returns no layers for G-code without extrusion", () => {
    const p = parseGcode("G28\nG0 X10 Y10\n; comment only\n");
    expect(p.layers).toEqual([]);
    expect(p.bounds).toBeNull();
  });
});
