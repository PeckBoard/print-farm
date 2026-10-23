// The plugin manifest JSON body — identity, hooks, permissions, the MCP tools,
// the page + authenticated data routes, the sidebar entry, and settings.

import { version as VERSION } from "../package.json";
import { uiRoutes, PAGE_PATH } from "./http";
import { DEFAULT_BRIDGE_URL, DEFAULT_ORCA_PATH } from "./config";

const DESCRIPTION =
  "Print Farm: control a fleet of 3D printers — Klipper/Moonraker, OctoPrint, PrusaLink, and Bambu Lab " +
  "(through the local print-bridge sidecar) — with live status, camera snapshots, pause/cancel, and " +
  "uploads; slice STL/3MF/STEP models with the OrcaSlicer CLI using Orca's own printer/filament/process " +
  "profiles. Agents can list printers, slice, and upload, but a print only STARTS after a human " +
  "confirms it (an in-chat question or the Start button on the Print Farm page). Runs curl and " +
  "orca-slicer on the Peckboard host via process_exec_any and keeps files under " +
  "~/.local/share/peckboard-print-farm.";

const REPOSITORY = "https://github.com/PeckBoard/print-farm";

// Inline SVG (lucide "printer") for the sidebar entry; rendered sandboxed.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="6 9 6 2 18 2 18 9"/>' +
  '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>' +
  '<rect x="6" y="14" width="12" height="8"/></svg>';

const PRINTER_REF = "Printer id or name (see printer_list).";

const MCP_TOOLS = [
  {
    name: "printer_list",
    description: "List the registered 3D printers (id, name, type, host, default Orca profiles). Credentials are never returned.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "printer_status",
    description:
      "Live status of one printer, or of every printer when `printer` is omitted: state " +
      "(idle/printing/paused/finished/error/offline), progress 0..1, file, elapsed/eta seconds, layer, temperatures.",
    input_schema: {
      type: "object",
      properties: { printer: { type: "string", description: PRINTER_REF } },
      additionalProperties: false,
    },
  },
  {
    name: "profile_list",
    description:
      "Browse OrcaSlicer profiles. Without kind+vendor: the vendor list (plus 'User' for the user's own " +
      "presets). With kind (printer|filament|process) and vendor: the selectable preset names, optionally " +
      "filtered by a substring `query`.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["printer", "filament", "process"] },
        vendor: { type: "string", description: "Vendor name from the vendor list (e.g. BBL, Prusa, Creality, User)." },
        query: { type: "string", description: "Case-insensitive substring filter on preset names." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "slice_model",
    description:
      "Slice a 3D model (STL/3MF/STEP/OBJ) with OrcaSlicer into G-code (or .gcode.3mf for Bambu printers). " +
      "Give the model as `path` (relative to the project folder) or `file_id` (an uploaded file). Profiles " +
      "are Orca preset names (see profile_list); omitted ones fall back to the defaults saved on `printer`. " +
      "Runs in the background — returns a job_id; poll slice_status. The result is a file_id usable with " +
      "print_upload / print_start, with estimated print time and filament use.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Model path relative to the project folder." },
        file_id: { type: "string", description: "Id of an already uploaded model file." },
        printer: { type: "string", description: PRINTER_REF + " Supplies default profiles and the output format." },
        printer_profile: { type: "string", description: "Orca printer (machine) preset name." },
        filament_profile: { type: "string", description: "Orca filament preset name." },
        process_profile: { type: "string", description: "Orca process preset name." },
        vendor: { type: "string", description: "Vendor to look the presets up under first (e.g. BBL)." },
        arrange: { type: "boolean", description: "Auto-arrange on the plate (default true)." },
        orient: { type: "boolean", description: "Auto-orient the model (default false)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "slice_status",
    description:
      "Poll a slice job from slice_model: status running/succeeded/failed, the result file_id and the " +
      "estimate (print_time_s, filament_g, filament_mm, layers) when done, or the error and log tail.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "print_upload",
    description:
      "Upload a stored file (sliced G-code / .gcode.3mf, by file_id) to a printer WITHOUT starting it. " +
      "Returns a print record.",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        file_id: { type: "string" },
      },
      required: ["printer", "file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "print_start",
    description:
      "Request a print. Starting a print MOVES PHYSICAL HARDWARE, so it always needs explicit human " +
      "confirmation: the first call (printer + file_id) uploads the file, queues the print as " +
      "awaiting_confirmation and asks the user in this chat. Once the user has answered, call print_start " +
      "again with print_id and confirmation_token — it starts only if the user chose 'Start print'. If the " +
      "user can't be asked here, the print stays queued until they press Start on the Print Farm page.",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        file_id: { type: "string" },
        options: {
          type: "object",
          description:
            "Bambu only: {plate?: number, use_ams?: boolean, bed_leveling?: boolean}. When the printer reports " +
            "its AMS/external spool, use_ams follows the spool choice (see spools).",
          properties: {
            plate: { type: "integer" },
            use_ams: { type: "boolean" },
            bed_leveling: { type: "boolean" },
          },
          additionalProperties: false,
        },
        spools: {
          type: "array",
          items: { type: "string" },
          description:
            "Bambu only, optional: the spool for each filament the plate uses, in filament order — " +
            "\"ams:<slot>\" (global AMS tray, unit*4+tray, slot 0 = AMS 1 tray 1), \"external\" (external spool) " +
            "or \"auto\". Omit to auto-match by filament type and colour (printer_status shows the loaded spools). " +
            "The confirmation question tells the user which spools will be used.",
        },
        print_id: { type: "string", description: "Second call: the queued print's id." },
        confirmation_token: { type: "string", description: "Second call: the token from the first call." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "print_control",
    description:
      "Pause or cancel the current print on a printer. (Resume moves the printer, so it is UI-only.)",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        action: { type: "string", enum: ["pause", "cancel"] },
      },
      required: ["printer", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "print_snapshot",
    description:
      "Grab a camera frame from a printer. Saves it as a file (file_id) and returns its size; set " +
      "include_data to also get the image as base64. camera:false when the printer has no camera.",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        include_data: { type: "boolean" },
      },
      required: ["printer"],
      additionalProperties: false,
    },
  },
];

export function manifestJson(): string {
  return JSON.stringify({
    description: DESCRIPTION,
    version: VERSION,
    repository: REPOSITORY,
    // Status-all fans out to every printer, uploads stream up to 600s, and a
    // profile scan walks thousands of JSON files: stay well past the extism
    // default but under core's MAX_CALL_TIMEOUT (610s).
    call_timeout_secs: 600,
    // A camera grab or printer upload over a weak link takes 15–600 s; with
    // one instance every page call (file list, status) queued behind it.
    // Ids and install launches are claimed atomically (counter.ts, setup.ts).
    concurrency: 4,
    hooks: ["mcp.tool.invoke", "http.request.before", "http.request.authed"],
    permissions: [
      "provide_mcp_tools", // printer_* / slice_* / print_* tools
      "data_store", // printer registry, file + job metadata, profile index cache
      "http_request", // printer + print-bridge HTTP APIs on the LAN / loopback
      "process_exec_any", // curl (binary/multipart/self-signed), orca-slicer, file I/O in the storage dir
      "ask_user", // human confirmation before an agent-requested print starts
      "user_authority", // serve the authenticated page API
      "contribute_sidebar", // the Print Farm sidebar page
    ],
    sidebar_items: [{ id: "print-farm", label: "Print Farm", icon: ICON, path: PAGE_PATH }],
    http_routes: [`GET ${PAGE_PATH}`],
    ui_routes: uiRoutes(),
    settings: [
      {
        key: "bridge_url",
        title: "print-bridge URL",
        type: "url",
        default: DEFAULT_BRIDGE_URL,
        description: "Base URL of the local print-bridge sidecar that talks to Bambu Lab printers.",
      },
      {
        key: "bridge_token",
        title: "print-bridge token",
        type: "string",
        secret: true,
        description: "Bearer token the print-bridge sidecar expects. Leave empty to use ~/.config/print-bridge/token (written by the automatic print-bridge install).",
      },
      {
        key: "orca_path",
        title: "OrcaSlicer executable",
        type: "string",
        default: DEFAULT_ORCA_PATH,
        description: "Command name on PATH (orca-slicer) or an absolute path to the binary / AppImage.",
      },
      {
        key: "orca_profiles_dir",
        title: "OrcaSlicer profile directories",
        type: "string",
        placeholder: "auto-detect",
        description:
          "Colon-separated vendor profile roots (dirs holding <Vendor>/machine, filament, process). Empty = " +
          "auto-detect the bundled resources/profiles, ~/.config/OrcaSlicer/system and user presets.",
      },
      {
        key: "orca_headless",
        title: "Run OrcaSlicer under xvfb-run",
        type: "enum",
        default: "auto",
        options: [
          { value: "auto", label: "When no display is available" },
          { value: "always", label: "Always" },
          { value: "never", label: "Never" },
        ],
      },
      {
        key: "storage_dir",
        title: "Storage directory",
        type: "string",
        placeholder: "~/.local/share/peckboard-print-farm",
        description:
          "Where uploaded models and sliced files live. Must be writable inside Peckboard's agent sandbox " +
          "(e.g. under ~/.local, ~/.cache, or a granted path). Empty = the default.",
      },
    ],
    mcp_tools: MCP_TOOLS,
  });
}
