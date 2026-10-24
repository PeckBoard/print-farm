// Styles for the Settings / Profiles tabs, printer settings dialog and the
// slice form's overrides + effective block. Injected once at load; uses the
// theme tokens from src/page.ts so light/dark follow.

const CSS = `
  div.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text2); font-weight: 550; min-width: 0; }
  div.f .hint { font-weight: 400; color: var(--text3); font-size: 11.5px; }
  .flabel { font-size: 12px; color: var(--text2); font-weight: 550; }
  .row.nowrap { flex-wrap: nowrap; }
  .row.tight { gap: 4px; }
  .row.between { justify-content: space-between; }
  .stack.tight { gap: 6px; }
  .grid2.al-top { align-items: start; }
  textarea { background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: 7px; padding: 8px 10px; font-size: 12px; line-height: 1.5; width: 100%; resize: vertical; }
  textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
  textarea[aria-invalid="true"] { border-color: var(--danger); }
  input[type=search] { -webkit-appearance: none; appearance: none; }
  select:focus-visible, input:focus-visible { outline: none; }

  /* switch */
  .switch { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; position: relative; user-select: none; }
  .switch .sw-in { position: absolute; opacity: 0; width: 34px; height: 20px; margin: 0; cursor: pointer; }
  .switch .sw-track { flex: none; width: 34px; height: 20px; border-radius: 999px; background: var(--surface3); border: 1px solid var(--border-strong); position: relative; transition: background .15s, border-color .15s; margin-top: 1px; }
  .switch .sw-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
  .switch .sw-in:checked + .sw-track { background: var(--accent); border-color: var(--accent); }
  .switch .sw-in:checked + .sw-track .sw-knob { transform: translateX(14px); }
  .switch .sw-in:focus-visible + .sw-track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch .sw-in:disabled + .sw-track { opacity: .55; }
  .switch .sw-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .switch .sw-label { font-size: 13px; font-weight: 550; color: var(--text); }
  .switch .sw-label:empty { display: none; }
  .switch .sw-desc { font-size: 11.5px; color: var(--text3); }
  .switch.bare { align-items: center; }
  .switch.bare .sw-track { margin-top: 0; }
  .switches { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  /* number with unit */
  .unit-in { position: relative; min-width: 0; }
  .unit-in.has-unit input { padding-right: 38px; }
  .unit-in .unit { position: absolute; right: 10px; top: 0; line-height: 32px; font-size: 12px; color: var(--text3); pointer-events: none; }
  .unit-in input { font-variant-numeric: tabular-nums; }

  /* chips */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 26px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 9px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface2); color: var(--text); font-size: 12px; font-weight: 550; }
  .chip:not(:has(.chip-x)) { padding-right: 9px; }
  .chip.mono span { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
  .chip.ok { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
  .chip.off { color: var(--text3); background: var(--surface2); border-color: var(--border); text-decoration: line-through; text-decoration-color: var(--border-strong); }
  .chip svg.i { width: 12px; height: 12px; }
  .chip-x { border: none; background: none; color: var(--text3); width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; cursor: pointer; padding: 0; }
  .chip-x:hover { background: var(--danger-bg); color: var(--danger); }
  .chip-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chip-x svg.i { width: 11px; height: 11px; }
  .chips-none { font-size: 12px; font-weight: 400; }

  /* key/value list */
  dl.kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 12.5px; }
  dl.kv dt { color: var(--text3); font-weight: 600; }
  dl.kv dd { margin: 0; overflow-wrap: anywhere; color: var(--text); }

  /* settings tab */
  .settings .section-head .reason { flex: 1 1 260px; }
  .setgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; max-width: 1180px; }
  .setcol { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .settings .savebar { max-width: 1180px; }
  .setgrid .pdesc { margin: -2px 0 0; }
  .brim-row { flex-wrap: nowrap; }
  .brim-w { width: 110px; flex: none; }
  .savebar { position: sticky; bottom: 0; z-index: 10; display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); flex-wrap: wrap; }
  .savebar .grow { flex: 1; }
  .savebar.dirty { border-color: var(--accent); }
  .savebar.dirty .reason { color: var(--accent); font-weight: 600; }
  .savebar.inpanel { margin: 0; border-radius: 0 0 12px 12px; border-width: 1px 0 0; box-shadow: 0 -6px 16px -12px rgba(0,0,0,.35); }

  /* profiles tab */
  .pgrid { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 16px; align-items: start; }
  .pfilters { gap: 10px; padding-bottom: 10px; }
  .seg.seg-full { display: flex; flex-wrap: nowrap; }
  .seg.seg-full button { flex: 1; }
  .searchbox { position: relative; }
  .searchbox > svg.i { position: absolute; left: 10px; top: 9px; color: var(--text3); }
  .searchbox input { padding-left: 30px; }
  .pcount { font-size: 11.5px; color: var(--text3); min-height: 17px; }
  .presets { max-height: calc(100vh - 330px); min-height: 200px; overflow: auto; border-top: 1px solid var(--border); }
  .prst { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer; min-height: 36px; }
  .prst:hover { background: var(--hover); }
  .prst.active { background: var(--accent-subtle); box-shadow: inset 3px 0 0 var(--accent); }
  .prst:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .prst .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; font-weight: 500; }
  .badge.user { color: var(--accent); border-color: var(--accent); background: var(--accent-subtle); }
  .pdetail { display: flex; flex-direction: column; min-height: 240px; }
  .pdetail .pempty { margin: auto; }
  .pempty .ico { width: 44px; height: 44px; border-radius: 12px; display: inline-grid; place-items: center; background: var(--accent-subtle); color: var(--accent); margin-bottom: 10px; }
  .pempty h3 { margin: 0 0 4px; font-size: 14px; color: var(--text); }
  .pempty p { margin: 0 auto; max-width: 380px; font-size: 12.5px; }
  .phead { flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; }
  .ptitle { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .ptitle h3 { white-space: normal; overflow-wrap: anywhere; font-size: 14px; }
  .pacts { flex: none; }
  .pmeta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 12px; }
  .pmeta .linkbtn { font-size: 12px; }
  .pmeta .path { font-size: 11px; color: var(--text3); overflow-wrap: anywhere; flex-basis: 100%; }
  .banner.slim { margin: 0; padding: 8px 12px; }
  .pform { display: flex; flex-direction: column; gap: 14px; }
  fieldset.pgroup { border: 1px solid var(--border); border-radius: 10px; margin: 0; padding: 4px 12px 10px; min-width: 0; }
  fieldset.pgroup legend { font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--text3); padding: 0 6px; margin-left: -6px; }
  fieldset.pgroup > .hint { margin: 6px 0 0; font-size: 11.5px; color: var(--text3); }
  .prow2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(140px, 220px) 28px; gap: 2px 10px; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--border); }
  .prow2:last-of-type { border-bottom: none; }
  .prow2 > .field-error { grid-column: 2 / -1; }
  .plabel { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text2); min-width: 0; }
  .plabel span:not(.dot) { overflow-wrap: anywhere; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; border: 1.5px solid var(--border-strong); background: transparent; }
  .ovr .dot, .lg.ovr .dot { background: var(--accent); border-color: var(--accent); }
  .prow2.ovr .plabel { color: var(--text); font-weight: 600; }
  .pctl { min-width: 0; display: flex; justify-content: flex-end; }
  .pctl > .unit-in, .pctl > select { width: 100%; }
  .pctl input, .pctl select { height: 30px; }
  .rst { width: 26px; height: 26px; border-radius: 6px; border: 1px solid transparent; background: none; color: var(--text3); display: inline-grid; place-items: center; cursor: pointer; visibility: hidden; padding: 0; }
  .ovr > .rst, .ovr .bwrap .rst { visibility: visible; }
  .rst:hover { background: var(--surface3); color: var(--text); }
  .rst:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .rov { font-variant-numeric: tabular-nums; color: var(--text); font-weight: 550; font-size: 12.5px; text-align: right; overflow-wrap: anywhere; }
  .pdetail p.reason { margin: 0; }
  .pform.ro .dot, .pform.ro .rst { display: none; }
  /* inherited values read quieter than this preset's own overrides */
  .pform .prow2:not(.ovr) .pctl input, .pform .prow2:not(.ovr) .pctl select, .pform .bcell:not(.ovr) input { color: var(--text2); }
  .btable-wrap { overflow-x: auto; }
  .btable { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
  .btable th { text-align: left; font-weight: 600; color: var(--text2); padding: 6px 8px 6px 0; white-space: nowrap; }
  .btable thead th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); font-weight: 650; border-bottom: 1px solid var(--border); }
  .btable td { padding: 5px 4px; vertical-align: top; }
  .btable tbody tr + tr th, .btable tbody tr + tr td { border-top: 1px dashed var(--border); }
  .bwrap { display: flex; align-items: center; gap: 6px; min-width: 130px; }
  .bwrap .unit-in { flex: 1; }
  .bwrap .rov { flex: 1; text-align: left; }
  .bcell.low input, .bcell.low .rov { border-color: var(--warn); color: var(--warn); }
  .bcell.low .unit-in::after { content: "low"; position: absolute; right: 34px; top: 0; line-height: 30px; font-size: 10.5px; font-weight: 700; color: var(--warn); text-transform: uppercase; pointer-events: none; }
  .bcell .field-error { margin-top: 2px; }
  .legendline { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; font-size: 11.5px; color: var(--text3); }
  .legendline .lg { display: inline-flex; align-items: center; gap: 6px; }
  textarea.json { min-height: 280px; font-size: 12px; }
  details.rtable summary { cursor: pointer; color: var(--text2); font-size: 12px; padding: 2px 0; }
  details.rtable[open] summary { margin-bottom: 8px; }
  .rtable-wrap { max-height: 360px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
  .rtable-wrap .ftable td { border-bottom: 1px solid var(--border); padding: 4px 8px; font-size: 11.5px; }
  .rtable-wrap .ftable td.k { color: var(--text2); white-space: nowrap; width: 1%; }
  .rtable-wrap .ftable td.v { overflow-wrap: anywhere; }

  /* slice: overrides + effective */
  details.ovr-disc { border: 1px solid var(--border); border-radius: 10px; background: var(--surface2); }
  details.ovr-disc > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12.5px; font-weight: 600; color: var(--text); border-radius: 10px; }
  details.ovr-disc > summary::-webkit-details-marker { display: none; }
  details.ovr-disc > summary svg.i { transform: rotate(-90deg); transition: transform .15s; color: var(--text3); }
  details.ovr-disc[open] > summary svg.i { transform: none; }
  details.ovr-disc > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  details.ovr-disc > summary .sumhint { font-weight: 400; font-size: 11.5px; margin-left: auto; }
  details.ovr-disc > .stack { padding: 4px 12px 12px; }
  .badge.ovn { color: var(--accent); border-color: var(--accent); background: var(--accent-subtle); }
  .eff { display: flex; flex-direction: column; gap: 8px; }
  .eff > .banner { margin-bottom: 0; }
  .eff .tile .v { font-size: 14px; overflow-wrap: anywhere; }
  .eff .tile.low { border-color: var(--warn); background: var(--warn-bg); box-shadow: inset 0 0 0 1px var(--warn); }
  .eff .tile.low .v { color: var(--warn); }
  .eff dl.kv { font-size: 12px; }

  @media (max-width: 860px) {
    .pgrid { grid-template-columns: minmax(0, 1fr); }
    .setgrid { grid-template-columns: minmax(0, 1fr); }
    .presets { max-height: 42vh; }
  }
  @media (max-width: 640px) {
    .switches { grid-template-columns: minmax(0, 1fr); }
    .brim-row { flex-wrap: wrap; }
    .prow2 { grid-template-columns: minmax(0, 1fr) 28px; }
    .prow2 > .pctl { grid-column: 1; grid-row: 2; justify-content: stretch; }
    .prow2 > .rst { grid-column: 2; grid-row: 2; }
    .prow2 > .field-error { grid-column: 1 / -1; }
    .rov { text-align: left; }
    .savebar { bottom: 0; border-radius: 12px 12px 0 0; margin-left: -12px; margin-right: -12px; }
    .savebar .reason { flex-basis: 100%; }
    .tab { padding: 8px 2px 10px; font-size: 12.5px; }
    .phead .pacts { width: 100%; }
    /* bed table: fit plate × first/other in a phone width without scrolling */
    fieldset.pgroup { padding: 4px 8px 10px; }
    .btable th[scope=row] { white-space: normal; font-size: 12px; padding-right: 4px; }
    .btable td { padding: 5px 2px; }
    .bwrap { min-width: 0; gap: 2px; }
    .bwrap .dot { display: none; }
    .bcell.ovr .unit-in input { border-color: var(--accent); }
    .bwrap .unit-in.has-unit input { padding: 0 22px 0 6px; }
    .bwrap .unit-in .unit { right: 5px; font-size: 11px; }
    .bwrap .rst { width: 20px; }
    .bcell.low .unit-in::after { display: none; }
  }
`;

let injected = false;

export function injectSettingsStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}
