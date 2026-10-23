// G-code → per-layer line segments for the layer viewer. Pure (no DOM, no
// three.js) — unit-tested in test/ui-gcode.test.ts.
//
// A new layer starts when an EXTRUDING move happens above the current layer's
// Z, so z-hops and travel moves between layers never create phantom layers.
// Supports G0/G1, G2/G3 arcs (I/J, flattened), G90/G91, M82/M83, G92, G20/G21.

export interface GcodeLayer {
  z: number;
  /// Flat [x1,y1,z1, x2,y2,z2, ...] pairs.
  extrude: number[];
  travel: number[];
}

export interface ParsedGcode {
  layers: GcodeLayer[];
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /// Extruding moves seen (for "nothing to show" detection).
  moves: number;
}

const EPS = 1e-4;

export function parseGcode(text: string): ParsedGcode {
  let x = 0,
    y = 0,
    z = 0,
    e = 0;
  let absPos = true;
  let absE = true;
  let scale = 1;
  const layers: GcodeLayer[] = [];
  let cur: GcodeLayer = { z: 0, extrude: [], travel: [] };
  let started = false;
  let moves = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const grow = (px: number, py: number, pz: number) => {
    if (px < min[0]) min[0] = px;
    if (py < min[1]) min[1] = py;
    if (pz < min[2]) min[2] = pz;
    if (px > max[0]) max[0] = px;
    if (py > max[1]) max[1] = py;
    if (pz > max[2]) max[2] = pz;
  };

  const seg = (arr: number[], x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
    arr.push(x1, y1, z1, x2, y2, z2);
  };

  let start = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = n;
    let line = text.slice(start, end);
    start = end + 1;
    const sc = line.indexOf(";");
    if (sc >= 0) line = line.slice(0, sc);
    line = line.trim();
    if (!line) continue;

    const words = line.toUpperCase().split(/\s+/);
    const cmd = words[0];
    const p: Record<string, number> = {};
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w.length < 2) continue;
      const v = Number(w.slice(1));
      if (isFinite(v)) p[w[0]] = v;
    }

    if (cmd === "G90") absPos = true;
    else if (cmd === "G91") absPos = false;
    else if (cmd === "M82") absE = true;
    else if (cmd === "M83") absE = false;
    else if (cmd === "G20") scale = 25.4;
    else if (cmd === "G21") scale = 1;
    else if (cmd === "G92") {
      if ("E" in p) e = p.E;
      if ("X" in p) x = p.X * scale;
      if ("Y" in p) y = p.Y * scale;
      if ("Z" in p) z = p.Z * scale;
    } else if (cmd === "G0" || cmd === "G1" || cmd === "G00" || cmd === "G01" || cmd === "G2" || cmd === "G3" || cmd === "G02" || cmd === "G03") {
      const nx = "X" in p ? (absPos ? p.X * scale : x + p.X * scale) : x;
      const ny = "Y" in p ? (absPos ? p.Y * scale : y + p.Y * scale) : y;
      const nz = "Z" in p ? (absPos ? p.Z * scale : z + p.Z * scale) : z;
      let extruding = false;
      if ("E" in p) {
        const de = absE ? p.E - e : p.E;
        e = absE ? p.E : e + p.E;
        extruding = de > 0;
      }
      const moved = nx !== x || ny !== y;
      if (moved) {
        if (extruding) {
          if (!started || nz > cur.z + EPS) {
            if (started && (cur.extrude.length || cur.travel.length)) layers.push(cur);
            cur = { z: nz, extrude: [], travel: [] };
            started = true;
          }
          moves++;
        }
        const target = extruding ? cur.extrude : cur.travel;
        const arc = cmd === "G2" || cmd === "G02" || cmd === "G3" || cmd === "G03";
        if (arc && ("I" in p || "J" in p)) {
          const cx = x + (p.I || 0) * scale;
          const cy = y + (p.J || 0) * scale;
          const r = Math.hypot(x - cx, y - cy);
          let a0 = Math.atan2(y - cy, x - cx);
          let a1 = Math.atan2(ny - cy, nx - cx);
          const cw = cmd === "G2" || cmd === "G02";
          if (cw && a1 >= a0) a1 -= Math.PI * 2;
          if (!cw && a1 <= a0) a1 += Math.PI * 2;
          const steps = Math.max(2, Math.min(64, Math.ceil(Math.abs(a1 - a0) / 0.2)));
          let px = x,
            py = y,
            pz = z;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const a = a0 + (a1 - a0) * t;
            const qx = i === steps ? nx : cx + r * Math.cos(a);
            const qy = i === steps ? ny : cy + r * Math.sin(a);
            const qz = z + (nz - z) * t;
            seg(target, px, py, pz, qx, qy, qz);
            if (extruding) grow(qx, qy, qz);
            px = qx;
            py = qy;
            pz = qz;
          }
        } else {
          seg(target, x, y, z, nx, ny, nz);
        }
        if (extruding) {
          grow(x, y, z);
          grow(nx, ny, nz);
        }
      }
      x = nx;
      y = ny;
      z = nz;
    }
  }
  if (started && (cur.extrude.length || cur.travel.length)) layers.push(cur);
  return {
    layers,
    bounds: moves ? { min, max } : null,
    moves,
  };
}
