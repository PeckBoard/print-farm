import { describe, it, expect } from "vitest";
import { manifestJson } from "../src/manifest";
import { matchRoute } from "../src/http";
import { TOOLS } from "../src/tools";
import pkg from "../package.json";

describe("manifest", () => {
  const m = JSON.parse(manifestJson());

  it("self-reports the package.json version", () => {
    expect(m.version).toBe(pkg.version);
  });

  it("declares the UI API routes and the MCP tools", () => {
    expect(m.ui_routes).toContain("GET /api/plugin-ui/print-farm/printers");
    expect(m.ui_routes).toContain("POST /api/plugin-ui/print-farm/printers/:id/control");
    expect(m.ui_routes).toContain("POST /api/plugin-ui/print-farm/prints/:id/dismiss");
    expect(m.ui_routes).toContain("GET /api/plugin-ui/print-farm/slice/:job");
    for (const r of [
      "GET printers/:id/capabilities",
      "GET printers/:id/detail",
      "GET printers/:id/files",
      "DELETE printers/:id/files",
      "POST printers/:id/files/print",
      "POST printers/:id/capture",
      "GET captures",
      "GET captures/:id",
      "DELETE captures/:id",
    ]) {
      const [method, path] = r.split(" ");
      expect(m.ui_routes).toContain(`${method} /api/plugin-ui/print-farm/${path}`);
    }
    // Every handler is declared, and nothing declared lacks a handler.
    expect(m.mcp_tools.map((t: any) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(Object.keys(TOOLS)).toEqual(
      expect.arrayContaining(["print_start", "printer_move", "printer_gcode", "printer_file_delete", "file_delete", "camera_capture", "capture_list", "capture_view"]),
    );
    expect(m.permissions).toEqual(expect.arrayContaining(["http_request", "process_exec_any", "ask_user", "data_store"]));
  });

  it("matches routes with params", () => {
    expect(matchRoute("GET printers/:id/status", "GET", "printers/p1/status")).toEqual({ id: "p1" });
    expect(matchRoute("GET printers/:id/status", "POST", "printers/p1/status")).toBeNull();
    expect(matchRoute("GET slice", "GET", "slice/j1")).toBeNull();
  });
});
