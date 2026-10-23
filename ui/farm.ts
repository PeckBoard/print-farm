// Farm tab: queued prints awaiting a human Start, and a live grid of printer
// cards (state, progress, temps, camera, pause/resume/cancel).
//
// Polling: GET status every ~2s and GET prints every ~6s, only while the page
// is visible and this tab is shown; never overlapping. Camera snapshots
// refresh ~5s, one at a time, only for cards on screen.

import { h, clear, icon, btn, toast, errText, confirmDialog } from "./dom";
import { get, post } from "./api";
import { state, Status, Print, printerById, loadPrinters } from "./state";
import { fmtDuration, fmtPercent, fmtTemp, statePill, controlsFor, TYPE_SHORT, isQueued } from "./format";

interface CardRefs {
  root: HTMLElement;
  pill: HTMLElement;
  img: HTMLImageElement;
  camMsg: HTMLElement;
  age: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  sig: string;
  visible: boolean;
  snapAt: number;
  noCamUntil: number;
  busy: boolean;
}

export interface FarmView {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

export function farmView(goPrinters: (addNew: boolean) => void, onQueueCount: (n: number) => void): FarmView {
  const queueHost = h("div");
  const cardsHost = h("div", { class: "cards", "aria-live": "off" });
  const head = h(
    "div",
    { class: "section-head" },
    h("h2", { text: "Printers" }),
    h("div", { class: "grow" }),
    btn("Manage printers", { cls: "sm", icon: "edit", onClick: () => goPrinters(false) }),
  );
  const errBanner = h("div");
  const el = h("section", { "aria-label": "Farm" }, errBanner, queueHost, head, cardsHost);

  const cards = new Map<string, CardRefs>();
  let active = false;
  let statusTimer = 0;
  let snapTimer = 0;
  let tick = 0;
  let inflight = false;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.id!;
      const c = cards.get(id);
      if (c) c.visible = e.isIntersecting;
    }
  });

  // ── queue ────────────────────────────────────────────────────────────
  let queueSig = "";
  function renderQueue() {
    const q = state.prints.filter((p) => isQueued(p.status));
    onQueueCount(q.length);
    // Rebuild only on change, so keyboard focus on a button survives polls.
    const sig = JSON.stringify([q, q.map((p) => state.status.get(p.printer_id)?.state), state.printers.map((p) => p.name)]);
    if (sig === queueSig) return;
    queueSig = sig;
    clear(queueHost);
    if (!q.length) return;
    queueHost.appendChild(
      h("div", { class: "section-head" }, h("h2", { text: "Waiting for you to start" }), h("span", { class: "badge", text: String(q.length) })),
    );
    const list = h("div", { class: "queue", role: "list" });
    for (const p of q) list.appendChild(queueItem(p));
    queueHost.appendChild(list);
  }

  function queueItem(p: Print): HTMLElement {
    const pr = printerById(p.printer_id);
    const st = state.status.get(p.printer_id);
    const busy = st && (st.state === "printing" || st.state === "paused");
    const start = btn("Start print", { cls: "primary", icon: "play" });
    const dismiss = btn("Dismiss", { cls: "ghost" });
    if (busy) {
      start.disabled = true;
      start.title = `${pr?.name || "The printer"} is busy — wait for the current print to finish.`;
    }
    start.onclick = async () => {
      const ok = await confirmDialog({
        title: "Start this print?",
        body: h(
          "div",
          { class: "stack" },
          h("p", { text: `This will start the printer “${pr?.name || p.printer_id}” printing ${p.remote_name}.` }),
          h("p", { text: "Make sure the build plate is clear and the right filament is loaded." }),
        ),
        confirm: "Start print",
      });
      if (!ok) return;
      start.disabled = true;
      try {
        await post(`prints/${encodeURIComponent(p.id)}/start`);
        toast(`Started ${p.remote_name} on ${pr?.name || p.printer_id}.`, "ok");
      } catch (e) {
        toast("Couldn't start the print: " + errText(e), "bad");
      }
      refreshPrints();
      pollNow();
    };
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      try {
        await post(`prints/${encodeURIComponent(p.id)}/dismiss`);
      } catch (e) {
        toast("Couldn't dismiss: " + errText(e), "bad");
      }
      refreshPrints();
    };
    return h(
      "div",
      { class: "qitem", role: "listitem" },
      icon("layers"),
      h(
        "div",
        { class: "what" },
        h("b", { text: p.remote_name }),
        h(
          "div",
          { class: "sub" },
          h("span", { text: "on " + (pr?.name || p.printer_id) }),
          h("span", { class: "badge", text: p.requested_by === "agent" ? (p.status === "awaiting_confirmation" ? "Agent request" : "From an agent") : "Uploaded here" }),
          busy ? h("span", { class: "reason", text: "Printer is busy" }) : null,
        ),
      ),
      dismiss,
      start,
    );
  }

  // ── cards ────────────────────────────────────────────────────────────
  function skeletons() {
    clear(cardsHost);
    for (let i = 0; i < 3; i++) {
      cardsHost.appendChild(
        h(
          "div",
          { class: "card", "aria-hidden": "true" },
          h("div", { class: "card-head" }, h("div", { class: "skel", style: { width: "45%", height: "16px" } })),
          h("div", { class: "cam skel", style: { borderRadius: "0" } }),
          h(
            "div",
            { class: "card-body" },
            h("div", { class: "skel", style: { width: "70%", height: "14px" } }),
            h("div", { class: "skel", style: { height: "8px" } }),
            h("div", { class: "skel", style: { width: "90%", height: "28px" } }),
          ),
        ),
      );
    }
  }

  function emptyState() {
    clear(cardsHost);
    cardsHost.appendChild(
      h(
        "div",
        { class: "empty", style: { gridColumn: "1 / -1" } },
        h("div", { class: "ico" }, icon("printer")),
        h("h3", { text: "No printers yet" }),
        h("p", { text: "Add a Klipper/Moonraker, OctoPrint, PrusaLink or Bambu Lab printer to see its status, camera and controls here." }),
        btn("Add a printer", { cls: "primary", icon: "plus", onClick: () => goPrinters(true) }),
      ),
    );
  }

  function makeCard(id: string): CardRefs {
    const pill = h("span", { class: "pill muted", text: "…" });
    const img = h("img", { alt: "" }) as HTMLImageElement;
    img.hidden = true;
    const camMsg = h("div", { class: "nocam" }, icon("camoff"), h("span", { text: "Loading camera…" }));
    const age = h("span", { class: "age" });
    age.hidden = true;
    const body = h("div", { class: "card-body" });
    const foot = h("div", { class: "card-foot" });
    const nameEl = h("div", { class: "name" });
    const typeEl = h("span", { class: "badge" });
    const root = h(
      "article",
      { class: "card", "data-id": id, "aria-labelledby": "card-" + id },
      h("div", { class: "card-head" }, nameEl, typeEl, pill),
      h("div", { class: "cam" }, img, camMsg, age),
      body,
      foot,
    );
    nameEl.id = "card-" + id;
    const refs: CardRefs = { root, pill, img, camMsg, age, body, foot, sig: "", visible: false, snapAt: 0, noCamUntil: 0, busy: false };
    (refs as any).nameEl = nameEl;
    (refs as any).typeEl = typeEl;
    io.observe(root);
    return refs;
  }

  function renderCards() {
    if (!state.statusLoaded) {
      if (!cardsHost.querySelector(".card[aria-hidden]")) skeletons();
      return;
    }
    if (!state.printers.length) {
      cards.forEach((c) => io.unobserve(c.root));
      cards.clear();
      // Keep the existing empty state (and keyboard focus on its button).
      if (!cardsHost.querySelector(".empty")) emptyState();
      return;
    }
    // Drop skeleton / empty placeholders.
    for (const child of Array.from(cardsHost.children)) if (!(child as HTMLElement).dataset.id) child.remove();
    const ids = state.printers.map((p) => p.id);
    for (const [id, c] of cards) {
      if (ids.indexOf(id) < 0) {
        io.unobserve(c.root);
        c.root.remove();
        cards.delete(id);
      }
    }
    ids.forEach((id, i) => {
      let c = cards.get(id);
      if (!c) {
        c = makeCard(id);
        cards.set(id, c);
      }
      if (cardsHost.children[i] !== c.root) cardsHost.insertBefore(c.root, cardsHost.children[i] || null);
      updateCard(c, id);
    });
  }

  function updateCard(c: CardRefs, id: string) {
    const p = printerById(id)!;
    const s: Status = state.status.get(id) || { state: "offline", progress: 0, file: null, elapsed_s: null, eta_s: null, layer: null, total_layers: null, temps: {}, message: "No status yet" };
    const sig = JSON.stringify([p.name, p.type, s]);
    const footSig = JSON.stringify([p.name, s.state, s.file, c.busy]);
    const footChanged = footSig !== (c as any).footSig;
    if (sig === c.sig && !footChanged) return;
    c.sig = sig;
    (c as any).footSig = footSig;
    (c as any).nameEl.textContent = p.name;
    (c as any).nameEl.title = p.name + " — " + p.host;
    (c as any).typeEl.textContent = TYPE_SHORT[p.type] || p.type;
    const pill = statePill(s.state);
    c.pill.className = "pill " + pill.tone;
    c.pill.textContent = pill.label;
    c.root.className = "card state-" + s.state;

    clear(c.body);
    const active = s.state === "printing" || s.state === "paused";
    c.body.appendChild(h("div", { class: "file-line" + (s.file ? "" : " none"), title: s.file || "", text: s.file || (s.state === "offline" ? "Not reachable" : "No active print") }));
    if (active || s.state === "finished") {
      const bar = h("div", { class: "prog" + (s.state === "paused" ? " paused" : s.state === "finished" ? " done" : ""), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(s.progress * 100)), "aria-label": "Print progress" }, h("div", { style: { width: Math.round(s.progress * 1000) / 10 + "%" } }));
      c.body.appendChild(bar);
      c.body.appendChild(
        h(
          "div",
          { class: "stats" },
          stat("Progress", fmtPercent(s.progress)),
          stat("Layer", s.layer != null ? (s.total_layers ? `${s.layer} / ${s.total_layers}` : String(s.layer)) : "—"),
          stat(s.state === "finished" ? "Took" : "Elapsed", fmtDuration(s.elapsed_s)),
          active ? stat("Remaining", fmtDuration(s.eta_s)) : null,
        ),
      );
    }
    const temps = h("div", { class: "temps" });
    const t = s.temps || {};
    if (t.nozzle) temps.appendChild(tempChip("Nozzle", t.nozzle));
    if (t.bed) temps.appendChild(tempChip("Bed", t.bed));
    if (t.chamber) temps.appendChild(tempChip("Chamber", t.chamber));
    if (temps.children.length) c.body.appendChild(temps);
    if (s.message) c.body.appendChild(h("div", { class: "msg" + (s.state === "error" || s.state === "offline" ? "" : " soft"), text: s.message }));

    if (!footChanged) return;
    clear(c.foot);
    const ctl = controlsFor(s.state);
    const act = (action: "pause" | "resume" | "cancel") => async () => {
      if (action === "cancel") {
        const ok = await confirmDialog({
          title: "Cancel this print?",
          body: `${p.name} will stop printing ${s.file || "the current job"}. This can't be undone — the print can't be resumed.`,
          confirm: "Cancel print",
          cancel: "Keep printing",
          danger: true,
        });
        if (!ok) return;
      }
      c.busy = true;
      updateCard(c, id);
      try {
        await post(`printers/${encodeURIComponent(id)}/control`, { action });
        toast(action === "pause" ? `Pausing ${p.name}…` : action === "resume" ? `Resuming ${p.name}…` : `Cancelling ${p.name}…`, "ok");
      } catch (e) {
        toast(`Couldn't ${action} ${p.name}: ${errText(e)}`, "bad");
      }
      c.busy = false;
      c.sig = "";
      (c as any).footSig = "";
      pollNow();
    };
    if (ctl.pause) c.foot.appendChild(btn("Pause", { icon: "pause", cls: "sm", disabled: c.busy, onClick: act("pause") }));
    if (ctl.resume) c.foot.appendChild(btn("Resume", { icon: "play", cls: "sm primary", disabled: c.busy, onClick: act("resume") }));
    if (ctl.cancel) c.foot.appendChild(btn("Cancel", { icon: "stop", cls: "sm danger", disabled: c.busy, onClick: act("cancel") }));
    if (!ctl.pause && !ctl.resume && !ctl.cancel) c.foot.appendChild(h("span", { class: "reason", text: s.state === "offline" ? "Check the address and that the printer is on." : s.state === "error" ? "Resolve the error on the printer." : "Ready for a new print." }));
  }

  function stat(k: string, v: string) {
    return h("div", { class: "stat" }, h("div", { class: "k", text: k }), h("div", { class: "v", text: v, title: v }));
  }
  function tempChip(k: string, t: { actual: number; target: number | null }) {
    const hot = !!t.target && t.target > 0;
    return h("span", { class: "temp" + (hot ? " hot" : ""), title: `${k}: ${fmtTemp(t)}` }, h("span", { class: "k", text: k }), h("span", { class: "v", text: fmtTemp(t) }));
  }

  // ── polling ──────────────────────────────────────────────────────────
  async function refreshPrints() {
    try {
      const r = await get<{ prints: Print[] }>("prints");
      state.prints = r.prints;
    } catch (_e) {
      /* keep last */
    }
    if (active) renderQueue();
  }

  async function pollStatus() {
    if (inflight) return;
    inflight = true;
    try {
      if (!state.printersLoaded || tick % 15 === 0) await loadPrinters();
      const r = await get<{ printers: { id: string; status: Status }[] }>("status");
      state.status = new Map(r.printers.map((x) => [x.id, x.status]));
      state.statusLoaded = true;
      clear(errBanner);
      if (tick % 3 === 0) await refreshPrints();
    } catch (e) {
      clear(errBanner);
      errBanner.appendChild(
        h("div", { class: "banner bad", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Couldn't load printer status" }), h("p", { text: errText(e) }))),
      );
      if (!state.statusLoaded) {
        state.statusLoaded = true;
      }
    }
    tick++;
    inflight = false;
    if (active) {
      renderCards();
      renderQueue();
    }
  }

  function schedule() {
    clearTimeout(statusTimer);
    if (!active || document.hidden) return;
    statusTimer = window.setTimeout(async () => {
      await pollStatus();
      schedule();
    }, 2000);
  }

  function pollNow() {
    clearTimeout(statusTimer);
    pollStatus().then(schedule);
  }

  async function snapLoop() {
    clearTimeout(snapTimer);
    if (!active || document.hidden) return;
    const now = Date.now();
    for (const [id, c] of cards) {
      if (!active || document.hidden) break;
      if (!c.visible || now - c.snapAt < 5000 || now < c.noCamUntil) continue;
      const s = state.status.get(id);
      if (s && s.state === "offline") {
        c.img.hidden = true;
        c.age.hidden = true;
        setCamMsg(c, "Printer offline");
        c.snapAt = now;
        continue;
      }
      c.snapAt = now;
      try {
        const r = await get<{ content_type: string; data_base64: string }>(`printers/${encodeURIComponent(id)}/snapshot`);
        c.img.src = `data:${r.content_type || "image/jpeg"};base64,${r.data_base64}`;
        c.img.alt = `Camera view of ${printerById(id)?.name || id}`;
        c.img.hidden = false;
        c.camMsg.hidden = true;
        c.age.hidden = false;
        c.age.textContent = "live · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch (e) {
        const msg = errText(e);
        c.img.hidden = true;
        c.age.hidden = true;
        if (/no camera/i.test(msg)) {
          c.noCamUntil = Date.now() + 60000;
          setCamMsg(c, "No camera configured");
        } else setCamMsg(c, "Camera unavailable");
      }
    }
    snapTimer = window.setTimeout(snapLoop, 1000);
  }

  function setCamMsg(c: CardRefs, text: string) {
    c.camMsg.hidden = false;
    (c.camMsg.lastChild as HTMLElement).textContent = text;
  }

  document.addEventListener("visibilitychange", () => {
    if (!active) return;
    if (document.hidden) {
      clearTimeout(statusTimer);
      clearTimeout(snapTimer);
    } else {
      pollNow();
      snapLoop();
    }
  });

  return {
    el,
    show() {
      active = true;
      renderCards();
      renderQueue();
      pollNow();
      setTimeout(snapLoop, 300);
    },
    hide() {
      active = false;
      clearTimeout(statusTimer);
      clearTimeout(snapTimer);
    },
  };
}
