// Driver factory: printer record → PrinterDriver.

import { Transport } from "../transport";
import { PrinterDriver, PrinterRecord } from "./types";
import { moonrakerDriver } from "./moonraker";
import { octoprintDriver } from "./octoprint";
import { prusalinkDriver } from "./prusalink";
import { bambuDriver, BridgeConfig } from "./bambu";

export function driverFor(p: PrinterRecord, t: Transport, bridge: BridgeConfig): PrinterDriver {
  switch (p.type) {
    case "moonraker":
      return moonrakerDriver(p, t);
    case "octoprint":
      return octoprintDriver(p, t);
    case "prusalink":
      return prusalinkDriver(p, t);
    case "bambu":
      return bambuDriver(p, t, bridge);
    default:
      throw new Error(`unknown printer type '${(p as any).type}'`);
  }
}
