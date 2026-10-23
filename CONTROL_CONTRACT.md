# Printer Control Contract

UI routes under `/api/plugin-ui/print-farm/`. JSON everywhere. Errors answer
4xx/5xx with `{error, hint?, needs_developer_mode?}`.

## Capabilities and Detail

- `GET printers/:id/capabilities` →
  `{job:{pause,resume,stop,speed_levels,speed_percent}, temps:{nozzle:{max}|null, bed:{max}|null, chamber:{max}|null}, motion, extrude, load_unload, fans:("part"|"aux"|"chamber")[], light, ams, files, gcode, camera, errors}`
  - Bambu: speed levels, nozzle ≤300, bed ≤110, chamber `null`; fans by model
    (A1/A1 mini `["part"]`, P1P `["part","aux"]`, else all three).
  - Moonraker / OctoPrint: speed percent, nozzle ≤300, bed ≤120, `["part"]`
    fan, motion, extrude, G-code, files; no light / AMS / load-unload.
  - PrusaLink: pause/resume/stop, files, camera only.
- `GET printers/:id/detail` → the status fields plus
  `{speed_level, speed_percent, fans:{part?,aux?,chamber?}, light, wifi_signal, firmware, developer_mode, errors:[{code,text,severity,url?}], ams}`.
  - `ams` is `{trays:[{slot,unit,tray,type,color}], external:{type,color}|null, active}` or `null`;
    `active` is the global slot feeding the toolhead, `"external"`, or `null`
    (Bambu `ams.tray_now`: 255 = none, 254 = external, else unit\*4+tray).
  - `developer_mode` is `null` unless the printer reports the `fun` bitfield
    (bit 29 = signed commands required ⇒ `false`). P1S firmware doesn't send
    `fun` (only `home_flag`, with no documented developer-mode bit), so a
    P1S stays `null`: the command refusal is the signal.
  - Non-Bambu printers report one `{code:"error", text:<message>, severity:"error"}`
    entry when in an error state.

## Control

`POST printers/:id/control` `{action, ...}` → `{ok:true, confirmed?, action}`.

| action                       | params                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| `pause` / `resume` / `stop`  | — (`cancel` is accepted as an alias of `stop`)             |
| `speed`                      | `level` 1-4, or `percent` 10-300                           |
| `temp`                       | `heater` nozzle/bed/chamber, `target` °C (0..caps max)     |
| `fan`                        | `fan` part/aux/chamber, `percent` 0-100                    |
| `light`                      | `on` bool                                                  |
| `home` / `motors_off`        | —                                                          |
| `jog`                        | `axis` x/y/z, `distance` mm (non-zero, \|d\| ≤ 100)        |
| `extrude`                    | `mm` (negative = retract, \|mm\| ≤ 100; nozzle ≥ 170 °C)   |
| `load`                       | `slot` 0-15 (unit\*4+tray) or `"external"`                 |
| `unload`                     | —                                                          |
| `gcode`                      | `line` (one line, ≤ 256 chars)                             |

- 400: invalid params or unsupported on this printer.
- 409: motion/extrude/load/unload/gcode while printing or paused; extrude with
  a cold nozzle; developer-mode refusal →
  `{error:"Printer refused the command", hint:"On the printer: Settings → enable LAN Only Mode, then Developer Mode.", needs_developer_mode:true}`.
- 502/503: printer refused for another reason / bridge or printer offline.
- `confirmed:false` (Bambu): sent, but no reply within ~6 s. Absent for
  drivers that can't confirm.
- A speed `level` on a percent-only printer maps to 50/100/124/166 %.

The existing Start path (`POST print` with `start:true`, `POST prints/:id/start`)
now surfaces the same 409 instead of reporting success.

## Printer Storage

- `GET printers/:id/files` → `{files:[{name, size, mtime}]}` — `mtime` is unix
  seconds or `null`. Bambu lists `/` and `/cache` (cache entries are named
  `cache/<file>`).
- `DELETE printers/:id/files?name=` → `{removed}`.
- `POST printers/:id/files/print` `{name, plate?}` (the UI sends no `spools`;
  `spools` stays accepted for future use) → `{print, note}`. Bambu:
  - a stored Print Farm file with the same name → its filaments are
    auto-matched to the loaded spools; `note` = `Spools auto-matched: …`;
  - no stored copy → no matching is possible: `use_ams` when AMS trays are
    loaded and the external spool isn't the active one (printer's own
    filament order, no `ams_mapping`), else the external spool; `note` says which.
  - Bambu can only start root files (the bridge rejects `cache/…` names).
  Other printers: started by name, `note: null`.

## Captures

- `POST printers/:id/capture` → `{id, printer_id, taken_at, size, content_type, url:"captures/<id>"}`;
  `taken_at` is ISO-8601 UTC.
- `GET captures?printer=` → `{captures:[…same shape…]}`, newest first.
- `GET captures/:id` → JSON `{content_type, data_base64}` (same shape as
  `GET printers/:id/snapshot`; never raw JPEG — the plugin-UI fetch bridge
  carries text only). Also carries `capture, offset, length, size, eof`; a
  still over 768 KiB needs `?offset=` follow-ups (camera stills fit in one).
- `DELETE captures/:id` → `{removed}`.

## Prints

`GET prints` → `{prints:[{id, printer_id, file_id, remote_name, status, requested_by, options?, spools?, error?}]}`
(unchanged). `file_id` is `""` for prints started from printer storage with no
stored copy.

## print-bridge 0.1.7

- `POST /printers/{id}/command` `{type, ...}` — `speed {level}`,
  `temp {heater, target}`, `fan {fan, percent}`, `light {on}`, `home`,
  `jog {axis, distance}`, `motors_off`, `extrude {mm}`, `load {slot}`,
  `unload`, `gcode {line}`.
- Every command (start/pause/resume/stop included) waits ≤ 6 s for the
  printer's reply: 200 `{ok:true, confirmed}`; 409
  `{ok:false, error, reason, err_code, needs_developer_mode:true}` for
  0x05024007 / 0x05024009 / "mqtt message verify failed"; 502
  `{ok:false, error, reason, err_code}` for other refusals; 409 for motion
  mid-print or a cold extrude; 400 for bad params; 503 offline.
- Status adds `speed_level`, `fans`, `light`, `wifi_signal`, `firmware`,
  `developer_mode`, `errors`, and `ams.active`.
- Replies are matched on `command` + `sequence_id` under any top-level key
  (`print`, `system`, … — a `system.ledctrl` request is answered under `system`).
- `GET /printers/{id}/files` → `{files:[…]}`; `DELETE /printers/{id}/files?name=`.
