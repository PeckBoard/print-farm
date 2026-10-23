# Print Farm — Peckboard Plugin

Control a fleet of 3D printers from Peckboard and slice models with the
OrcaSlicer CLI.

- **Printers**: Klipper/Moonraker, OctoPrint, PrusaLink (v1 API), and Bambu Lab
  through the local **print-bridge** sidecar (MQTT/FTPS live there).
- **Slicing**: OrcaSlicer CLI with Orca's own printer / filament / process
  presets (bundled vendor profiles + the user's presets), `inherits` chains
  flattened for the CLI.
- **Agents** can list printers, read status, slice, upload, pause and cancel.
  **Starting** (or resuming) a print moves hardware, so it always needs a
  human (see [Print Confirmation](#print-confirmation)).

TypeScript → esbuild → `extism-js` → `dist/plugin.wasm`, same layout as
`ssh-fleet` / `app-manager`. The page UI (`ui/`, three.js included) is a
separate esbuild stage spliced into the served HTML (see `esbuild.js`).

```bash
./build.sh        # npm install on first run, then dist/plugin.wasm
npm test          # vitest (drivers vs fake HTTP, resolver, G-code, real shell scripts, UI helpers)
npm run typecheck # plugin + ui/
```

## Permissions

| Permission           | Why                                                                     |
| -------------------- | ----------------------------------------------------------------------- |
| `http_request`       | Printer + print-bridge JSON APIs on the LAN / loopback                  |
| `process_exec_any`   | `curl` (binary / multipart / self-signed TLS), `orca-slicer`, file I/O  |
| `data_store`         | Printer registry, file + job metadata, profile index cache              |
| `ask_user`           | Human confirmation before an agent-requested print starts               |
| `provide_mcp_tools`  | The MCP tools below                                                      |
| `user_authority`     | The authenticated page API                                              |
| `contribute_sidebar` | The Print Farm sidebar entry                                             |

## Settings

| Key                 | Default                         | Notes                                                                 |
| ------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `bridge_url`        | `http://127.0.0.1:7781`         | print-bridge sidecar                                                  |
| `bridge_token`      | —                               | secret; sent as `Authorization: Bearer`                               |
| `orca_path`         | `orca-slicer`                   | name on PATH or absolute path (AppImage ok); the default also falls back to `~/.local/bin/orca-slicer`, then flatpak (see OrcaSlicer) |
| `orca_profiles_dir` | auto-detect                     | `:`-separated vendor roots (`<root>/<Vendor>/{machine,filament,process}`) |
| `orca_headless`     | `auto`                          | `auto` = wrap in `xvfb-run -a` when no `$DISPLAY`/`$WAYLAND_DISPLAY` and xvfb-run exists; `always`; `never` |
| `storage_dir`       | `~/.local/share/peckboard-print-farm` | see [Storage](#storage)                                         |

## Storage

Uploaded models, sliced G-code, snapshots and slice-job scratch dirs live **on
disk**, not in `data_store`:

- `data_store` documents are capped at 256 KiB; models and G-code are MBs.
- Printer uploads stream with curl straight from disk.
- Core has no private plugin file API, so files are written via
  `peckboard_exec_any`, which runs inside **Peckboard's agent sandbox**: the
  Peckboard data dir is denied (read and write), the project folder is writable
  only for MCP calls, and `<data_dir>/plugin-exec` only for UI calls. The only
  place writable from both an agent's tool call and the UI is the sandbox's
  writable `$HOME` set, hence `${XDG_DATA_HOME:-~/.local/share}/peckboard-print-farm`
  (`files/`, `jobs/<id>/`, `snapshots/`). A `storage_dir` override must stay
  inside that writable set.

Metadata (file records, slice jobs, print jobs, printers) is in `data_store`.

## UI API

All routes are authenticated (`/api/plugin-ui/print-farm/...`, JSON in/out).
Errors: `{error}` with status 400 (bad input / upstream failure) or 404.
Printers are always **redacted** (secrets → `has_*` flags).

Binary data travels as **base64 inside JSON** both ways: core's plugin HTTP
bridge only carries string bodies (requests are decoded lossy-UTF-8) and axum
caps request bodies at 2 MiB. So uploads are **chunked (≤1 MiB base64 per
request)** and file reads are **ranged (≤768 KiB per request)**.

### Types

```ts
type Status = {
  state: "idle" | "printing" | "paused" | "finished" | "error" | "offline";
  progress: number; // 0..1
  file: string | null;
  elapsed_s: number | null;
  eta_s: number | null;
  layer: number | null;
  total_layers: number | null;
  temps: {
    nozzle?: { actual: number; target: number };
    bed?: { actual: number; target: number };
    chamber?: { actual: number; target: number | null };
  };
  message: string | null;
};
type Printer = {
  id; name; type: "moonraker" | "octoprint" | "prusalink" | "bambu"; host; port?; username?;
  has_api_key: boolean; has_password: boolean; tls_insecure: boolean; storage?;
  bambu?: { serial; model?; has_access_code: boolean };
  orca_printer_profile?; orca_filament_profile?; orca_process_profile?;
};
type File = {
  id; name; kind: "model" | "gcode" | "gcode.3mf" | "bgcode" | "image" | "other";
  size: number; complete: boolean; source: "upload" | "slice" | "project" | "snapshot";
  slice_job?; estimate?: Estimate; path; // path is server-side, informational
};
type Estimate = { print_time_s; filament_mm; filament_g; filament_cm3; filament_cost; layers }; // each number | null
type SliceJob = {
  id; status: "running" | "succeeded" | "failed"; model_file_id; printer_id?;
  profiles: { printer; filament; process; vendor? }; target: "gcode" | "gcode.3mf";
  result_file_id?; estimate?; error?; log_tail?; pid; dir; command: string[];
};
type Print = {
  id; printer_id; file_id; remote_name; requested_by: "ui" | "agent"; options?; error?;
  status: "uploaded" | "awaiting_confirmation" | "started" | "declined" | "failed";
};
```

### Routes

| Method + path                 | Request                                                                                                  | Response                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET printers`                | —                                                                                                        | `{printers: Printer[]}`                                        |
| `POST printers`               | `{name?, type, host, port?, api_key?, username?, password?, tls_insecure?, storage?, bambu?: {serial, access_code, model?}, orca_*_profile?}` | `{printer, warning: string\|null}` (warning = bridge registration failed) |
| `PUT printers/:id`            | same fields, partial. Secrets: omitted or `""` keeps, `null` clears                                      | `{printer, warning}`                                           |
| `DELETE printers/:id`         | —                                                                                                        | `{removed}`                                                    |
| `POST printers/:id/test`      | —                                                                                                        | `{ok, detail}`                                                 |
| `GET status`                  | —                                                                                                        | `{printers: [{id, name, type, status: Status}]}`               |
| `GET printers/:id/status`     | —                                                                                                        | `{id, status: Status}`                                         |
| `POST printers/:id/control`   | `{action: "pause" \| "resume" \| "cancel"}`                                                              | `{ok, action}`                                                 |
| `GET printers/:id/snapshot`   | —                                                                                                        | `{content_type, data_base64}`; 404 `{error:"no camera"}`       |
| `GET profiles`                | no params                                                                                                | `{roots: [{kind, path}], vendors: string[]}` (`"User"` first when user presets exist) |
| `GET profiles?kind=&vendor=`  | `kind` = printer\|filament\|process, `all=1` to include base (non-instantiable) presets, `refresh=1` to rescan | `{kind, vendor, profiles: [{name, vendor, inherits, instantiable, source}]}` |
| `GET files`                   | —                                                                                                        | `{files: File[]}` (newest first)                               |
| `POST uploads`                | `{name, data_base64?, done?}` — first chunk optional                                                     | `{file}`                                                       |
| `POST uploads/:id/chunk`      | `{offset, data_base64, done?}` — `offset` must equal current `size` (else 400 `offset mismatch: expected N`) | `{file}`                                                     |
| `GET files/:id?offset=&length=` | ranged read, `length` ≤ 786432                                                                         | `{file, offset, length, size, eof, data_base64}`               |
| `DELETE files/:id`            | —                                                                                                        | `{removed}`                                                    |
| `POST slice`                  | `{file_id, printer_id?, printer_profile?, filament_profile?, process_profile?, vendor?, target?, arrange?, orient?}` — missing profiles fall back to the printer's defaults | `{job: SliceJob}`                                              |
| `GET slice`                   | —                                                                                                        | `{jobs: SliceJob[]}`                                           |
| `GET slice/:job`              | polls the job (registers the result file when it finishes)                                               | `{job: SliceJob}`                                              |
| `POST print`                  | `{printer_id, file_id, start: boolean, options?: {plate?, use_ams?, bed_leveling?}}` — uploads, and starts when `start` (a UI click is the human confirmation) | `{print: Print}` |
| `GET prints`                  | —                                                                                                        | `{prints: Print[]}`                                            |
| `POST prints/:id/start`       | start a queued / agent-requested print                                                                    | `{print: Print}`                                               |
| `POST prints/:id/dismiss`     | drop a queued print without starting it (file stays on the printer)                                      | `{print: Print}` (status `declined`)                           |
| `GET diagnostics`             | —                                                                                                        | `{orca: {orca_path, orca_found, orca_resolved, orca_via: "path"\|"local"\|"flatpak"\|null, display, xvfb_run, headless_mode, curl_found}, bridge_url, profile_roots}` |

Upload flow: `POST uploads {name, data_base64: <first ≤1 MiB>}` → `file.id`,
then `POST uploads/:id/chunk {offset: file.size, data_base64}` repeatedly, the
last with `done: true`. Retry a failed chunk with the `size` the error reports.

## Page

`GET /plugin-api/v1/print-farm` (sidebar "Print Farm") — `ui/main.ts`:

- **Farm**: printer cards (state pill, progress, layer, elapsed / remaining,
  temps, camera snapshot every ~5s while on screen, Pause / Resume / Cancel
  with a confirm) and the prints waiting for a human Start (confirm dialog).
  Status polls every ~2s, only while the page is visible.
- **Slice**: chunked drag-drop upload, the file list, a three.js preview
  (STL / 3MF models; G-code and `.gcode.3mf` by layer, extrusion vs travel),
  the slice form (printer + Orca vendor / printer / filament / process
  comboboxes), job progress + estimate, and send (upload only, or upload &
  start after a confirm). `GET diagnostics` problems show as a banner with an
  App Manager link.
- **Printers**: add / edit / remove / test connection, per-type fields,
  saved-secret state, default Orca profiles.

Manual check against a fake printer: `node test/fixtures/fake-moonraker.js
<port>` (serves a mid-print Moonraker + a JPEG webcam), `node
test/fixtures/make-samples.js <dir>` (sample STL + G-code), then
`node test/e2e/page-shots.mjs <base> <user> <pass> <out> <stl> <gcode>`
against a scratch Peckboard with the printer added — it drives the flows and
writes light / dark / phone screenshots.

## MCP Tools

`printer_list`, `printer_status {printer?}`, `profile_list {kind?, vendor?, query?}`,
`slice_model {path | file_id, printer?, printer_profile?, filament_profile?, process_profile?, vendor?, arrange?, orient?}`
→ job, `slice_status {job_id}`, `print_upload {printer, file_id}`,
`print_start` (two-phase, below), `print_control {printer, action: pause|cancel}`
(resume is UI-only), `print_snapshot {printer, include_data?}` (saves a file;
base64 only on request).

## Print Confirmation

`print_start {printer, file_id}` uploads the file, queues the print as
`awaiting_confirmation`, and asks the user **in the agent's chat** via core's
`peckboard_ask_user` (options "Start print" / "Don't start"). The agent then
calls `print_start {print_id, confirmation_token}`; the plugin reads the answer
with `peckboard_get_answer`, which core resolves from the session's event log —
the agent cannot forge it. Only an un-rejected "Start print" starts the
print; anything else marks it `declined`. If the user can't be asked (no live
session), the print stays queued and the user presses Start on the page
(`POST prints/:id/start`). UI-initiated prints (`POST print {start:true}`) start
directly: the click is the confirmation.

## Drivers

| Type        | Status                                              | Upload                                   | Start / control                                        | Snapshot |
| ----------- | --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ | -------- |
| `moonraker` | `/printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed` | `POST /server/files/upload` multipart (`root=gcodes`) | `/printer/print/start?filename=`, `pause`, `resume`, `cancel` | first enabled cam in `/server/webcams/list` |
| `octoprint` | `/api/job` + `/api/printer` (409 → offline)          | `POST /api/files/local` multipart         | `POST /api/files/local/{name}` `{command:select, print:true}`; `POST /api/job` | `/api/settings` snapshot url (loopback host re-pointed at the printer) |
| `prusalink` | `/api/v1/status` (+ `/api/v1/job`)                   | `PUT /api/v1/files/{storage}/{name}` raw  | `POST /api/v1/files/{storage}/{name}`; `PUT /api/v1/job/{id}/pause\|resume`; `DELETE /api/v1/job/{id}` | `/api/v1/cameras/snap` |
| `bambu`     | print-bridge `GET /printers/{id}/status`              | `POST /printers/{id}/upload?name=` raw    | `/start {file, plate, use_ams, bed_leveling}`, `/pause`, `/resume`, `/stop` | `/printers/{id}/snapshot` |

Auth: Moonraker/OctoPrint `X-Api-Key`; PrusaLink HTTP Digest (`username`
default `maker` + `password`) or `X-Api-Key`; Bambu printers are registered
with the bridge (`PUT /printers/{id}`) on save and re-registered if the bridge
answers 404. File kinds are checked per type (Bambu takes `.gcode.3mf`,
PrusaLink `.gcode`/`.bgcode`, the others `.gcode`).

## OrcaSlicer

Command line (one detached job per slice, polled):

```
[xvfb-run -a] orca-slicer --arrange 1 [--orient 1] --slice 0 \
  --load-settings "<job>/printer.json;<job>/process.json" \
  --load-filaments "<job>/filament.json" \
  --outputdir <job>/out [--export-3mf result.gcode.3mf] <model>
```

- Plain targets produce `<out>/plate_1.gcode`; Bambu targets (printer type
  `bambu`, vendor `BBL`, or `printer_model` "Bambu Lab …") produce
- Finding the binary: `orca_path` if it resolves (`command -v`). When it is
  the default `orca-slicer` and not on PATH, Print Farm tries
  `$HOME/.local/bin/orca-slicer` (App Manager's AppImage wrapper —
  Peckboard's PATH often lacks `~/.local/bin`), then flatpak
  (`com.orcaslicer.OrcaSlicer`, legacy `io.github.softfever.OrcaSlicer`,
  checked with `flatpak info`), run as
  `flatpak run --filesystem=<storage_dir> <id>` so the sandbox can read the
  model and write the job dir. `GET diagnostics` reports which one
  (`orca_resolved`, `orca_via`).
  `<out>/result.gcode.3mf`. `result.json` (Linux) supplies error text.
- The three JSONs are the selected presets **flattened** along `inherits`
  (looked up by name in the chosen vendor, then the user presets, then
  `OrcaFilamentLibrary` for filaments, then a name search over every root).
- Estimates come from the G-code comments (`total estimated time`, `estimated
  printing time (normal mode)`, `filament used [mm]/[g]/[cm3]`, `total layers
  count`); for `.gcode.3mf` the embedded `Metadata/plate_1.gcode` is read with
  `unzip` or `python3` if available.
- Profile roots auto-detected: the binary's `../resources/profiles`, common
  install / flatpak paths, `~/.config/OrcaSlicer/system` (written on first GUI
  run — the only copy when Orca is an un-extracted AppImage), and user presets
  under `~/.config/OrcaSlicer/user/<id>/`.
- Headless hosts: slicing itself needs no display, but the Linux build links
  GTK and some versions refuse to start without one; `orca_headless=auto`
  wraps the run in `xvfb-run -a` when there's no display and xvfb-run is
  installed (`GET diagnostics` shows what was found).

## Known Limits and Caveats

- **Secrets in argv**: curl-path requests (multipart/file uploads, binary
  snapshots, self-signed TLS) put the API key / bearer token / digest password
  in curl's argv for the duration of the request (readable via `/proc` by the
  same user). Plain JSON calls go through core's `http_request` and don't.
- No wall clock in the wasm runtime → records carry sequence ids, not
  timestamps.
- Large files cost several exec round-trips (≤96 KiB base64 per argv piece,
  ≤1 MiB per UI chunk).
