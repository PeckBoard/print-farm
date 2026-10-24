// The plugin manifest JSON body — identity, hooks, permissions, the MCP tools,
// the page + authenticated data routes, the sidebar entry, and settings.

import { version as VERSION } from "../package.json";
import { uiRoutes, PAGE_PATH } from "./http";
import { DEFAULT_BRIDGE_URL, DEFAULT_ORCA_PATH } from "./config";
import { PLATE_TYPES } from "./farmsettings";

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
const KIND_PROP = { type: "string", enum: ["printer", "filament", "process"], description: "printer = Orca machine preset." };
function printerOnly() {
  return {
    type: "object",
    properties: { printer: { type: "string", description: PRINTER_REF } },
    required: ["printer"],
    additionalProperties: false,
  };
}

/// A human-confirmed printer action: `props` on the first call, the pending
/// action's id + token on the second.
function confirmSchema(props: Record<string, unknown>) {
  return {
    type: "object",
    properties: {
      printer: { type: "string", description: PRINTER_REF },
      ...props,
      action_id: { type: "string", description: "Second call: the pending action's id." },
      confirmation_token: { type: "string", description: "Second call: the token from the first call." },
    },
    additionalProperties: false,
  };
}

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
    name: "profile_get",
    description:
      "One OrcaSlicer preset: its own settings (`own`, Orca's on-disk shapes), every setting after its inherits " +
      "chain (`resolved`), vendor, whether it is a User preset, and the file path.",
    input_schema: {
      type: "object",
      properties: { kind: KIND_PROP, name: { type: "string", description: "Preset name (see profile_list)." } },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "profile_save",
    description:
      "Create or update an OrcaSlicer User preset (system presets are read-only — save under a new name to " +
      "duplicate one). New: name + inherits (the preset to start from) + own (the settings that differ, e.g. " +
      "{\"textured_plate_temp\": \"60\", \"textured_plate_temp_initial_layer\": \"60\"}). Existing User preset: own " +
      "REPLACES its stored overrides; new_name renames it. Written where the Orca GUI keeps user presets, so " +
      "it shows up there too.",
    input_schema: {
      type: "object",
      properties: {
        kind: KIND_PROP,
        name: { type: "string" },
        inherits: { type: "string", description: "Parent preset name (a system preset, or a User preset to copy)." },
        own: { type: "object", description: "Orca setting name → value (string, number, boolean or list)." },
        new_name: { type: "string", description: "Rename an existing User preset." },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "profile_delete",
    description: "Delete an OrcaSlicer User preset (system presets can't be deleted).",
    input_schema: {
      type: "object",
      properties: { kind: KIND_PROP, name: { type: "string" } },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "farm_settings_get",
    description:
      "Farm-wide defaults: plate_type (bed type every slice uses unless the printer or call overrides it), " +
      "material, quality, brim, auto_arrange/auto_orient, bed_temp_override, confirm_before_start, and monitoring " +
      "(snapshot interval, ignored HMS codes, auto-pause flag).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "farm_settings_set",
    description: "Change farm-wide defaults (partial; same shape as farm_settings_get). Returns the new settings.",
    input_schema: {
      type: "object",
      properties: { settings: { type: "object", description: "Partial farm settings, e.g. {\"plate_type\": \"Textured PEI Plate\"}." } },
      required: ["settings"],
      additionalProperties: false,
    },
  },
  {
    name: "printer_settings_set",
    description:
      "Per-printer slicing settings (partial): plate_type, printer_preset, process_preset, filament_preset, " +
      "nozzle_mm (0.2/0.4/0.6/0.8). null clears a value (falls back to the farm setting / auto-detected preset). " +
      "Returns the settings with the effective values.",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        settings: { type: "object" },
      },
      required: ["printer", "settings"],
      additionalProperties: false,
    },
  },
  {
    name: "slice_model",
    description:
      "Slice a 3D model (STL/3MF/STEP/OBJ) with OrcaSlicer into G-code (or .gcode.3mf for Bambu printers). " +
      "Give the model as `path` (relative to the project folder) or `file_id` (an uploaded file). Profiles " +
      "are Orca preset names (see profile_list); omitted ones fall back to the defaults saved on `printer`. " +
      "Every other value resolves call argument → printer settings → farm settings → preset: the plate type " +
      "(always passed to Orca, so the filament's bed temperature for that plate applies), brim, bed temperature " +
      "overrides, arrange/orient. Runs in the background — returns a job_id; poll slice_status. The result is " +
      "a file_id usable with print_upload / print_start, with estimated print time and filament use.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Model path relative to the project folder." },
        file_id: { type: "string", description: "Id of an already uploaded model file." },
        printer: { type: "string", description: PRINTER_REF + " Supplies default profiles, plate type and the output format." },
        printer_profile: { type: "string", description: "Orca printer (machine) preset name." },
        filament_profile: { type: "string", description: "Orca filament preset name." },
        process_profile: { type: "string", description: "Orca process preset name." },
        vendor: { type: "string", description: "Vendor to look the presets up under first (e.g. BBL)." },
        bed_type: { type: "string", enum: [...PLATE_TYPES], description: "Build plate (Orca curr_bed_type)." },
        brim_width: { type: "number", description: "Brim width in mm (0 = no brim). Default: the farm brim setting." },
        bed_temp: {
          type: "object",
          description: "Bed temperature °C override for the chosen plate. Default: the filament preset's.",
          properties: { first_layer: { type: "integer" }, other_layers: { type: "integer" } },
          additionalProperties: false,
        },
        overrides: { type: "object", description: "Any Orca setting → value, e.g. {\"wall_loops\": \"3\"}." },
        arrange: { type: "boolean", description: "Auto-arrange on the plate (default: farm auto_arrange)." },
        orient: { type: "boolean", description: "Auto-orient the model (default: farm auto_orient)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "slice_status",
    description:
      "Poll a slice job from slice_model: status running/succeeded/failed, the result file_id and the " +
      "estimate (print_time_s, filament_g, filament_mm, layers) when done, `effective` (bed type, bed/nozzle " +
      "temperatures first/other layers, brim, presets — read back from the produced G-code), or the error and log tail.",
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
      "Grab a live camera frame from a printer and show it to you as an image. Also saves it as a file (file_id); set " +
      "include_data to also get it as base64 text. camera:false when the printer has no camera.",
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
  {
    name: "printer_capabilities",
    description:
      "Which controls a printer supports: job pause/resume/stop and speed (levels 1-4 or percent), " +
      "settable heaters with their max °C, motion, extrude, load/unload, fans, light, AMS, storage, G-code, camera, errors.",
    input_schema: printerOnly(),
  },
  {
    name: "printer_detail",
    description:
      "printer_status plus control-panel fields: speed_level/speed_percent, fan speeds (%), light, Wi-Fi signal, " +
      "firmware, developer_mode (Bambu; false = the printer refuses LAN control), active errors, AMS trays.",
    input_schema: printerOnly(),
  },
  {
    name: "printer_errors",
    description: "Active printer errors (HMS codes with text when known and a wiki link) and the fix when the printer needs Developer Mode.",
    input_schema: printerOnly(),
  },
  {
    name: "printer_set_temperature",
    description:
      "Set a heater target in °C (0 = off). Limits come from printer_capabilities. Not available on PrusaLink " +
      "printers (their API has no temperature control).",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        heater: { type: "string", enum: ["nozzle", "bed", "chamber"] },
        target: { type: "number" },
      },
      required: ["printer", "heater", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "printer_set_fan",
    description: "Set a fan's speed in percent (0-100). Available fans are in printer_capabilities.",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        fan: { type: "string", enum: ["part", "aux", "chamber"] },
        percent: { type: "number" },
      },
      required: ["printer", "fan", "percent"],
      additionalProperties: false,
    },
  },
  {
    name: "printer_set_light",
    description: "Turn the chamber light on or off.",
    input_schema: {
      type: "object",
      properties: { printer: { type: "string", description: PRINTER_REF }, on: { type: "boolean" } },
      required: ["printer", "on"],
      additionalProperties: false,
    },
  },
  {
    name: "printer_set_speed",
    description:
      "Change the print speed: level 1-4 (silent/standard/sport/ludicrous, Bambu) or percent 10-300 (Klipper/OctoPrint).",
    input_schema: {
      type: "object",
      properties: {
        printer: { type: "string", description: PRINTER_REF },
        level: { type: "integer", minimum: 1, maximum: 4 },
        percent: { type: "number" },
      },
      required: ["printer"],
      additionalProperties: false,
    },
  },
  {
    name: "printer_move",
    description:
      "Home, jog (axis + distance mm, |distance| ≤ 100) or turn the motors off. MOVES HARDWARE: the first call asks " +
      "the user; call again with action_id + confirmation_token after they answer. Refused while printing.",
    input_schema: confirmSchema({
      action: { type: "string", enum: ["home", "jog", "motors_off"] },
      axis: { type: "string", enum: ["x", "y", "z"] },
      distance: { type: "number", description: "mm, negative moves the other way." },
    }),
  },
  {
    name: "printer_extrude",
    description:
      "Extrude or retract mm of filament (nozzle ≥ 170 °C), or load (slot = AMS tray 0-15 or \"external\") / unload " +
      "filament. Needs the user's confirmation like printer_move. Refused while printing.",
    input_schema: confirmSchema({
      action: { type: "string", enum: ["extrude", "retract", "load", "unload"] },
      mm: { type: "number" },
      slot: { type: "string", description: 'AMS tray "0"-"15" (unit*4+tray), or "external".' },
    }),
  },
  {
    name: "printer_gcode",
    description: "Run one G-code line (≤ 256 chars). Needs the user's confirmation like printer_move. Refused while printing.",
    input_schema: confirmSchema({ line: { type: "string" } }),
  },
  {
    name: "printer_files",
    description: "List the files on a printer's own storage (name, size, mtime unix seconds).",
    input_schema: printerOnly(),
  },
  {
    name: "printer_file_delete",
    description: "Delete a file from a printer's storage (name from printer_files). Needs the user's confirmation like printer_move.",
    input_schema: confirmSchema({ name: { type: "string" } }),
  },
  {
    name: "print_list",
    description: "Print records (uploaded / awaiting_confirmation / started / declined / failed, with errors), newest first.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "file_list",
    description: "Files in Print Farm storage (uploads, sliced output, snapshots) with ids for print_upload / print_start.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "file_delete",
    description: "Delete a file from Print Farm storage. Needs the user's confirmation: call again with action_id + confirmation_token.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        action_id: { type: "string", description: "Second call: the pending action's id." },
        confirmation_token: { type: "string", description: "Second call: the token from the first call." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "camera_capture",
    description:
      "Take a camera still, keep it in the printer's capture gallery (Print Farm page) and show it to you as an image. " +
      "Returns the capture id.",
    input_schema: printerOnly(),
  },
  {
    name: "capture_list",
    description: "Kept camera captures (id, printer, taken_at UTC, size), newest first; printer filters. View one with capture_view.",
    input_schema: {
      type: "object",
      properties: { printer: { type: "string", description: PRINTER_REF } },
      additionalProperties: false,
    },
  },
  {
    name: "capture_view",
    description:
      "Look at a kept camera capture (capture_id from capture_list / camera_capture — includes stills the user took on " +
      "the Print Farm page), an image file (file_id, e.g. from print_snapshot), or a printer's newest capture (printer). " +
      "Returns the picture as an image.",
    input_schema: {
      type: "object",
      properties: {
        capture_id: { type: "string" },
        file_id: { type: "string" },
        printer: { type: "string", description: PRINTER_REF },
      },
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
