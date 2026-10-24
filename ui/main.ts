// Print Farm page entry: header with the fleet summary, tabs (Farm / Slice /
// Printers / Profiles / Settings), and the views. See README "UI API" and
// FARM_SETTINGS_API.md for the routes.

import { h, icon } from "./dom";
import { state, OPEN_PRINTER } from "./state";
import { farmView } from "./farm";
import { printersView } from "./printers";
import { sliceView } from "./slice";
import { setupWatch } from "./setup";
import { openPrinterDetail, DetailHandle } from "./detail";
import { injectDetailStyles } from "./detailStyles";
import { injectSettingsStyles } from "./settingsStyles";
import { profilesView } from "./profiles";
import { settingsView } from "./settings";

injectDetailStyles();
injectSettingsStyles();

type Tab = "farm" | "slice" | "printers" | "profiles" | "settings";
const TABS: Tab[] = ["farm", "slice", "printers", "profiles", "settings"];

const app = document.getElementById("app")!;
const summary = h("div", { class: "summary", "aria-live": "polite" });
const tabs: Record<Tab, HTMLButtonElement> = {} as any;
const queueBadge = h("span", { class: "n" });
queueBadge.hidden = true;

const tablist = h("div", { class: "tabs", role: "tablist", "aria-label": "Print Farm sections" });
const labels: [Tab, string][] = [
  ["farm", "Farm"],
  ["slice", "Slice"],
  ["printers", "Printers"],
  ["profiles", "Profiles"],
  ["settings", "Settings"],
];
for (const [id, label] of labels) {
  const b = h("button", { class: "tab", role: "tab", id: "tab-" + id, "aria-controls": "panel-" + id, "aria-selected": "false", tabindex: "-1", type: "button" }, label);
  if (id === "farm") b.appendChild(queueBadge);
  b.addEventListener("click", () => go(id));
  b.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(id);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      go(next);
      tabs[next].focus();
    }
  });
  tabs[id] = b;
  tablist.appendChild(b);
}

const header = h("header", { class: "top" }, h("h1", null, icon("printer"), "Print Farm"), summary, tablist);

const farm = farmView(
  (addNew) => {
    go("printers");
    if (addNew) printers.openAdd();
  },
  (n) => {
    queueBadge.hidden = !n;
    queueBadge.textContent = String(n);
    queueBadge.title = n + " print(s) waiting to start";
    renderSummary();
  },
);
// Setup runs by itself: page load checks (and starts) any install needed.
const setup = setupWatch();
const printers = printersView(() => {
  renderSummary();
  setup.check();
});
const slice = sliceView(
  () => {
    go("printers");
    printers.openAdd();
  },
  () => go("farm"),
);
const profiles = profilesView();
const settings = settingsView();

const panels: Record<Tab, HTMLElement> = {
  farm: h("div", { role: "tabpanel", id: "panel-farm", "aria-labelledby": "tab-farm" }, farm.el),
  slice: h("div", { role: "tabpanel", id: "panel-slice", "aria-labelledby": "tab-slice" }, slice.el),
  printers: h("div", { role: "tabpanel", id: "panel-printers", "aria-labelledby": "tab-printers" }, printers.el),
  profiles: h("div", { role: "tabpanel", id: "panel-profiles", "aria-labelledby": "tab-profiles" }, profiles.el),
  settings: h("div", { role: "tabpanel", id: "panel-settings", "aria-labelledby": "tab-settings" }, settings.el),
};
const main = h("main", null, setup.el, panels.farm, panels.slice, panels.printers, panels.profiles, panels.settings);
app.append(header, main);

let current: Tab | null = null;
function go(t: Tab) {
  if (current === t) return;
  detail?.close();
  if (current === "farm") farm.hide();
  if (current === "slice") slice.hide();
  current = t;
  for (const [id, b] of Object.entries(tabs) as [Tab, HTMLButtonElement][]) {
    const on = id === t;
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
    panels[id].hidden = !on;
  }
  try {
    history.replaceState(null, "", "#" + t);
  } catch (_e) {
    /* sandboxed: ignore */
  }
  if (t === "farm") farm.show();
  else if (t === "slice") slice.show();
  else if (t === "profiles") profiles.show();
  else if (t === "settings") settings.show();
  else printers.show();
}

function renderSummary() {
  const counts: Record<string, number> = {};
  for (const s of state.status.values()) counts[s.state] = (counts[s.state] || 0) + 1;
  summary.replaceChildren();
  if (!state.printers.length) return;
  const item = (n: number, label: string) => h("span", null, h("b", { text: String(n) }), " " + label);
  summary.append(item(state.printers.length, state.printers.length === 1 ? "printer" : "printers"));
  if (counts.printing) summary.append(item(counts.printing, "printing"));
  if (counts.paused) summary.append(item(counts.paused, "paused"));
  if (counts.idle) summary.append(item(counts.idle, "idle"));
  if (counts.error) summary.append(item(counts.error, "error"));
  if (counts.offline) summary.append(item(counts.offline, "offline"));
}
setInterval(renderSummary, 2000);

// Printer control panel: `#printer/<id>` while open, back to the tab after.
let detail: DetailHandle | null = null;
function setHash(h: string) {
  try {
    history.replaceState(null, "", "#" + h);
  } catch (_e) {
    /* sandboxed: ignore */
  }
}
function openDetail(id: string) {
  if (detail?.id === id) return;
  detail?.close();
  const handle = openPrinterDetail(id, () => {
    if (detail === handle) {
      detail = null;
      setHash(current || "farm");
    }
  });
  detail = handle;
  setHash("printer/" + encodeURIComponent(id));
}
window.addEventListener(OPEN_PRINTER, (e) => openDetail((e as CustomEvent<{ id: string }>).detail.id));

const hash = location.hash.slice(1);
const deepPrinter = hash.startsWith("printer/") ? decodeURIComponent(hash.slice(8)) : null;
const initial = ((deepPrinter ? "farm" : hash) || new URLSearchParams(location.search).get("tab") || "farm") as Tab;
go(TABS.indexOf(initial) >= 0 ? initial : "farm");
if (deepPrinter) openDetail(deepPrinter);
setup.check();
