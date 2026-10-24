// Printer controls beyond start/pause/stop: validation against the driver's
// capabilities, the "never move the toolhead mid-print" guard, and dispatch.
// The parse/guard halves are pure — tested.

import {
  Capabilities,
  ControlAction,
  ControlResult,
  DriverError,
  PrinterDriver,
  PrinterStatus,
  FanName,
  RemoteFile,
  unsupported,
} from "./drivers/types";

export const MAX_MOVE_MM = 100;
export const MIN_EXTRUDE_C = 170;
export const MAX_GCODE_LEN = 256;

/// Actions that move the toolhead or feed filament.
export const MOTION_ACTIONS = new Set(["home", "jog", "motors_off", "extrude", "load", "unload", "gcode"]);

/// Bambu speed profiles as a percentage (silent / standard / sport / ludicrous).
export const SPEED_LEVEL_PERCENT: Record<number, number> = { 1: 50, 2: 100, 3: 124, 4: 166 };

function bad(msg: string): DriverError {
  return new DriverError(400, msg);
}

function finite(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !isFinite(n)) throw bad(`${what} must be a number`);
  return n;
}

/// Validate a control body against what the printer supports. Pure.
export function parseControl(body: any, caps: Capabilities): ControlAction {
  const action: string = typeof body?.action === "string" ? body.action.trim() : "";
  switch (action) {
    case "pause":
    case "resume":
      if (!caps.job[action]) throw unsupported(action);
      return { action };
    case "stop":
    case "cancel":
      if (!caps.job.stop) throw unsupported("stop");
      return { action: "stop" };
    case "speed": {
      if (body.level !== undefined && body.level !== null) {
        const level = finite(body.level, "level");
        if (!Number.isInteger(level) || level < 1 || level > 4) throw bad("level must be 1-4");
        if (caps.job.speed_levels) return { action, level };
        if (caps.job.speed_percent) return { action, percent: SPEED_LEVEL_PERCENT[level] };
        throw unsupported("speed");
      }
      const percent = finite(body.percent, "percent");
      if (percent < 10 || percent > 300) throw bad("percent must be 10-300");
      if (!caps.job.speed_percent) throw unsupported("speed percent");
      return { action, percent: Math.round(percent) };
    }
    case "temp": {
      const heater = body.heater;
      if (heater !== "nozzle" && heater !== "bed" && heater !== "chamber") throw bad("heater must be nozzle, bed or chamber");
      const cap = caps.temps[heater as "nozzle" | "bed" | "chamber"];
      if (!cap) {
        if (caps.temps_unsupported_reason) throw new DriverError(400, `setting the ${heater} temperature is not supported on this printer: ${caps.temps_unsupported_reason}`);
        throw unsupported(`setting the ${heater} temperature`);
      }
      const target = finite(body.target, "target");
      if (target < 0 || target > cap.max) throw bad(`${heater} target must be 0-${cap.max} °C`);
      return { action, heater, target: Math.round(target) };
    }
    case "fan": {
      const fan = body.fan as FanName;
      if (!caps.fans.includes(fan)) throw unsupported(`the ${String(body.fan)} fan`);
      const percent = finite(body.percent, "percent");
      if (percent < 0 || percent > 100) throw bad("percent must be 0-100");
      return { action, fan, percent: Math.round(percent) };
    }
    case "light":
      if (!caps.light) throw unsupported("the light");
      if (typeof body.on !== "boolean") throw bad("on must be true or false");
      return { action, on: body.on };
    case "home":
    case "motors_off":
      if (!caps.motion) throw unsupported(action);
      return { action };
    case "jog": {
      if (!caps.motion) throw unsupported("jog");
      const axis = typeof body.axis === "string" ? body.axis.toLowerCase() : "";
      if (axis !== "x" && axis !== "y" && axis !== "z") throw bad("axis must be x, y or z");
      const distance = finite(body.distance, "distance");
      if (distance === 0 || Math.abs(distance) > MAX_MOVE_MM) throw bad(`distance must be non-zero and at most ${MAX_MOVE_MM} mm`);
      return { action, axis, distance };
    }
    case "extrude": {
      if (!caps.extrude) throw unsupported("extrude");
      const mm = finite(body.mm, "mm");
      if (mm === 0 || Math.abs(mm) > MAX_MOVE_MM) throw bad(`mm must be non-zero and at most ${MAX_MOVE_MM}`);
      return { action, mm };
    }
    case "load": {
      if (!caps.load_unload) throw unsupported("load");
      if (body.slot === "external") return { action, slot: "external" };
      const slot = finite(body.slot, "slot");
      if (!Number.isInteger(slot) || slot < 0 || slot > 15) throw bad('slot must be an AMS tray 0-15 or "external"');
      return { action, slot };
    }
    case "unload":
      if (!caps.load_unload) throw unsupported("unload");
      return { action };
    case "gcode": {
      if (!caps.gcode) throw unsupported("G-code");
      const line = typeof body.line === "string" ? body.line.trim() : "";
      if (!line || line.length > MAX_GCODE_LEN || /[\r\n\0]/.test(line)) {
        throw bad(`line must be one non-empty G-code line of at most ${MAX_GCODE_LEN} characters`);
      }
      return { action, line };
    }
    default:
      throw bad("action must be one of pause, resume, stop, speed, temp, fan, light, home, jog, motors_off, extrude, load, unload, gcode");
  }
}

/// Refuse motion mid-print and extrusion with a cold nozzle (409). Pure.
export function guardControl(a: ControlAction, st: PrinterStatus): void {
  if (!MOTION_ACTIONS.has(a.action)) return;
  if (st.state === "printing" || st.state === "paused") {
    throw new DriverError(409, `${a.action} is not allowed while the printer is ${st.state}`);
  }
  if (a.action === "extrude" && !((st.temps.nozzle?.actual ?? 0) >= MIN_EXTRUDE_C)) {
    throw new DriverError(409, `the nozzle must be at least ${MIN_EXTRUDE_C} °C to extrude (heat it first)`);
  }
}

/// Validate, guard, and run one control request.
export function runControl(d: PrinterDriver, body: any): ControlResult {
  const a = parseControl(body, d.capabilities());
  if (MOTION_ACTIONS.has(a.action)) guardControl(a, d.status());
  return d.control(a);
}

/// One-line description of an action, for confirmation questions. Pure.
export function describeAction(a: ControlAction): string {
  switch (a.action) {
    case "home":
      return "home all axes";
    case "jog":
      return `move the ${a.axis.toUpperCase()} axis ${a.distance > 0 ? "+" : ""}${a.distance} mm`;
    case "motors_off":
      return "turn the stepper motors off";
    case "extrude":
      return a.mm > 0 ? `extrude ${a.mm} mm of filament` : `retract ${-a.mm} mm of filament`;
    case "load":
      return a.slot === "external" ? "load filament from the external spool" : `load filament from AMS slot ${a.slot}`;
    case "unload":
      return "unload the filament";
    case "gcode":
      return `run the G-code \`${a.line}\``;
    default:
      return a.action;
  }
}

/// A printer storage path from a files listing: relative, no `..`, no
/// control characters. Pure.
export function validRemoteName(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith("/") || /[\\\0\r\n]/.test(name)) return false;
  return !name.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/// The printer's own files, when its driver can list them.
export function remoteFiles(d: PrinterDriver): RemoteFile[] {
  if (!d.capabilities().files) throw unsupported("listing printer storage");
  return d.files();
}
