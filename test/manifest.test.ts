import { describe, it, expect } from "vitest";
import { manifestJson } from "../src/manifest";
import { matchRoute } from "../src/http";
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
    expect(m.mcp_tools.map((t: any) => t.name)).toEqual([
      "printer_list",
      "printer_status",
      "profile_list",
      "slice_model",
      "slice_status",
      "print_upload",
      "print_start",
      "print_control",
      "print_snapshot",
    ]);
    expect(m.permissions).toEqual(expect.arrayContaining(["http_request", "process_exec_any", "ask_user", "data_store"]));
  });

  it("matches routes with params", () => {
    expect(matchRoute("GET printers/:id/status", "GET", "printers/p1/status")).toEqual({ id: "p1" });
    expect(matchRoute("GET printers/:id/status", "POST", "printers/p1/status")).toBeNull();
    expect(matchRoute("GET slice", "GET", "slice/j1")).toBeNull();
  });
});
