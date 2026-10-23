// Zero-touch setup banner: GET setup starts any install Print Farm needs
// (OrcaSlicer + its profiles, print-bridge) and reports progress; this polls
// it while something runs, shows a non-blocking banner, and fires SETUP_DONE
// when an install finishes so the views reload profiles / the bridge state.

import { h, icon, btn, toast, errText } from "./dom";
import { get, post } from "./api";
import { state, Setup, SetupItem, SETUP_DONE, SETUP_CHANGED, resetProfileCache } from "./state";
import { fmtBytes } from "./format";

const LABEL: Record<"orca" | "bridge", string> = { orca: "OrcaSlicer", bridge: "print-bridge" };
const POLL_MS = 2000;

function phaseText(name: "orca" | "bridge", s: SetupItem): string {
  const size = s.total ? ` (downloading ~${Math.max(1, Math.round(s.total / 1048576))} MB)` : "";
  switch (s.phase) {
    case "download":
      return s.total && s.bytes ? `Downloading — ${fmtBytes(s.bytes)} of ${fmtBytes(s.total)}` : "Downloading…";
    case "extract":
      return "Unpacking the AppImage…";
    case "install":
      return "Installing…";
    case "start":
      return "Starting the service…";
    case "resolve":
      return "Finding the latest release…";
    default:
      return name === "orca" ? `Starting${size}…` : "Starting…";
  }
}

function itemBanner(name: "orca" | "bridge", s: SetupItem, retry: (n: "orca" | "bridge") => void): HTMLElement | null {
  const what = LABEL[name];
  if (s.status === "running") {
    const size = s.total ? ` (downloading ~${Math.max(1, Math.round(s.total / 1048576))} MB)` : "";
    const pct = s.total && s.bytes ? Math.min(100, Math.round((s.bytes / s.total) * 100)) : null;
    const bar = h("div", { class: "prog" + (pct === null || s.phase !== "download" ? " indet" : "") }, h("div", { style: { width: (pct ?? 35) + "%" } }));
    return h(
      "div",
      { class: "banner info", role: "status", "data-setup": name },
      icon("refresh"),
      h(
        "div",
        { class: "grow" },
        h("b", { text: `Setting up ${what}…${size}` }),
        h("p", {
          text:
            (name === "orca"
              ? "Print Farm is installing OrcaSlicer and its printer profiles for you. Everything else keeps working meanwhile. "
              : "Print Farm is installing the print-bridge helper Bambu printers need. ") + phaseText(name, s),
        }),
        h("div", { class: "row", style: { marginTop: "8px" } }, h("div", { style: { flex: "1" } }, bar)),
      ),
    );
  }
  if (s.status === "failed") {
    const manual = name === "bridge" && s.no_systemd;
    return h(
      "div",
      { class: "banner " + (manual ? "warn" : "bad"), role: "alert", "data-setup": name },
      icon("warn"),
      h(
        "div",
        { class: "grow" },
        h("b", { text: manual ? "print-bridge can't run as a service on this host" : `Couldn't set up ${what}` }),
        h("p", { text: s.error || "The installer failed." }),
        manual
          ? h("p", {
              text:
                "Start it by hand instead: download print-bridge from github.com/PeckBoard/print-bridge/releases and run " +
                "print-bridge --bind 127.0.0.1:7781 --token-file ~/.config/print-bridge/token",
            })
          : null,
        s.log_tail
          ? h("details", { class: "log" }, h("summary", { text: "Installer log" }), h("pre", { text: s.log_tail }))
          : null,
        h("div", { class: "row" }, btn("Retry", { cls: "sm primary", icon: "refresh", onClick: () => retry(name) })),
      ),
    );
  }
  return null;
}

export interface SetupWatch {
  el: HTMLElement;
  check(): Promise<void>;
}

export function setupWatch(): SetupWatch {
  const el = h("div", { class: "setup", "aria-live": "polite" });
  let timer = 0;
  let prev: Setup | null = null;

  const render = () => {
    const s = state.setup;
    el.replaceChildren();
    if (!s) return;
    const o = itemBanner("orca", s.orca, retry);
    const b = s.bridge ? itemBanner("bridge", s.bridge, retry) : null;
    if (o) el.appendChild(o);
    if (b) el.appendChild(b);
  };

  const apply = (s: Setup) => {
    const was = prev;
    prev = s;
    state.setup = s;
    for (const n of s.notices || []) toast(n, "ok", 8000);
    let done = false;
    if (was?.orca.status === "running" && s.orca.status === "ok") {
      toast("OrcaSlicer is ready — its printer profiles are available now.", "ok");
      resetProfileCache();
      done = true;
    }
    if (was?.bridge?.status === "running" && s.bridge?.status === "ok") {
      toast("print-bridge is installed and running.", "ok");
      done = true;
    }
    render();
    window.dispatchEvent(new Event(SETUP_CHANGED));
    if (done) window.dispatchEvent(new Event(SETUP_DONE));
    clearTimeout(timer);
    if (s.orca.status === "running" || s.bridge?.status === "running") timer = window.setTimeout(check, POLL_MS);
  };

  async function check(): Promise<void> {
    try {
      apply(await get<Setup>("setup"));
    } catch (_e) {
      // Transient (plugin reloading): try again a little later.
      clearTimeout(timer);
      timer = window.setTimeout(check, POLL_MS * 5);
    }
  }

  async function retry(name: "orca" | "bridge") {
    try {
      const s = await post<Setup>(`setup/${name}/retry`);
      // A retry that starts counts as "running" for the done transition.
      apply(s);
    } catch (e) {
      toast(`Couldn't restart the ${LABEL[name]} setup: ` + errText(e), "bad");
    }
  }

  return { el, check };
}
