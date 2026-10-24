# Farm Settings, Printer Settings, and Profile Editor — Page API

Contract between the print-farm backend (`src/`) and the page (`ui/`) for
0.3.0. Routes are relative to the plugin's page API (same mechanism as the
existing `GET printers`, `POST slice`, …). Both sides implement exactly this;
change it here first.

## Shared Enums

- `plate_type`: Orca `curr_bed_type` values —
  `"Cool Plate"`, `"Engineering Plate"`, `"High Temp Plate"`,
  `"Textured PEI Plate"`. (Orca also knows `"Supertack Plate"` /
  `"Textured Cool Plate"`; accept them if the installed Orca lists them.)
- `brim`: `{ "mode": "off" | "auto" | "mm", "width_mm": number }`
  (`width_mm` used when `mode` is `"mm"`; `auto` = Orca `brim_type`
  `auto_brim` with `brim_width` = `width_mm`).
- `kind`: `"machine" | "filament" | "process"` (Orca names; the UI labels
  them Printer / Filament / Process).

## Farm Settings

### `GET farm-settings` → FarmSettings
### `PUT farm-settings` (partial FarmSettings) → FarmSettings
```json
{
  "plate_type": "Textured PEI Plate",
  "material": "PLA",
  "quality": "0.20mm Standard",
  "brim": { "mode": "auto", "width_mm": 5 },
  "auto_arrange": true,
  "auto_orient": false,
  "bed_temp_override": { "first_layer": null, "other_layers": null },
  "confirm_before_start": true,
  "monitoring": {
    "snapshot_interval_s": 60,
    "ignored_hms": ["0300_3100_0001_0001"],
    "auto_pause_on_failure": false
  }
}
```
Defaults are exactly the values above (bed temp overrides `null` = use the
filament preset). Validation errors → `400 {"error", "field"}`.

## Per-Printer Settings

Stored on the printer record; every field optional (null = fall back to the
farm setting / auto-detected preset).

### `PUT printers/:id/settings` (partial) → PrinterSettings
### `GET printers/:id/settings` → PrinterSettings
```json
{
  "plate_type": null,
  "printer_preset": "Bambu Lab P1S 0.4 nozzle",
  "process_preset": null,
  "filament_preset": "Bambu PLA Basic @BBL X1C",
  "nozzle_mm": 0.4,
  "capabilities": { "heaters": true, "camera": true, "gcode": true },
  "effective": { "plate_type": "Textured PEI Plate", "printer_preset": "…",
                 "process_preset": "…", "filament_preset": "…" }
}
```
`capabilities` and `effective` are read-only (ignored on PUT).
`nozzle_mm` ∈ `[0.2, 0.4, 0.6, 0.8]`.

## Profiles

### `GET profiles?kind=&vendor=&q=`
Existing route; each item gains `"user": true|false`, `"inherits": string|null`,
and `"compatible_printers"` when known. Vendor `"User"` lists the presets in
Orca's user preset dir.

### `GET profiles/:kind/:name` → Profile
`:name` URL-encoded.
```json
{
  "kind": "filament", "name": "PLA Textured 60", "vendor": "User", "user": true,
  "inherits": "Bambu PLA Basic @BBL X1C",
  "own": { "textured_plate_temp": ["60"], "textured_plate_temp_initial_layer": ["60"] },
  "resolved": { "...": "every key after the inherits chain is applied" },
  "path": "/home/…/OrcaSlicer/user/default/filament/PLA Textured 60.json"
}
```
Values are Orca's on-disk shapes (arrays of strings for per-extruder keys).

### `POST profiles` → Profile (201)
Create a User preset: `{"kind", "name", "inherits"?, "own": {…}}`.
Duplicating a system preset = `inherits: <system name>`, `own: {}` plus edits.
`409 {"error": "exists"}` if the name is taken in that kind.

### `PUT profiles/:kind/:name` → Profile
User presets only: `{"name"?: new name (rename), "inherits"?, "own": {…}}`
(`own` replaces the stored overrides). System preset → `403 {"error": "read_only"}`.

### `DELETE profiles/:kind/:name` → `{"ok": true}`
User presets only (`403` for system presets).

### Typed Fields
`GET profiles/fields?kind=` → the typed-field schema the editor renders:
```json
{"fields": [
  {"key": "nozzle_temperature_initial_layer", "label": "Nozzle (first layer)",
   "group": "Temperatures", "type": "int", "unit": "°C", "min": 150, "max": 350,
   "per_extruder": true},
  {"key": "sparse_infill_pattern", "label": "Infill pattern", "group": "Infill",
   "type": "enum", "options": [{"value": "grid", "label": "Grid"}, …]},
  {"key": "enable_support", "label": "Supports", "type": "bool"}
]}
```
Types: `int`, `float`, `percent` (Orca `"15%"` strings), `bool`, `enum`.
Filament: nozzle temps (first/other), bed temp per plate type (first/other:
`cool_plate_temp`, `eng_plate_temp`, `hot_plate_temp`, `textured_plate_temp`
and `*_initial_layer`), fan min/max, `filament_flow_ratio`,
`filament_max_volumetric_speed`. Process: `layer_height`, `wall_loops`,
`top_shell_layers`, `bottom_shell_layers`, `sparse_infill_density`,
`sparse_infill_pattern`, `brim_type`, `brim_width`, `enable_support`,
`support_type`, outer/inner wall + infill + travel speeds.

## Slicing

### `POST slice` gains (all optional)
```json
{ "bed_type": "Textured PEI Plate", "brim_width": 5,
  "bed_temp": { "first_layer": 60, "other_layers": 60 },
  "overrides": { "wall_loops": "3" } }
```
Resolution order for every value: call argument → printer settings → farm
settings → preset. `bed_type` always reaches Orca as `curr_bed_type`, so the
filament preset's per-plate bed temperature applies.

### `GET slice/:job` gains
```json
"effective": { "bed_type": "Textured PEI Plate", "bed_temp_first_layer": 60,
  "bed_temp_other_layers": 60, "nozzle_temp_first_layer": 220,
  "nozzle_temp_other_layers": 220, "brim_width": 5,
  "printer_preset": "…", "process_preset": "…", "filament_preset": "…" }
```
Bed/nozzle temps are read back from the produced G-code (`M140`/`M190`,
`M104`/`M109` before the first layer, and the slicer's config block), not
just predicted.

## Backend Additions (Additive)

- `409` / `403` / `404` bodies also carry `"message"` (human text), e.g.
  `{"error": "exists", "message": "a filament preset named '…' already exists"}`.
- `GET profiles/:kind/:name` may add `"resolve_error"` (and `resolved: null`)
  when the inherits chain can't be resolved.
- `effective` also has `"brim_type"` and `"source"`: `"gcode"` (read back) or
  `"requested"` (the G-code couldn't be read; temps are then `null`).
- `GET slice/:job` also has `"requested"`: the resolved values sent to Orca.
- Print records (`GET prints`): a failed or unconfirmed start no longer marks
  the print `failed`; it stays `uploaded` / `awaiting_confirmation` with
  `error` + `start_error` set, so Start (or the agent's same token) retries.
