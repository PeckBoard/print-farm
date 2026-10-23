// Parse the estimates OrcaSlicer (and PrusaSlicer/SuperSlicer/Cura) write as
// G-code comments in the header block and the footer. Pure — tested.

export interface GcodeEstimate {
  print_time_s: number | null;
  filament_mm: number | null;
  filament_g: number | null;
  filament_cm3: number | null;
  filament_cost: number | null;
  layers: number | null;
}

/// "1d 2h 3m 4s" / "2h 05m" / "45m 12s" / "37s" → seconds.
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  let total = 0;
  let any = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    any = true;
    const v = Number(m[1]);
    const unit = m[2].toLowerCase();
    total += unit === "d" ? v * 86400 : unit === "h" ? v * 3600 : unit === "m" ? v * 60 : v;
  }
  return any ? Math.round(total) : null;
}

/// Sum a possibly per-extruder, comma-separated list ("12.3, 4.5").
function sumList(s: string): number | null {
  const parts = s
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => isFinite(n));
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

export function parseGcodeEstimate(text: string): GcodeEstimate {
  const est: GcodeEstimate = {
    print_time_s: null,
    filament_mm: null,
    filament_g: null,
    filament_cm3: null,
    filament_cost: null,
    layers: null,
  };
  let totalTime: number | null = null;
  let normalTime: number | null = null;
  let cura: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(";")) continue;
    const body = line.replace(/^;+\s*/, "");
    let m: RegExpExecArray | null;
    // Orca/Bambu header: "model printing time: 41m 25s; total estimated time: 47m 34s"
    if ((m = /total estimated time:\s*([^;]+)/i.exec(body))) totalTime = parseDuration(m[1]) ?? totalTime;
    // Orca/Prusa footer: "estimated printing time (normal mode) = 1h 2m 3s"
    else if ((m = /^estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/i.exec(body))) normalTime = parseDuration(m[1]) ?? normalTime;
    else if ((m = /^TIME:\s*(\d+)/.exec(body))) cura = Number(m[1]);
    else if ((m = /^(?:total )?filament used \[mm\]\s*=\s*(.+)$/i.exec(body))) est.filament_mm = est.filament_mm ?? sumList(m[1]);
    else if ((m = /^total filament used \[g\]\s*=\s*(.+)$/i.exec(body))) est.filament_g = sumList(m[1]);
    else if ((m = /^filament used \[g\]\s*=\s*(.+)$/i.exec(body))) est.filament_g = est.filament_g ?? sumList(m[1]);
    else if ((m = /^filament used \[cm3\]\s*=\s*(.+)$/i.exec(body))) est.filament_cm3 = sumList(m[1]);
    else if ((m = /^(?:total )?filament cost\s*=\s*(.+)$/i.exec(body))) est.filament_cost = sumList(m[1]);
    else if ((m = /^Filament used:\s*([\d.]+)\s*m\b/i.exec(body))) est.filament_mm = est.filament_mm ?? Math.round(Number(m[1]) * 1000 * 100) / 100;
    else if ((m = /^total layers? (?:count|number)\s*[:=]\s*(\d+)/i.exec(body))) est.layers = Number(m[1]);
    else if ((m = /^LAYER_COUNT:\s*(\d+)/.exec(body))) est.layers = est.layers ?? Number(m[1]);
  }
  est.print_time_s = totalTime ?? normalTime ?? cura;
  return est;
}
