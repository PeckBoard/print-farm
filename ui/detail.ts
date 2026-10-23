// Printer control panel: a drawer opened from a farm card / printer row
// (deep link `#printer/<id>`). GET capabilities decides which groups exist;
// GET detail is polled every ~3s while the drawer is open and the page is
// visible. Every control POSTs printers/:id/control (see ui/control.ts).

import { h, append, clear, icon, btn, toast, errText, confirmDialog, openModal, select } from "./dom";
import { get, post, del, getImage, ApiError } from "./api";
import { printerById, loadPrinters } from "./state";
import { fmtDuration, fmtPercent, fmtTemp, fmtBytes, statePill, TYPE_LABELS } from "./format";
import {
  Capabilities,
  Detail,
  RemoteFile,
  Capture,
  HeaterId,
  FanId,
  SPEED_LEVELS,
  JOG_STEPS,
  TEMP_PRESETS,
  clampTemp,
  isRunning,
  busyReason,
  extrudeReason,
  needsDevBanner,
  cssColor,
  loadChoices,
  toDate,
  newestFirst,
  fmtSignal,
} from "./control";
import { injectDetailStyles } from "./detailStyles";

export interface DetailHandle {
  id: string;
  close(): void;
}

const DEV_MODE_TEXT = "This printer refuses remote commands. On the printer: Settings → enable LAN Only Mode, then Developer Mode.";
const HEATER_LABEL: Record<HeaterId, string> = { nozzle: "Nozzle", bed: "Bed", chamber: "Chamber" };
const FAN_LABEL: Record<FanId, string> = { part: "Part", aux: "Aux", chamber: "Chamber" };

// Raw G-code is confirmed once per page session.
let gcodeConfirmed = false;

type Lockable = HTMLButtonElement | HTMLInputElement | HTMLSelectElement;

export function openPrinterDetail(id: string, onClose: () => void): DetailHandle {
  injectDetailStyles();
  const base = `printers/${encodeURIComponent(id)}`;
  let caps: Capabilities | null = null;
  let d: Detail | null = null;
  let closed = false;
  let devRefused = false;
  let pollTimer = 0;
  let snapTimer = 0;
  let inflight = false;
  const updaters: ((d: Detail) => void)[] = [];
  const locks: { el: Lockable; lock: () => string | null; title: string }[] = [];
  let fileLocks: typeof locks = [];

  // ── shell ────────────────────────────────────────────────────────────
  const titleId = "pd-" + Math.random().toString(36).slice(2);
  const nameEl = h("h2", { id: titleId, text: printerById(id)?.name || id });
  const typeEl = h("span", { class: "badge" });
  const pill = h("span", { class: "pill muted", text: "…" });
  const closeBtn = btn(null, { icon: "x", cls: "ghost", aria: "Close printer controls", onClick: () => close() });
  const meta = h("div", { class: "meta" });
  const progLine = h("div", { class: "progline" });
  progLine.hidden = true;
  const head = h("div", { class: "pd-head" }, h("div", { class: "t" }, nameEl, typeEl, pill, h("div", { class: "grow" }), closeBtn), meta, progLine);
  const bannerHost = h("div");
  const grid = h("div", { class: "pd-grid" });
  const body = h("div", { class: "pd-body" }, bannerHost, grid);
  const drawer = h("aside", { class: "pd", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, head, body);
  const backdrop = h("div", { class: "pd-backdrop" }, drawer);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent) => {
    // A dialog or combobox above the drawer handles its own Esc.
    if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".backdrop, .listbox")) return;
    e.preventDefault();
    close();
  };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  setTimeout(() => closeBtn.focus(), 0);

  for (let i = 0; i < 4; i++) grid.appendChild(h("div", { class: "panel", "aria-hidden": "true" }, h("div", { class: "panel-body" }, h("div", { class: "skel", style: { height: "16px", width: "40%" } }), h("div", { class: "skel", style: { height: "60px" } }))));

  // ── helpers ──────────────────────────────────────────────────────────
  function lockable<T extends Lockable>(el: T, lock: () => string | null, list = locks): T {
    list.push({ el, lock, title: el.title || "" });
    return el;
  }

  function applyLocks() {
    for (const l of locks.concat(fileLocks)) {
      const why = l.lock();
      l.el.disabled = l.el.classList.contains("busy") || !!why;
      l.el.title = why || l.title;
    }
  }

  const offline = () => (d?.state === "offline" ? "The printer is offline." : !d ? "Waiting for printer status…" : null);

  function fail(what: string, e: unknown) {
    if (e instanceof ApiError && e.needsDeveloperMode && !devRefused) {
      devRefused = true;
      renderBanner();
    }
    const hint = e instanceof ApiError ? e.hint : null;
    toast(`${what} failed: ${errText(e)}${hint ? " — " + hint : ""}`, "bad");
  }

  function control(body: Record<string, unknown>) {
    return post<{ ok: boolean; confirmed?: boolean }>(`${base}/control`, body);
  }

  /// Run `work` with `b` showing a busy state; toast the outcome.
  async function act(b: HTMLButtonElement, what: string, work: () => Promise<{ confirmed?: boolean }[] | { confirmed?: boolean } | void>, okMsg?: string): Promise<boolean> {
    b.classList.add("busy");
    b.disabled = true;
    b.setAttribute("aria-busy", "true");
    try {
      const r = await work();
      const rs = Array.isArray(r) ? r : r ? [r] : [];
      const unconfirmed = rs.some((x) => x && x.confirmed === false);
      if (okMsg !== "") toast((okMsg || what + " sent.") + (unconfirmed ? " The printer hasn't confirmed it yet." : ""), "ok");
      pollSoon();
      return true;
    } catch (e) {
      fail(what, e);
      return false;
    } finally {
      b.classList.remove("busy");
      b.removeAttribute("aria-busy");
      b.disabled = false;
      applyLocks();
    }
  }

  function panel(title: string, opts: { wide?: boolean; extra?: Node[] } = {}) {
    const reason = h("span", { class: "reason" });
    const p = h(
      "section",
      { class: "panel" + (opts.wide ? " wide" : ""), "aria-label": title },
      h("div", { class: "panel-head" }, h("h3", { text: title }), reason, ...(opts.extra || [])),
    );
    const b = h("div", { class: "panel-body" });
    p.appendChild(b);
    grid.appendChild(p);
    return { el: p, body: b, reason };
  }

  function seg<T>(label: string, items: { value: T; label: string }[], current: () => T | null, onPick: (v: T, b: HTMLButtonElement) => void, lock?: () => string | null) {
    const el = h("div", { class: "seg", role: "group", "aria-label": label });
    const bs = items.map((it) => {
      const b = h("button", { type: "button", text: it.label, "aria-pressed": "false" }) as HTMLButtonElement;
      b.addEventListener("click", () => onPick(it.value, b));
      if (lock) lockable(b, lock);
      el.appendChild(b);
      return b;
    });
    const sync = () => items.forEach((it, i) => bs[i].setAttribute("aria-pressed", current() === it.value ? "true" : "false"));
    sync();
    return { el, sync };
  }

  function numInput(o: { id: string; min: number; max?: number; step?: number; value?: number; label: string }) {
    const i = h("input", { type: "number", id: o.id, min: String(o.min), max: o.max != null ? String(o.max) : undefined, step: String(o.step || 1), "aria-label": o.label, inputmode: "decimal" }) as HTMLInputElement;
    if (o.value != null) i.value = String(o.value);
    i.addEventListener("input", () => (i.dataset.touched = "1"));
    return i;
  }

  // ── header + banner ──────────────────────────────────────────────────
  function renderHead() {
    const p = printerById(id);
    nameEl.textContent = p?.name || id;
    nameEl.title = p ? p.name + " — " + p.host : id;
    typeEl.textContent = p ? TYPE_LABELS[p.type] || p.type : "";
    typeEl.hidden = !p;
    if (!d) return;
    const pl = statePill(d.state);
    pill.className = "pill " + pl.tone;
    pill.textContent = pl.label;
    clear(meta);
    const m = (k: string, v: string) => h("span", null, k + " ", h("b", { text: v }));
    if (d.wifi_signal != null) meta.appendChild(m("Wi-Fi", fmtSignal(d.wifi_signal)));
    if (d.firmware) meta.appendChild(m("Firmware", d.firmware));
    if (d.developer_mode != null) meta.appendChild(m("Developer mode", d.developer_mode ? "On" : "Off"));
    if (d.message) meta.appendChild(h("span", { class: d.state === "error" ? "field-error" : "", text: d.message }));
    const showProg = isRunning(d.state) || d.state === "finished";
    progLine.hidden = !showProg;
    if (showProg) {
      clear(progLine);
      append(progLine, [
        h("span", { class: "pd-file", title: d.file || "", text: d.file || "Current job" }),
        h(
          "div",
          { class: "prog" + (d.state === "paused" ? " paused" : d.state === "finished" ? " done" : ""), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(d.progress * 100)), "aria-label": "Print progress" },
          h("div", { style: { width: Math.round(d.progress * 1000) / 10 + "%" } }),
        ),
        h("b", { text: fmtPercent(d.progress) }),
        d.layer != null ? h("span", { text: `Layer ${d.layer}${d.total_layers ? " / " + d.total_layers : ""}` }) : null,
        isRunning(d.state) ? h("span", { text: "ETA " + fmtDuration(d.eta_s) }) : null,
      ]);
    }
  }

  function renderBanner() {
    clear(bannerHost);
    if (needsDevBanner(d?.developer_mode, devRefused)) {
      bannerHost.appendChild(
        h("div", { class: "banner warn", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Developer Mode is off" }), h("p", { text: DEV_MODE_TEXT }))),
      );
    }
  }

  // ── sections ─────────────────────────────────────────────────────────
  function build(c: Capabilities) {
    clear(grid);
    const j = c.job;
    if (j.pause || j.resume || j.stop || j.speed_levels || j.speed_percent) jobSection(c);
    if (c.camera) cameraSection();
    if (c.temps.nozzle || c.temps.bed || c.temps.chamber) tempSection(c);
    if (c.motion) motionSection();
    if (c.extrude || c.load_unload) extruderSection(c);
    if (c.fans.length || c.light) fanSection(c);
    if (c.ams) amsSection();
    if (c.files) filesSection();
    if (c.gcode) consoleSection();
    if (c.errors) errorsSection();
    if (!grid.children.length) grid.appendChild(h("div", { class: "empty", style: { gridColumn: "1 / -1" } }, h("h3", { text: "No remote controls" }), h("p", { text: "This printer type doesn't expose any controls Print Farm can drive." })));
  }

  function jobSection(c: Capabilities) {
    const s = panel("Job");
    const row = h("div", { class: "row" });
    if (c.job.pause) {
      const b = lockable(btn("Pause", { icon: "pause" }), () => offline() || (d?.state === "printing" ? null : "Nothing is printing."));
      b.onclick = () => act(b, "Pause", () => control({ action: "pause" }), "Pausing…");
      row.appendChild(b);
    }
    if (c.job.resume) {
      const b = lockable(btn("Resume", { icon: "play", cls: "primary" }), () => offline() || (d?.state === "paused" ? null : "The print isn't paused."));
      b.onclick = () => act(b, "Resume", () => control({ action: "resume" }), "Resuming…");
      row.appendChild(b);
    }
    if (c.job.stop) {
      const b = lockable(btn("Stop", { icon: "stop", cls: "danger" }), () => offline() || (isRunning(d?.state) ? null : "Nothing is printing."));
      b.onclick = async () => {
        const ok = await confirmDialog({
          title: "Stop this print?",
          body: `${printerById(id)?.name || "The printer"} will stop printing ${d?.file || "the current job"}. This can't be undone — the print can't be resumed.`,
          confirm: "Stop print",
          cancel: "Keep printing",
          danger: true,
        });
        if (ok) act(b, "Stop", () => control({ action: "stop" }), "Stopping…");
      };
      row.appendChild(b);
    }
    s.body.appendChild(row);
    if (c.job.speed_levels) {
      const sg = seg(
        "Print speed",
        SPEED_LEVELS.map((l) => ({ value: l.level, label: l.label })),
        () => d?.speed_level ?? null,
        (level, b) => act(b, "Speed", () => control({ action: "speed", level }), `Speed set to ${SPEED_LEVELS[level - 1].label}.`),
        offline,
      );
      s.body.appendChild(h("div", { class: "row" }, h("span", { class: "reason", text: "Speed" }), sg.el));
      updaters.push(sg.sync);
    } else if (c.job.speed_percent) {
      const inp = lockable(numInput({ id: "pd-speed", min: 10, max: 300, step: 5, value: 100, label: "Speed percent" }), offline);
      const set = lockable(btn("Set", { cls: "sm" }), offline);
      set.onclick = () => {
        const percent = Math.max(10, Math.min(300, Math.round(Number(inp.value) || 100)));
        inp.value = String(percent);
        act(set, "Speed", () => control({ action: "speed", percent }), `Speed set to ${percent}%.`);
      };
      s.body.appendChild(h("div", { class: "row" }, h("label", { class: "reason", for: "pd-speed", text: "Speed %" }), h("div", { style: { width: "90px" } }, inp), set));
      updaters.push((x) => {
        if (x.speed_percent != null && document.activeElement !== inp && !inp.dataset.touched) inp.value = String(Math.round(x.speed_percent));
      });
    }
  }

  function tempSection(c: Capabilities) {
    const s = panel("Temperatures");
    const heaters = (["nozzle", "bed", "chamber"] as HeaterId[]).filter((k) => c.temps[k]);
    for (const k of heaters) {
      const max = c.temps[k]!.max;
      const cur = h("span", { class: "v" });
      const inp = lockable(numInput({ id: "pd-t-" + k, min: 0, max, label: HEATER_LABEL[k] + " target °C" }), offline);
      const set = lockable(btn("Set", { cls: "sm", aria: "Set " + HEATER_LABEL[k] + " temperature" }), offline);
      set.onclick = () => {
        const target = clampTemp(Number(inp.value), max);
        inp.value = String(target);
        inp.dataset.touched = "";
        act(set, HEATER_LABEL[k] + " temperature", () => control({ action: "temp", heater: k, target }), `${HEATER_LABEL[k]} target set to ${target} °C.`);
      };
      inp.addEventListener("keydown", (e) => e.key === "Enter" && set.click());
      s.body.appendChild(h("div", { class: "heater" }, h("span", { class: "k", text: HEATER_LABEL[k] }), cur, inp, set));
      updaters.push((x) => {
        const t = x.temps?.[k];
        cur.textContent = fmtTemp(t);
        cur.className = "v" + (t?.target ? " hot" : "");
        cur.title = `max ${max} °C`;
        if (t && document.activeElement !== inp && !inp.dataset.touched) inp.value = String(Math.round(t.target || 0));
      });
    }
    const presets = h("div", { class: "row" }, h("span", { class: "reason", text: "Presets" }));
    for (const p of TEMP_PRESETS) {
      const b = lockable(btn(p.label, { cls: "sm" + (p.label === "Off" ? " ghost" : ""), title: p.label === "Off" ? "Turn every heater off" : `Nozzle ${p.nozzle} °C · Bed ${p.bed} °C` }), offline);
      b.onclick = () => {
        const sends: { heater: HeaterId; target: number }[] = [];
        if (c.temps.nozzle) sends.push({ heater: "nozzle", target: clampTemp(p.nozzle, c.temps.nozzle.max) });
        if (c.temps.bed) sends.push({ heater: "bed", target: clampTemp(p.bed, c.temps.bed.max) });
        if (p.label === "Off" && c.temps.chamber) sends.push({ heater: "chamber", target: 0 });
        for (const x of sends) {
          const inp = s.body.querySelector<HTMLInputElement>("#pd-t-" + x.heater);
          if (inp) {
            inp.value = String(x.target);
            inp.dataset.touched = "";
          }
        }
        act(
          b,
          p.label + " preset",
          async () => {
            const out = [];
            for (const x of sends) out.push(await control({ action: "temp", ...x }));
            return out;
          },
          p.label === "Off" ? "Heaters off." : `${p.label}: ` + sends.map((x) => `${HEATER_LABEL[x.heater]} ${x.target} °C`).join(", ") + ".",
        );
      };
      presets.appendChild(b);
    }
    s.body.appendChild(presets);
  }

  function motionSection() {
    const s = panel("Motion");
    const lock = () => offline() || busyReason(d?.state, "Motion");
    updaters.push(() => (s.reason.textContent = lock() && d ? lock()! : ""));
    let step = 10;
    const steps = seg(
      "Jog step",
      JOG_STEPS.map((v) => ({ value: v, label: v + " mm" })),
      () => step,
      (v) => {
        step = v;
        steps.sync();
      },
    );
    const jog = (axis: "x" | "y" | "z", dir: 1 | -1, label: string, col: number, rowN: number) => {
      const b = lockable(btn(label, { aria: `Jog ${axis.toUpperCase()} ${dir > 0 ? "+" : "−"}`, cls: "sm" }), lock);
      b.style.gridColumn = String(col);
      b.style.gridRow = String(rowN);
      b.onclick = () => act(b, "Jog", () => control({ action: "jog", axis, distance: Math.round(dir * step * 10) / 10 }), "");
      return b;
    };
    const home = lockable(btn(null, { icon: "home", aria: "Home all axes", title: "Home all axes", cls: "sm" }), lock);
    home.style.gridColumn = "2";
    home.style.gridRow = "2";
    home.onclick = () => act(home, "Home", () => control({ action: "home" }), "Homing…");
    const pad = h("div", { class: "jog" }, jog("y", 1, "Y+", 2, 1), jog("x", -1, "X−", 1, 2), home, jog("x", 1, "X+", 3, 2), jog("y", -1, "Y−", 2, 3), jog("z", 1, "Z+", 5, 1), jog("z", -1, "Z−", 5, 3));
    const motors = lockable(btn("Motors off", { cls: "sm" }), lock);
    motors.onclick = () => act(motors, "Motors off", () => control({ action: "motors_off" }), "Motors off.");
    s.body.append(h("div", { class: "row" }, h("span", { class: "reason", text: "Step" }), steps.el), pad, h("div", { class: "row" }, motors));
  }

  function extruderSection(c: Capabilities) {
    const s = panel("Extruder");
    if (c.extrude) {
      const lock = () => offline() || extrudeReason(d);
      const why = h("div", { class: "reason" });
      updaters.push(() => (why.textContent = lock() || ""));
      const mm = lockable(numInput({ id: "pd-mm", min: 1, max: 100, value: 10, label: "Extrude length mm" }), lock);
      const len = () => Math.max(1, Math.min(100, Math.round(Number(mm.value) || 10)));
      const ex = lockable(btn("Extrude", { cls: "sm" }), lock);
      ex.onclick = () => act(ex, "Extrude", () => control({ action: "extrude", mm: len() }), `Extruding ${len()} mm…`);
      const re = lockable(btn("Retract", { cls: "sm" }), lock);
      re.onclick = () => act(re, "Retract", () => control({ action: "extrude", mm: -len() }), `Retracting ${len()} mm…`);
      s.body.append(h("div", { class: "row" }, h("div", { style: { width: "80px" } }, mm), h("span", { class: "reason", text: "mm" }), ex, re), why);
    }
    if (c.load_unload) {
      const lock = () => offline() || busyReason(d?.state, "Changing filament");
      const sel = lockable(select("pd-load", loadChoices(d?.ams || null), "external"), lock);
      sel.setAttribute("aria-label", "Filament source");
      let sig = "";
      let picked = false;
      sel.addEventListener("change", () => (picked = true));
      updaters.push((x) => {
        const ch = loadChoices(x.ams);
        const ns = JSON.stringify(ch);
        if (ns === sig) return;
        sig = ns;
        const keep = sel.value;
        clear(sel);
        for (const o of ch) sel.appendChild(h("option", { value: o.value, text: o.label }));
        sel.value = picked && ch.some((o) => o.value === keep) ? keep : ch[0].value;
      });
      const load = lockable(btn("Load", { cls: "sm primary" }), lock);
      load.onclick = () => {
        const slot = sel.value === "external" ? "external" : Number(sel.value);
        act(load, "Load filament", () => control({ action: "load", slot }), "Loading filament…");
      };
      const unload = lockable(btn("Unload", { cls: "sm" }), lock);
      unload.onclick = () => act(unload, "Unload filament", () => control({ action: "unload" }), "Unloading filament…");
      s.body.append(h("div", { class: "row" }, h("div", { style: { flex: "1", minWidth: "160px" } }, sel), load, unload));
    }
  }

  function fanSection(c: Capabilities) {
    const s = panel(c.fans.length && c.light ? "Fans & light" : c.fans.length ? "Fans" : "Light");
    for (const f of c.fans) {
      const v = h("span", { class: "v", text: "—" });
      const r = lockable(h("input", { type: "range", min: "0", max: "100", step: "5", "aria-label": FAN_LABEL[f] + " fan %" }) as HTMLInputElement, offline);
      let dragging = false;
      r.addEventListener("input", () => {
        dragging = true;
        v.textContent = r.value + "%";
      });
      r.addEventListener("change", async () => {
        const percent = Number(r.value);
        try {
          const res = await control({ action: "fan", fan: f, percent });
          toast(`${FAN_LABEL[f]} fan set to ${percent}%.` + (res.confirmed === false ? " The printer hasn't confirmed it yet." : ""), "ok");
        } catch (e) {
          fail(FAN_LABEL[f] + " fan", e);
        }
        dragging = false;
        pollSoon();
      });
      s.body.appendChild(h("div", { class: "fan" }, h("span", { class: "reason", text: FAN_LABEL[f] }), r, v));
      updaters.push((x) => {
        const p = x.fans?.[f];
        if (dragging) return;
        r.value = String(p ?? 0);
        v.textContent = p == null ? "—" : Math.round(p) + "%";
      });
    }
    if (c.light) {
      const b = lockable(btn("Chamber light", { icon: "sun", cls: "sm" }), offline);
      b.setAttribute("aria-pressed", "false");
      b.onclick = () => {
        const on = d?.light !== "on";
        act(b, "Light", () => control({ action: "light", on }), on ? "Light on." : "Light off.");
      };
      updaters.push((x) => {
        b.setAttribute("aria-pressed", x.light === "on" ? "true" : "false");
        b.classList.toggle("primary", x.light === "on");
        b.lastChild!.textContent = "Chamber light: " + (x.light === "on" ? "on" : x.light === "off" ? "off" : "unknown");
      });
      s.body.appendChild(h("div", { class: "row" }, b));
    }
  }

  function amsSection() {
    const s = panel("AMS", { wide: true });
    const host = h("div", { class: "trays" });
    s.body.appendChild(host);
    let sig = "";
    updaters.push((x) => {
      const ns = JSON.stringify(x.ams);
      if (ns === sig) return;
      sig = ns;
      clear(host);
      if (!x.ams) {
        host.appendChild(h("div", { class: "reason", text: "No AMS reported." }));
        return;
      }
      const tile = (ty: string | null, col: string | null, where: string, active: boolean) => {
        const css = cssColor(col);
        return h(
          "div",
          { class: "tray" + (active ? " active" : "") },
          h("div", { class: "sw" + (css ? "" : " empty"), style: css ? { background: css } : {}, title: col || "empty" }),
          h("span", { class: "ty", text: ty || "Empty" }),
          h("span", { class: "where", text: where }),
          active ? h("span", { class: "badge", text: "Active" }) : null,
        );
      };
      for (const t of x.ams.trays) host.appendChild(tile(t.type, t.color, `AMS ${t.unit + 1} · Slot ${t.tray + 1}`, t.active === true || x.ams.active === t.slot));
      if (x.ams.external) host.appendChild(tile(x.ams.external.type, x.ams.external.color, "External spool", x.ams.active === "external"));
    });
  }

  function filesSection() {
    const refresh = btn(null, { icon: "refresh", cls: "ghost sm", aria: "Refresh files", title: "Refresh" });
    const s = panel("Files on printer", { wide: true, extra: [refresh] });
    const host = h("div", { class: "ftable-wrap" });
    s.body.appendChild(host);
    let files: RemoteFile[] | null = null;
    const lock = () => offline() || busyReason(d?.state, "Starting a print");
    async function load() {
      refresh.classList.add("busy");
      try {
        files = (await get<{ files: RemoteFile[] }>(`${base}/files`)).files || [];
        render();
      } catch (e) {
        clear(host);
        host.appendChild(h("div", { class: "msg", text: "Couldn't list files: " + errText(e) + (e instanceof ApiError && e.hint ? " — " + e.hint : "") }));
        if (e instanceof ApiError && e.needsDeveloperMode && !devRefused) {
          devRefused = true;
          renderBanner();
        }
      }
      refresh.classList.remove("busy");
    }
    function render() {
      clear(host);
      fileLocks = [];
      if (!files) return;
      if (!files.length) {
        host.appendChild(h("div", { class: "empty small", text: "No files on the printer." }));
        return;
      }
      const tb = h("tbody");
      for (const f of files) {
        const pr = lockable(btn("Print", { cls: "sm primary", icon: "play", aria: "Print " + f.name }), lock, fileLocks);
        pr.onclick = () => startPrint(f);
        const rm = lockable(btn(null, { cls: "sm danger", icon: "trash", aria: "Delete " + f.name, title: "Delete" }), offline, fileLocks);
        rm.onclick = async () => {
          const ok = await confirmDialog({ title: "Delete this file?", body: `${f.name} will be deleted from the printer's storage.`, confirm: "Delete", danger: true });
          if (!ok) return;
          await act(rm, "Delete", () => del(`${base}/files?name=${encodeURIComponent(f.name)}`), `Deleted ${f.name}.`);
          load();
        };
        const dt = toDate(f.mtime);
        tb.appendChild(
          h(
            "tr",
            null,
            h("td", { class: "nm", text: f.name }),
            h("td", { text: fmtBytes(f.size) }),
            h("td", { class: "dt", text: dt ? dt.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—" }),
            h("td", { class: "acts" }, pr, rm),
          ),
        );
      }
      host.appendChild(h("table", { class: "ftable" }, h("thead", null, h("tr", null, h("th", { text: "Name" }), h("th", { text: "Size" }), h("th", { class: "dt", text: "Date" }), h("th"))), tb));
      applyLocks();
    }
    function startPrint(f: RemoteFile) {
      const m = openModal("Print from printer storage", { small: true });
      const is3mf = /\.3mf$/i.test(f.name);
      const plate = numInput({ id: "pd-plate", min: 1, max: 64, value: 1, label: "Plate" });
      append(m.body, [
        h("p", { text: `Start printing ${f.name} on ${printerById(id)?.name || "this printer"}?` }),
        is3mf ? h("label", { class: "f", for: "pd-plate" }, h("span", { text: "Plate" }), plate, h("span", { class: "hint", text: "Which plate of the project file to print." })) : null,
        h("p", { text: "Make sure the build plate is clear and the right filament is loaded." }),
      ]);
      const go = btn("Start print", { cls: "primary", icon: "play" });
      go.onclick = async () => {
        const body: Record<string, unknown> = { name: f.name };
        if (is3mf) body.plate = Math.max(1, Math.round(Number(plate.value) || 1));
        const ok = await act(go, "Start print", () => post(`${base}/files/print`, body), `Starting ${f.name}…`);
        if (ok) m.close();
      };
      m.foot.append(btn("Cancel", { onClick: () => m.close() }), go);
    }
    refresh.onclick = load;
    load();
  }

  function consoleSection() {
    const s = panel("Console");
    const lock = () => offline() || busyReason(d?.state, "The console");
    updaters.push(() => (s.reason.textContent = d ? lock() || "" : ""));
    const inp = lockable(h("input", { type: "text", id: "pd-gcode", placeholder: "G-code, e.g. M115", autocomplete: "off", spellcheck: "false", "aria-label": "G-code line", class: "mono" }) as HTMLInputElement, lock);
    const send = lockable(btn("Send", { icon: "send", cls: "sm" }), lock);
    const log = h("pre", { class: "console-log", "aria-live": "polite" });
    const go = async () => {
      const line = inp.value.trim();
      if (!line) return;
      if (!gcodeConfirmed) {
        const ok = await confirmDialog({
          title: "Send raw G-code?",
          body: "G-code goes straight to the printer with no safety checks — a wrong command can crash the head into the bed. You'll only be asked once this session.",
          confirm: "Send",
        });
        if (!ok) return;
        gcodeConfirmed = true;
      }
      const ok = await act(send, "G-code", () => control({ action: "gcode", line }), "");
      log.appendChild(h("div", { class: ok ? "ok" : "bad", text: (ok ? "› " : "✗ ") + line }));
      log.scrollTop = log.scrollHeight;
      if (ok) inp.value = "";
      inp.focus();
    };
    send.onclick = go;
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
    s.body.append(h("div", { class: "row", style: { flexWrap: "nowrap" } }, h("div", { style: { flex: "1", minWidth: "0" } }, inp), send), log);
  }

  function cameraSection() {
    const capture = lockable(btn("Capture still", { icon: "camera", cls: "sm" }), offline);
    const s = panel("Camera", { extra: [capture] });
    const img = h("img", { alt: "" }) as HTMLImageElement;
    img.hidden = true;
    const camMsg = h("div", { class: "nocam" }, icon("camoff"), h("span", { text: "Loading camera…" }));
    const age = h("span", { class: "age" });
    age.hidden = true;
    const gallery = h("div", { class: "gallery" });
    s.body.append(h("div", { class: "cam" }, img, camMsg, age), gallery);
    const urls = new Map<string, string>();
    let noCam = false;

    const setMsg = (t: string) => {
      camMsg.hidden = false;
      (camMsg.lastChild as HTMLElement).textContent = t;
    };
    async function snap() {
      clearTimeout(snapTimer);
      if (closed || noCam) return;
      if (!document.hidden) {
        if (d?.state === "offline") {
          img.hidden = true;
          age.hidden = true;
          setMsg("Printer offline");
        } else {
          try {
            const r = await get<{ content_type: string; data_base64: string }>(`${base}/snapshot`);
            if (closed) return;
            img.src = `data:${r.content_type || "image/jpeg"};base64,${r.data_base64}`;
            img.alt = `Camera view of ${printerById(id)?.name || id}`;
            img.hidden = false;
            camMsg.hidden = true;
            age.hidden = false;
            age.textContent = "live · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          } catch (e) {
            const msg = errText(e);
            if (/no camera/i.test(msg)) {
              noCam = true;
              img.hidden = true;
              age.hidden = true;
              setMsg("No camera configured");
            } else if (img.getAttribute("src")) age.textContent = age.textContent!.replace(/^live/, "last frame");
            else setMsg(/connecting/i.test(msg) ? "Camera connecting… the first frame can take a minute on weak Wi-Fi" : `Camera unavailable: ${msg}`);
          }
        }
      }
      if (!closed) snapTimer = window.setTimeout(snap, 5000);
    }

    async function loadGallery() {
      let caps: Capture[] = [];
      try {
        caps = newestFirst((await get<{ captures: Capture[] }>(`captures?printer=${encodeURIComponent(id)}`)).captures || []);
      } catch (e) {
        clear(gallery);
        gallery.appendChild(h("div", { class: "reason", text: "Couldn't load captures: " + errText(e) }));
        return;
      }
      clear(gallery);
      if (!caps.length) {
        gallery.appendChild(h("div", { class: "reason", style: { gridColumn: "1 / -1" }, text: "No stills yet — Capture still saves the current camera frame." }));
        return;
      }
      for (const c of caps) gallery.appendChild(shot(c));
    }

    function shot(c: Capture): HTMLElement {
      const when = toDate(c.taken_at);
      const label = when ? when.toLocaleString([], { dateStyle: "short", timeStyle: "medium" }) : c.id;
      const th = h("button", { type: "button", class: "th", "aria-label": "Open capture " + label, text: "Loading…" }) as HTMLButtonElement;
      const dl = h("a", { class: "btn ghost sm", "aria-label": "Download capture " + label, title: "Download" }, icon("download")) as HTMLAnchorElement;
      dl.setAttribute("download", `${(printerById(id)?.name || id).replace(/[^\w.-]+/g, "_")}-${c.id}.jpg`);
      const rm = btn(null, { icon: "trash", cls: "ghost sm danger", aria: "Delete capture " + label, title: "Delete" });
      const el = h("div", { class: "shot" }, th, h("div", { class: "cap" }, h("span", { class: "grow", text: label, title: fmtBytes(c.size) }), dl, rm));
      const show = (src: string) => {
        clear(th);
        th.appendChild(h("img", { src, alt: "Capture " + label }));
        dl.href = src;
      };
      const cached = urls.get(c.id);
      if (cached) show(cached);
      else
        getImage(c.url || `captures/${encodeURIComponent(c.id)}`)
          .then((src) => {
            urls.set(c.id, src);
            show(src);
          })
          .catch((e) => {
            th.textContent = "Couldn't load";
            th.title = errText(e);
          });
      th.onclick = () => {
        const src = urls.get(c.id);
        if (!src) return;
        const m = openModal("Capture · " + label);
        m.root.classList.add("lg");
        m.body.appendChild(h("img", { class: "full", src, alt: "Capture " + label }));
        const a = h("a", { class: "btn", href: src }, icon("download"), "Download") as HTMLAnchorElement;
        a.setAttribute("download", dl.getAttribute("download")!);
        m.foot.append(a, btn("Close", { onClick: () => m.close() }));
      };
      rm.onclick = async () => {
        const ok = await confirmDialog({ title: "Delete this capture?", body: `The still taken ${label} will be deleted.`, confirm: "Delete", danger: true });
        if (!ok) return;
        if (await act(rm, "Delete capture", () => del(`captures/${encodeURIComponent(c.id)}`), "Capture deleted.")) {
          urls.delete(c.id);
          loadGallery();
        }
      };
      return el;
    }

    capture.onclick = async () => {
      if (await act(capture, "Capture", () => post(`${base}/capture`), "Still captured.")) loadGallery();
    };
    snap();
    loadGallery();
  }

  function errorsSection() {
    const s = panel("Errors & health", { wide: true });
    const host = h("ul", { class: "errs" });
    s.body.appendChild(host);
    let sig = "";
    updaters.push((x) => {
      const ns = JSON.stringify(x.errors || []);
      if (ns === sig) return;
      sig = ns;
      clear(host);
      if (!x.errors?.length) {
        host.appendChild(h("li", null, icon("check"), h("span", { class: "grow", text: "No errors reported." })));
        return;
      }
      for (const e of x.errors) {
        const sev = String(e.severity || "").toLowerCase();
        const tone = /fatal|serious|error|critical/.test(sev) ? "bad" : /warn/.test(sev) ? "warn" : "";
        host.appendChild(
          h(
            "li",
            { class: tone },
            icon(tone ? "warn" : "info"),
            h("span", { class: "code mono", text: String(e.code) }),
            h("span", { class: "grow", text: e.text || "No description from the printer." }),
            e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", class: "btn ghost sm" }, "Details", icon("ext")) : null,
          ),
        );
      }
    });
  }

  // ── data ─────────────────────────────────────────────────────────────
  function apply(x: Detail) {
    d = x;
    renderHead();
    renderBanner();
    for (const u of updaters) u(x);
    applyLocks();
  }

  async function poll() {
    if (closed || inflight) return;
    inflight = true;
    try {
      const x = await get<Detail>(`${base}/detail`);
      if (!closed) apply(x);
    } catch (e) {
      if (!closed && !d) {
        clear(bannerHost);
        bannerHost.appendChild(h("div", { class: "banner bad", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Couldn't load printer status" }), h("p", { text: errText(e) }))));
      }
    }
    inflight = false;
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (closed || document.hidden) return;
    pollTimer = window.setTimeout(async () => {
      await poll();
      schedule();
    }, 3000);
  }

  function pollSoon() {
    clearTimeout(pollTimer);
    pollTimer = window.setTimeout(async () => {
      await poll();
      schedule();
    }, 600);
  }

  const onVis = () => {
    if (closed) return;
    if (document.hidden) clearTimeout(pollTimer);
    else pollSoon();
  };
  document.addEventListener("visibilitychange", onVis);

  async function init() {
    if (!printerById(id)) await loadPrinters().catch(() => undefined);
    renderHead();
    if (!printerById(id)) {
      clear(grid);
      grid.appendChild(h("div", { class: "empty", style: { gridColumn: "1 / -1" } }, h("h3", { text: "Printer not found" }), h("p", { text: "It may have been removed." })));
      return;
    }
    try {
      caps = await get<Capabilities>(`${base}/capabilities`);
    } catch (e) {
      if (closed) return;
      clear(grid);
      grid.appendChild(
        h(
          "div",
          { class: "banner bad", role: "alert", style: { gridColumn: "1 / -1" } },
          icon("warn"),
          h("div", { class: "grow" }, h("b", { text: "Couldn't load this printer's controls" }), h("p", { text: errText(e) }), h("div", { class: "row" }, btn("Retry", { cls: "sm", icon: "refresh", onClick: init }))),
        ),
      );
      return;
    }
    if (closed) return;
    build(caps);
    await poll();
    applyLocks();
    schedule();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(pollTimer);
    clearTimeout(snapTimer);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVis);
    backdrop.remove();
    onClose();
  }

  init();
  return { id, close };
}
