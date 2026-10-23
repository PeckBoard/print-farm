// The Print Farm page: an HTML shell (theme tokens + stylesheet) around the
// stage-1 browser bundle (ui/main.ts, three.js included — see esbuild.js).
// The page is framed in a sandboxed iframe and reaches the JSON API in
// http.ts through the host's parent-proxied fetch bridge.
//
// Palette mirrors Peckboard's own tokens (web/src/index.css), same as
// ssh-fleet: light by default, dark via the host's ?theme=dark stamp or
// prefers-color-scheme, the stamp winning.

import { PAGE_JS } from "./generated/pageBundle";

const DARK = `
    --bg: #0f1117; --surface: #1a1d27; --surface2: #22252f; --surface3: #2a2d38; --hover: #252833;
    --text: #e5e7eb; --text2: #9ca3af; --text3: #8f97a5;
    --accent: hsl(220, 65%, 62%); --accent-hover: hsl(220, 65%, 56%); --accent-subtle: hsl(220, 30%, 16%);
    --danger: #f87171; --danger-bg: rgba(239,68,68,.1); --danger-border: rgba(239,68,68,.3);
    --success: #34d399; --success-bg: rgba(16,185,129,.1); --success-border: rgba(16,185,129,.3);
    --warn: #fbbf24; --warn-bg: rgba(245,158,11,.1); --warn-border: rgba(245,158,11,.3);
    --info: #60a5fa; --info-bg: rgba(59,130,246,.12); --info-border: rgba(59,130,246,.3);
    --done: #a78bfa; --done-bg: rgba(139,92,246,.12); --done-border: rgba(139,92,246,.3);
    --border: #2a2d38; --border-strong: #3a3d48; --code-bg: #14161d;
    --shadow: 0 1px 2px rgba(0,0,0,.3); --shadow-lg: 0 12px 32px rgba(0,0,0,.55);
    --overlay: rgba(0,0,0,.6); --skel: #252833; --skel2: #2e3240;
    --viewer-bg: #12141b; --grid: #4b5163; --grid-minor: #2a2e3a; --model: #6b9cf0; --extrude: #c47a3a; --extrude-top: #fde047; --travel: #5b8def;
    color-scheme: dark;`;

const CSS = `
  :root {
    --bg: #f8f9fb; --surface: #ffffff; --surface2: #f3f4f6; --surface3: #e9ebef; --hover: #f0f1f4;
    --text: #1a1d23; --text2: #4b5563; --text3: #6b7280;
    --accent: hsl(220, 72%, 50%); --accent-hover: hsl(220, 72%, 44%); --accent-subtle: hsl(220, 60%, 95%);
    --danger: #dc2626; --danger-bg: #fef2f2; --danger-border: #fecaca;
    --success: #059669; --success-bg: #ecfdf5; --success-border: #a7f3d0;
    --warn: #b45309; --warn-bg: #fffbeb; --warn-border: #fde68a;
    --info: #1d4ed8; --info-bg: #eff6ff; --info-border: #bfdbfe;
    --done: #6d28d9; --done-bg: #f5f3ff; --done-border: #ddd6fe;
    --border: #e5e7eb; --border-strong: #d1d5db; --code-bg: #f6f7f9;
    --shadow: 0 1px 2px rgba(16,24,40,.05); --shadow-lg: 0 12px 32px rgba(16,24,40,.18);
    --overlay: rgba(17,24,39,.45); --skel: #eceef2; --skel2: #f6f7f9;
    --viewer-bg: #eef0f4; --grid: #9aa3b5; --grid-minor: #d3d8e2; --model: #3b6fd8; --extrude: #c2410c; --extrude-top: #7c3aed; --travel: #2563eb;
    color-scheme: light;
  }
  :root[data-theme="dark"] {${DARK}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK}
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--bg); color: var(--text); font: 13px/1.5 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  .mono, code, pre { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace; }
  svg.i { width: 14px; height: 14px; flex: 0 0 auto; vertical-align: -2px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  [hidden] { display: none !important; }

  /* ── header + tabs ── */
  .top { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 14px; padding: 10px 18px 0; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .top h1 { font-size: 15px; margin: 0 0 10px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
  .top h1 svg { width: 18px; height: 18px; color: var(--accent); }
  .summary { display: flex; gap: 12px; font-size: 12px; color: var(--text2); margin-bottom: 10px; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .summary b { color: var(--text); font-weight: 600; }
  .tabs { display: flex; gap: 2px; margin-left: auto; align-self: flex-end; }
  .tab { border: none; background: none; color: var(--text2); font: inherit; font-weight: 550; font-size: 13px; padding: 8px 14px 10px; cursor: pointer; border-bottom: 2px solid transparent; display: inline-flex; gap: 6px; align-items: center; }
  .tab:hover { color: var(--text); }
  .tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
  .tab .n { background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn-border); border-radius: 999px; font-size: 10.5px; padding: 0 6px; line-height: 16px; font-weight: 700; }
  main { padding: 18px; max-width: 1500px; margin: 0 auto; }
  .section-head { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; flex-wrap: wrap; }
  .section-head h2 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--text2); }
  .section-head .grow { flex: 1; }
  .muted { color: var(--text3); }

  /* ── controls ── */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 550; cursor: pointer; white-space: nowrap; text-decoration: none; }
  .btn:hover { background: var(--hover); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn.danger { color: var(--danger); border-color: var(--danger-border); }
  .btn.danger:hover { background: var(--danger-bg); }
  .btn.danger.solid { background: var(--danger); border-color: var(--danger); color: #fff; }
  .btn.ghost { border-color: transparent; background: transparent; color: var(--text2); }
  .btn.ghost:hover { background: var(--surface3); color: var(--text); }
  .btn.sm { height: 26px; padding: 0 9px; font-size: 12px; }
  .btn[disabled] { opacity: .55; cursor: not-allowed; }
  .btn:focus-visible, .tab:focus-visible, a:focus-visible, .file:focus-visible, .drop:focus-visible, input[type=range]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  label.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text2); font-weight: 550; min-width: 0; }
  label.f .hint { font-weight: 400; color: var(--text3); font-size: 11.5px; }
  input[type=text], input[type=password], input[type=number], input[type=search], select { background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: 7px; padding: 0 10px; height: 32px; font: inherit; font-size: 13px; width: 100%; }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
  input[aria-invalid="true"], select[aria-invalid="true"] { border-color: var(--danger); }
  input[disabled], select[disabled] { opacity: .6; cursor: not-allowed; }
  .check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text2); cursor: pointer; user-select: none; }
  .check input { width: 15px; height: 15px; accent-color: var(--accent); margin: 0; }
  .field-error { color: var(--danger); font-size: 11.5px; font-weight: 500; }
  .reason { color: var(--text3); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid3 { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
  .secret-wrap { position: relative; }
  .secret-wrap .saved { position: absolute; right: 8px; top: 7px; font-size: 11px; color: var(--success); background: var(--success-bg); border: 1px solid var(--success-border); border-radius: 5px; padding: 0 6px; line-height: 17px; pointer-events: none; }
  .secret-wrap input { padding-right: 112px; }
  .linkbtn { background: none; border: none; padding: 0; color: var(--accent); font: inherit; font-size: 11.5px; cursor: pointer; text-align: left; }
  .linkbtn:hover { text-decoration: underline; }
  .spools { display: grid; gap: 8px; }
  .spool { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 10px; align-items: center; }
  .spool .fil { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text2); }
  .spool .pick { display: flex; align-items: center; gap: 7px; }
  .spool .warnline { grid-column: 2; color: var(--warn); font-size: 11.5px; font-weight: 500; }
  .swatch { width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--border-strong); flex: none; display: inline-block; }

  /* combobox */
  .combo { position: relative; }
  .combo input { padding-right: 28px; }
  .combo .caret { position: absolute; right: 9px; top: 9px; color: var(--text3); pointer-events: none; }
  .listbox { position: fixed; z-index: 90; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: var(--shadow-lg); padding: 4px; max-height: 280px; overflow: auto; }
  .listbox .opt { padding: 6px 10px; border-radius: 5px; cursor: pointer; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .listbox .opt[aria-selected="true"] { background: var(--hover); }
  .listbox .opt.cur { color: var(--accent); font-weight: 600; }
  .listbox .none { padding: 8px 10px; color: var(--text3); font-size: 12px; }

  /* ── badges / pills ── */
  .badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 5px; padding: 0 6px; font-size: 10.5px; font-weight: 600; white-space: nowrap; line-height: 18px; border: 1px solid var(--border); background: var(--surface2); color: var(--text2); }
  .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 0 9px 0 8px; font-size: 11.5px; font-weight: 650; line-height: 22px; border: 1px solid; white-space: nowrap; }
  .pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .pill.ok { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
  .pill.busy { color: var(--info); background: var(--info-bg); border-color: var(--info-border); }
  .pill.busy::before { animation: pulse 1.4s ease-in-out infinite; }
  .pill.warn { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-border); }
  .pill.bad { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }
  .pill.done { color: var(--done); background: var(--done-bg); border-color: var(--done-border); }
  .pill.muted { color: var(--text3); background: var(--surface2); border-color: var(--border); }
  @keyframes pulse { 50% { opacity: .35; } }

  /* ── banners ── */
  .banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; border-radius: 10px; border: 1px solid; margin-bottom: 14px; }
  .banner svg.i { width: 16px; height: 16px; margin-top: 1px; }
  .banner .grow { flex: 1; min-width: 0; }
  .banner b { display: block; margin-bottom: 2px; }
  .banner p { margin: 0; color: var(--text2); font-size: 12.5px; }
  .banner .row { margin-top: 8px; }
  .banner.warn { background: var(--warn-bg); border-color: var(--warn-border); }
  .banner.warn > svg { color: var(--warn); }
  .banner.bad { background: var(--danger-bg); border-color: var(--danger-border); }
  .banner.bad > svg { color: var(--danger); }
  .banner.info { background: var(--info-bg); border-color: var(--info-border); }
  .banner.info > svg { color: var(--info); }
  .banner.ok { background: var(--success-bg); border-color: var(--success-border); }
  .banner.ok > svg { color: var(--success); }

  /* ── queue ── */
  .queue { display: grid; gap: 8px; margin-bottom: 20px; }
  .qitem { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--warn-border); box-shadow: inset 3px 0 0 var(--warn), var(--shadow); border-radius: 10px; flex-wrap: wrap; }
  .qitem .what { flex: 1; min-width: 200px; }
  .qitem .what b { font-weight: 600; word-break: break-all; }
  .qitem .what .sub { color: var(--text2); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

  /* ── printer cards ── */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
  .card.state-error { border-color: var(--danger-border); }
  .card-head { display: flex; align-items: center; gap: 8px; padding: 11px 14px; min-width: 0; }
  .card-head .name { font-weight: 650; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .card-head .pill { margin-left: auto; }
  .cam { position: relative; aspect-ratio: 16 / 9; background: var(--surface2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); display: grid; place-items: center; overflow: hidden; }
  .cam img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cam .nocam { color: var(--text3); font-size: 12px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .cam .nocam svg { width: 22px; height: 22px; }
  .cam .age { position: absolute; right: 8px; bottom: 6px; background: rgba(0,0,0,.55); color: #fff; font-size: 10.5px; border-radius: 4px; padding: 0 6px; line-height: 17px; }
  .card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .file-line { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file-line.none { color: var(--text3); font-weight: 400; font-style: italic; }
  .prog { height: 8px; background: var(--surface3); border-radius: 999px; overflow: hidden; }
  .prog > div { height: 100%; background: var(--accent); border-radius: 999px; transition: width .4s ease; }
  .prog.paused > div { background: var(--warn); }
  .prog.done > div { background: var(--done); }
  .prog.indet > div { width: 35% !important; animation: indet 1.2s ease-in-out infinite; }
  @keyframes indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(290%); } }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 6px; font-variant-numeric: tabular-nums; }
  .stat { min-width: 0; }
  .stat .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); font-weight: 650; }
  .stat .v { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .temps { display: flex; gap: 6px; flex-wrap: wrap; }
  .temp { display: inline-flex; gap: 5px; align-items: center; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; line-height: 24px; font-size: 12px; font-variant-numeric: tabular-nums; }
  .temp .k { color: var(--text3); }
  .temp.hot .v { color: var(--warn); }
  .msg { font-size: 12px; color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger-border); border-radius: 6px; padding: 5px 8px; overflow-wrap: anywhere; }
  .msg.soft { color: var(--text2); background: var(--surface2); border-color: var(--border); }
  .card-foot { display: flex; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--surface2); flex-wrap: wrap; }
  .card-foot .spacer { flex: 1; }

  /* skeleton */
  .skel { background: linear-gradient(90deg, var(--skel) 25%, var(--skel2) 50%, var(--skel) 75%); background-size: 200% 100%; animation: shimmer 1.3s linear infinite; border-radius: 6px; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* ── printers list ── */
  .plist { display: grid; gap: 10px; }
  .prow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 14px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); align-items: center; }
  .prow .t { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .prow .t b { font-size: 13.5px; }
  .prow .sub { color: var(--text2); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; min-width: 0; }
  .prow .sub span { overflow-wrap: anywhere; }
  .prow .acts { grid-column: 2; grid-row: 1 / span 2; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .prow .pbanner { grid-column: 1 / -1; }
  .prow .pbanner .banner { margin-bottom: 0; }
  .testres { grid-column: 1 / -1; font-size: 12px; border-radius: 6px; padding: 5px 9px; border: 1px solid; overflow-wrap: anywhere; }
  .testres.ok { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
  .testres.bad { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }
  .testres.run { color: var(--text2); background: var(--surface2); border-color: var(--border); }

  /* ── slice tab ── */
  .slice { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 16px; align-items: start; }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); min-width: 0; }
  .panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .panel-head h3 { margin: 0; font-size: 13px; font-weight: 650; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .drop { margin: 12px; border: 1.5px dashed var(--border-strong); border-radius: 10px; padding: 18px 12px; text-align: center; color: var(--text2); cursor: pointer; transition: background .15s, border-color .15s; }
  .drop:hover, .drop.over { background: var(--accent-subtle); border-color: var(--accent); color: var(--text); }
  .drop svg { width: 22px; height: 22px; color: var(--accent); }
  .drop b { display: block; color: var(--text); margin-top: 4px; }
  .drop .small { font-size: 11.5px; color: var(--text3); }
  .files { max-height: 62vh; overflow: auto; border-top: 1px solid var(--border); }
  .file { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .file:hover { background: var(--hover); }
  .file.active { background: var(--accent-subtle); box-shadow: inset 3px 0 0 var(--accent); }
  .file .ico { grid-row: 1 / span 2; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; background: var(--surface2); color: var(--text2); }
  .file .ico.model { color: var(--accent); background: var(--accent-subtle); }
  .file .ico.gcode { color: var(--extrude); background: var(--warn-bg); }
  .file .nm { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .file .meta { grid-column: 2; color: var(--text3); font-size: 11.5px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .file .x { grid-column: 3; grid-row: 1 / span 2; }
  .file .prog { grid-column: 2 / -1; height: 4px; }
  .viewer { position: relative; height: min(56vh, 520px); min-height: 280px; background: var(--viewer-bg); border-radius: 0; overflow: hidden; }
  .viewer canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  .viewer .overlay { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text2); text-align: center; padding: 20px; pointer-events: none; }
  .viewer .overlay .box { pointer-events: auto; display: flex; flex-direction: column; gap: 10px; align-items: center; max-width: 360px; }
  .viewer .overlay .box > svg.i { width: 28px; height: 28px; color: var(--text3); }
  .viewer .overlay img.thumb { max-width: 100%; max-height: min(260px, 40vh); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); }
  select.plate-sel { height: 26px; width: auto; font-size: 12px; padding: 0 8px; }
  .viewer .tools { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; }
  .viewer .hint { position: absolute; left: 10px; bottom: 8px; font-size: 11px; color: var(--text3); pointer-events: none; }
  .viewer .gpu { position: absolute; left: 10px; top: 8px; right: 10px; font-size: 11px; color: var(--warn); pointer-events: none; }
  .layerbar { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .layerbar input[type=range] { flex: 1; min-width: 160px; accent-color: var(--accent); }
  .layerbar .lbl { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--text2); min-width: 150px; }
  .legend { display: flex; gap: 10px; font-size: 11.5px; color: var(--text2); align-items: center; }
  .legend i { display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .est { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .est .tile { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
  .est .tile .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); font-weight: 650; }
  .est .tile .v { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
  details.log summary { cursor: pointer; color: var(--text2); font-size: 12px; }
  details.log pre { margin: 6px 0 0; padding: 8px 10px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 2px 0; }
  .subhead { font-size: 11.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--text3); margin: 0; }

  /* ── empty ── */
  .empty { padding: 44px 24px; text-align: center; color: var(--text2); background: var(--surface); border: 1px dashed var(--border-strong); border-radius: 12px; }
  .empty .ico { width: 44px; height: 44px; border-radius: 12px; display: inline-grid; place-items: center; background: var(--accent-subtle); color: var(--accent); margin-bottom: 10px; }
  .empty .ico svg { width: 22px; height: 22px; }
  .empty h3 { margin: 0 0 4px; font-size: 14px; color: var(--text); font-weight: 650; }
  .empty p { margin: 0 auto 14px; max-width: 400px; font-size: 12.5px; }
  .empty.small { padding: 22px 14px; border: none; background: none; }

  /* ── modal + toasts ── */
  .backdrop { position: fixed; inset: 0; background: var(--overlay); z-index: 70; display: grid; place-items: center; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-lg); width: min(560px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
  .modal.sm { width: min(420px, 100%); }
  .modal-head { padding: 14px 18px 10px; display: flex; align-items: center; gap: 8px; }
  .modal-head h2 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
  .modal-body { padding: 4px 18px 14px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
  .modal-body p { margin: 0; color: var(--text2); }
  .modal-foot { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
  .modal-foot .reason { margin-right: auto; }
  .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 100; display: flex; flex-direction: column; gap: 8px; max-width: min(380px, calc(100vw - 32px)); }
  .toast { display: flex; gap: 8px; align-items: flex-start; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: var(--shadow-lg); padding: 10px 12px; font-size: 12.5px; animation: tin .18s ease-out; }
  .toast.bad { border-color: var(--danger-border); }
  .toast.bad svg { color: var(--danger); }
  .toast.ok svg { color: var(--success); }
  .toast .grow { flex: 1; overflow-wrap: anywhere; }
  @keyframes tin { from { transform: translateY(8px); opacity: 0; } }

  @media (max-width: 860px) {
    .slice { grid-template-columns: minmax(0, 1fr); }
    .files { max-height: 40vh; }
  }
  @media (max-width: 640px) {
    main { padding: 12px; }
    .top { padding: 8px 12px 0; gap: 4px 12px; }
    .tabs { margin-left: 0; width: 100%; }
    .tab { flex: 1; justify-content: center; padding: 8px 6px 10px; }
    .cards { grid-template-columns: minmax(0, 1fr); }
    .grid2, .grid3 { grid-template-columns: minmax(0, 1fr); }
    .prow { grid-template-columns: minmax(0, 1fr); }
    .prow .acts { grid-column: 1; grid-row: auto; justify-content: flex-start; }
    .est { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

export const PAGE: string =
  "<!doctype html>\n" +
  '<html lang="en">\n' +
  "<head>\n" +
  '<meta charset="utf-8" />\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  "<title>Print Farm</title>\n" +
  "<script>(function(){var t=new URLSearchParams(location.search).get(\"theme\");" +
  'if(t==="dark"||t==="light")document.documentElement.dataset.theme=t;})();</script>\n' +
  "<style>" +
  CSS +
  "</style>\n" +
  "</head>\n" +
  "<body>\n" +
  '<div id="app"></div>\n' +
  "<script>\n" +
  PAGE_JS +
  "\n</script>\n" +
  "</body>\n" +
  "</html>\n";
