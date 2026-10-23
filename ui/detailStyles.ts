// Styles for the printer control panel (ui/detail.ts). Injected once at
// open; uses the theme tokens defined in src/page.ts so light/dark follow.

const CSS = `
  .pd-backdrop { position: fixed; inset: 0; background: var(--overlay); z-index: 60; display: flex; justify-content: flex-end; }
  .pd { background: var(--bg); width: min(1180px, 100%); height: 100%; overflow: auto; box-shadow: var(--shadow-lg); border-left: 1px solid var(--border); display: flex; flex-direction: column; animation: pdin .18s ease-out; }
  @keyframes pdin { from { transform: translateX(24px); opacity: 0; } }
  .pd-head { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 18px; display: flex; flex-direction: column; gap: 8px; }
  .pd-head .t { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .pd-head .t > .badge, .pd-head .t > .pill, .pd-head .t > .btn { flex: none; }
  .pd-head h2 { margin: 0; font-size: 16px; font-weight: 650; min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pd-head .t .grow { flex: 1; }
  .pd-head .meta { display: flex; gap: 6px 14px; flex-wrap: wrap; color: var(--text2); font-size: 12px; font-variant-numeric: tabular-nums; }
  .pd-head .meta b { color: var(--text); font-weight: 600; }
  .pd-head .progline { display: flex; align-items: center; gap: 6px 10px; font-size: 12px; color: var(--text2); font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .pd-head .progline .prog { flex: 1 1 160px; }
  .pd-head .pd-file { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40ch; min-width: 0; flex: 0 1 auto; color: var(--text); }
  .pd-body { padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 14px; }
  .pd-body > .banner { margin-bottom: 0; }
  .pd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; align-items: start; }
  .pd-grid .panel.wide { grid-column: 1 / -1; }
  .pd .panel-body { gap: 10px; }
  .pd .panel-head .reason { font-size: 11.5px; }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden; flex-wrap: wrap; }
  .seg button { border: none; background: var(--surface); color: var(--text2); font: inherit; font-size: 12px; font-weight: 550; padding: 0 10px; height: 28px; cursor: pointer; border-right: 1px solid var(--border); }
  .seg button:last-child { border-right: none; }
  .seg button:hover { background: var(--hover); color: var(--text); }
  .seg button[aria-pressed="true"] { background: var(--accent-subtle); color: var(--accent); font-weight: 650; }
  .seg button[disabled] { opacity: .55; cursor: not-allowed; }
  .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .btn.busy { position: relative; color: transparent !important; }
  .btn.busy::after { content: ""; position: absolute; width: 12px; height: 12px; border: 2px solid var(--text3); border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .heater { display: grid; grid-template-columns: 74px minmax(0, 1fr) 92px auto; gap: 8px; align-items: center; }
  .heater .k { font-weight: 600; font-size: 12.5px; }
  .heater .v { font-variant-numeric: tabular-nums; color: var(--text2); white-space: nowrap; }
  .heater .v.hot { color: var(--warn); }
  .heater input { height: 28px; }
  .jog { display: grid; grid-template-columns: repeat(3, 44px) 18px 44px; grid-template-rows: repeat(3, 38px); gap: 6px; }
  .jog .btn { height: 100%; padding: 0; font-variant-numeric: tabular-nums; }
  .fan { display: grid; grid-template-columns: 70px minmax(0, 1fr) 44px; gap: 10px; align-items: center; }
  .fan input[type=range] { width: 100%; accent-color: var(--accent); }
  .fan .v { text-align: right; font-variant-numeric: tabular-nums; color: var(--text2); }
  .trays { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
  .tray { border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px; background: var(--surface2); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tray.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .tray .sw { height: 22px; border-radius: 6px; border: 1px solid var(--border-strong); }
  .tray .sw.empty { background: repeating-linear-gradient(45deg, var(--surface3), var(--surface3) 4px, var(--surface2) 4px, var(--surface2) 8px); }
  .tray .ty { font-weight: 650; font-size: 12.5px; }
  .tray .where { font-size: 11px; color: var(--text3); }
  .tray .badge { align-self: flex-start; color: var(--accent); border-color: var(--accent); background: var(--accent-subtle); }
  .ftable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .ftable th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); font-weight: 650; padding: 4px 6px; border-bottom: 1px solid var(--border); }
  .ftable td { padding: 6px; border-bottom: 1px solid var(--border); vertical-align: middle; font-variant-numeric: tabular-nums; }
  .ftable td.nm { word-break: break-all; font-weight: 550; }
  .ftable td.acts { white-space: nowrap; text-align: right; }
  .ftable td.acts .btn + .btn { margin-left: 4px; }
  .ftable-wrap { max-height: 340px; overflow: auto; }
  .console-log { margin: 0; padding: 6px 8px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 11.5px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .console-log:empty { display: none; }
  .console-log .bad { color: var(--danger); }
  .console-log .ok { color: var(--success); }
  .pd .cam { border-radius: 8px; border: 1px solid var(--border); }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .shot { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface2); display: flex; flex-direction: column; min-width: 0; }
  .shot button.th { border: none; padding: 0; background: var(--surface3); aspect-ratio: 16 / 9; cursor: zoom-in; display: grid; place-items: center; color: var(--text3); font-size: 11px; }
  .shot button.th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .shot .cap { display: flex; align-items: center; gap: 2px; padding: 2px 4px 2px 8px; font-size: 11px; color: var(--text2); }
  .shot .cap .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shot .cap a.btn { padding: 0 6px; }
  .modal.lg { width: min(1100px, 100%); }
  .modal img.full { width: 100%; height: auto; border-radius: 8px; display: block; }
  .errs { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .errs li { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: flex-start; font-size: 12.5px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); }
  .errs li.bad { border-color: var(--danger-border); background: var(--danger-bg); }
  .errs li.warn { border-color: var(--warn-border); background: var(--warn-bg); }
  .errs li .code { font-weight: 650; white-space: nowrap; }
  .errs li .grow { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
  .card[data-id] .card-head .name { cursor: pointer; }
  .card[data-id] .card-head .name:hover { color: var(--accent); text-decoration: underline; }
  .card[data-id] .cam { cursor: pointer; }
  @media (max-width: 640px) {
    .pd { border-left: none; }
    .pd-head { padding: 10px 12px; }
    .pd-body { padding: 12px; }
    .pd-grid { grid-template-columns: minmax(0, 1fr); }
    .heater { grid-template-columns: 64px minmax(0, 1fr) 76px auto; gap: 6px; }
    .pd-head .pd-file { max-width: 45%; }
    .ftable th.dt, .ftable td.dt { display: none; }
  }
`;

let injected = false;

export function injectDetailStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}
