// Printers tab: list with Edit / Test connection / Remove, and the add/edit
// form (type-specific fields, saved-secret state, Orca default profiles).

import { h, clear, icon, btn, toast, errText, confirmDialog, openModal, field, select } from "./dom";
import { get, post, put, del } from "./api";
import { state, Printer, Diagnostics, loadPrinters, SETUP_DONE, openPrinter } from "./state";
import { TYPE_LABELS, TYPE_SHORT } from "./format";
import { PrinterDraft, validatePrinter, printerBody } from "./validate";
import { profilePicker } from "./profilePicker";

const DEFAULT_PORT: Record<string, string> = { moonraker: "7125", octoprint: "80", prusalink: "80", bambu: "" };
const HOST_HINT: Record<string, string> = {
  moonraker: "IP or hostname of the Klipper host, e.g. 192.168.1.40 or voron.local",
  octoprint: "OctoPrint address, e.g. octopi.local or https://octopi.local",
  prusalink: "The printer's IP address (printer screen → Settings → Network)",
  bambu: "The printer's LAN IP address (printer screen → Settings → Network)",
};
const BAMBU_MODELS = ["", "X1C", "X1E", "X1", "P1S", "P1P", "A1", "A1 mini", "H2D"];

const LAN_NOTE =
  "Bambu printers must be in LAN Only Mode (and Developer Mode on recent firmware); copy the access code from the printer's network settings.";

/// print-bridge status banner (null until the bridge has been probed). The
/// bridge installs itself (see setup.ts) — this only reports. `adding` = the
/// add-printer form, before any Bambu printer exists to trigger the install.
export function bridgeBanner(b: Diagnostics["bridge"] | undefined, recheck?: () => void, adding = false): HTMLElement | null {
  if (!b) return null;
  if (b.reachable) {
    const v = b.version ? " " + (b.version.startsWith("v") ? b.version : "v" + b.version) : "";
    return h("div", { class: "banner ok", role: "status" }, icon("check"), h("div", { class: "grow" }, h("b", { text: "Bridge connected" + v }), h("p", { text: LAN_NOTE })));
  }
  const setup = state.setup?.bridge;
  if (setup?.status === "running" || (adding && !b.auth_failed)) {
    return h(
      "div",
      { class: "banner info", role: "status" },
      icon("info"),
      h(
        "div",
        { class: "grow" },
        h("b", { text: setup?.status === "running" ? "Setting up print-bridge…" : "print-bridge is set up automatically" }),
        h("p", { text: "Bambu printers are reached through the print-bridge helper; Print Farm installs and starts it for you as soon as a Bambu printer is added. " + LAN_NOTE }),
      ),
    );
  }
  return h(
    "div",
    { class: "banner warn", role: "status" },
    icon("warn"),
    h(
      "div",
      { class: "grow" },
      h("b", { text: "print-bridge isn't answering" }),
      h("p", { text: b.error || "print-bridge isn't reachable." }),
      h("p", { text: LAN_NOTE }),
      recheck ? h("div", { class: "row" }, btn("Check again", { cls: "sm", icon: "refresh", onClick: recheck })) : null,
    ),
  );
}

export interface PrintersView {
  el: HTMLElement;
  show(): void;
  openAdd(): void;
}

export function printersView(onChanged: () => void): PrintersView {
  const list = h("div", { class: "plist" });
  const add = btn("Add printer", { cls: "primary", icon: "plus", onClick: () => openForm(null) });
  const el = h(
    "section",
    { "aria-label": "Printers" },
    h("div", { class: "section-head" }, h("h2", { text: "Printers" }), h("div", { class: "grow" }), add),
    list,
  );
  const tests = new Map<string, { ok: boolean | null; detail: string }>();

  function render() {
    clear(list);
    if (!state.printersLoaded) {
      for (let i = 0; i < 2; i++) list.appendChild(h("div", { class: "prow" }, h("div", { class: "skel", style: { height: "34px", gridColumn: "1 / -1" } })));
      return;
    }
    if (!state.printers.length) {
      list.appendChild(
        h(
          "div",
          { class: "empty" },
          h("div", { class: "ico" }, icon("printer")),
          h("h3", { text: "Add your first printer" }),
          h("p", { text: "Print Farm talks to Klipper (Moonraker), OctoPrint and PrusaLink directly, and to Bambu Lab printers through the local print-bridge." }),
          btn("Add printer", { cls: "primary", icon: "plus", onClick: () => openForm(null) }),
        ),
      );
      return;
    }
    for (const p of state.printers) list.appendChild(row(p));
  }

  async function loadDiagnostics(probeBridge = false): Promise<void> {
    try {
      state.diagnostics = await get<Diagnostics>(probeBridge ? "diagnostics?bridge=1" : "diagnostics");
    } catch (_e) {
      /* the bridge banner just stays hidden */
    }
  }

  function row(p: Printer): HTMLElement {
    const t = tests.get(p.id);
    const defaults = [p.orca_printer_profile, p.orca_filament_profile, p.orca_process_profile].filter(Boolean).join(" · ");
    const testBtn = btn(t && t.ok === null ? "Testing…" : "Test connection", { cls: "sm", icon: "plug", disabled: t?.ok === null });
    testBtn.onclick = () => runTest(p);
    return h(
      "div",
      { class: "prow", "data-id": p.id },
      h("div", { class: "t" }, h("b", { text: p.name }), h("span", { class: "badge", text: TYPE_LABELS[p.type] || p.type })),
      h(
        "div",
        { class: "sub" },
        h("span", { class: "mono", text: p.host + (p.port ? ":" + p.port : "") }),
        p.bambu
          ? h("span", {
              text: "Serial " + p.bambu.serial + (p.bambu.serial_corrected_from ? ` (corrected from ${p.bambu.serial_corrected_from})` : "") + (p.bambu.model ? " · " + p.bambu.model : ""),
              title: p.bambu.serial_corrected_from ? "print-bridge read the real serial off the printer, so Print Farm switched to it." : undefined,
            })
          : null,
        h("span", { class: defaults ? "" : "muted", text: defaults ? "Defaults: " + defaults : "Default slicing profiles are picked once OrcaSlicer's profiles are available" }),
      ),
      h(
        "div",
        { class: "acts" },
        btn("Controls", { cls: "sm", icon: "sliders", aria: "Open controls for " + p.name, onClick: () => openPrinter(p.id) }),
        testBtn,
        btn("Edit", { cls: "sm", icon: "edit", aria: "Edit " + p.name, onClick: () => openForm(p) }),
        btn("Remove", { cls: "sm danger", icon: "trash", aria: "Remove " + p.name, onClick: () => remove(p) }),
      ),
      t ? h("div", { class: "testres " + (t.ok === null ? "run" : t.ok ? "ok" : "bad"), role: "status", text: t.ok === null ? "Connecting… (up to 40 s)" : (t.ok ? "Connected — " : "Failed — ") + t.detail }) : null,
      // Only when the automatic setup isn't already showing the bridge state.
      p.type === "bambu" && state.diagnostics?.bridge && !state.diagnostics.bridge.reachable && (!state.setup?.bridge || state.setup.bridge.status === "ok")
        ? h("div", { class: "pbanner" }, bridgeBanner(state.diagnostics.bridge, () => loadDiagnostics().then(render)))
        : null,
    );
  }

  async function runTest(p: Printer) {
    tests.set(p.id, { ok: null, detail: "" });
    render();
    try {
      const r = await post<{ ok: boolean; detail: string; serial_corrected?: boolean }>(`printers/${encodeURIComponent(p.id)}/test`);
      tests.set(p.id, { ok: r.ok, detail: r.detail || "" });
      if (r.serial_corrected) await refresh();
    } catch (e) {
      tests.set(p.id, { ok: false, detail: errText(e) });
    }
    render();
  }

  async function remove(p: Printer) {
    const ok = await confirmDialog({
      title: `Remove ${p.name}?`,
      body: "Print Farm forgets this printer and its saved credentials. Nothing on the printer itself is changed.",
      confirm: "Remove printer",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`printers/${encodeURIComponent(p.id)}`);
      toast(`Removed ${p.name}.`, "ok");
    } catch (e) {
      toast("Couldn't remove the printer: " + errText(e), "bad");
    }
    await refresh();
    onChanged();
  }

  async function refresh() {
    try {
      await loadPrinters();
    } catch (e) {
      toast("Couldn't load printers: " + errText(e), "bad");
    }
    render();
  }

  // ── form ─────────────────────────────────────────────────────────────
  function openForm(existing: Printer | null) {
    const d: PrinterDraft = {
      name: existing?.name || "",
      type: existing?.type || "moonraker",
      host: existing?.host || "",
      port: existing?.port ? String(existing.port) : "",
      api_key: "",
      username: existing?.username || "",
      password: "",
      storage: existing?.storage || "",
      tls_insecure: !!existing?.tls_insecure,
      serial: existing?.bambu?.serial || "",
      access_code: "",
      model: existing?.bambu?.model || "",
      orca_printer_profile: existing?.orca_printer_profile || "",
      orca_filament_profile: existing?.orca_filament_profile || "",
      orca_process_profile: existing?.orca_process_profile || "",
      clear: {},
    };
    let touched = false;
    let saving = false;
    const m = openModal(existing ? `Edit ${existing.name}` : "Add printer");
    const fields: Record<string, ReturnType<typeof field>> = {};
    const typeSel = select(
      "pf-type",
      ["moonraker", "octoprint", "prusalink", "bambu"].map((t) => ({ value: t, label: TYPE_LABELS[t] })),
      d.type,
      (v) => {
        d.type = v;
        renderTypeFields();
        validate();
      },
    );
    if (existing) {
      typeSel.disabled = true;
      typeSel.title = "The printer type can't change — remove it and add it again instead.";
    }
    const text = (key: keyof PrinterDraft, id: string, opts: { type?: string; placeholder?: string; autocomplete?: string; inputmode?: string } = {}) => {
      const i = h("input", { type: opts.type || "text", id, placeholder: opts.placeholder, autocomplete: opts.autocomplete || "off", inputmode: opts.inputmode, spellcheck: "false" }) as HTMLInputElement;
      i.value = String(d[key] ?? "");
      i.addEventListener("input", () => {
        (d as any)[key] = i.value;
        validate();
      });
      i.addEventListener("blur", () => {
        touched = true;
        validate();
      });
      return i;
    };
    const nameIn = text("name", "pf-name", { placeholder: "e.g. Voron 2.4 (leave blank to use the address)" });
    const hostIn = text("host", "pf-host");
    const portIn = text("port", "pf-port", { inputmode: "numeric" });
    fields.name = field("Name", nameIn, { forId: "pf-name" });
    fields.type = field("Type", typeSel, { forId: "pf-type" });
    fields.host = field("Address", hostIn, { forId: "pf-host" });
    fields.port = field("Port", portIn, { forId: "pf-port", hint: "Optional" });
    const typeHost = h("div", { class: "stack" });
    // Above the fields: blur validation adds errors there, and a banner below
    // them would shift mid-click (mousedown blurs, mouseup misses the button).
    const bridgeHost = h("div");
    const tlsBox = h("input", { type: "checkbox", id: "pf-tls", checked: d.tls_insecure }) as HTMLInputElement;
    tlsBox.addEventListener("change", () => (d.tls_insecure = tlsBox.checked));
    const tlsRow = h("label", { class: "check", for: "pf-tls" }, tlsBox, "Accept a self-signed HTTPS certificate");

    const secretInput = (key: "api_key" | "password" | "access_code", id: string, label: string, saved: boolean, hint?: string) => {
      const inp = text(key, id, { type: "password", autocomplete: "new-password", placeholder: saved ? "Leave blank to keep" : "" });
      const wrap = h("div", { class: "secret-wrap" }, inp);
      const badge = h("span", { class: "saved", text: "saved" });
      const clearable = key !== "access_code";
      let clearBtn: HTMLButtonElement | null = null;
      if (saved) wrap.appendChild(badge);
      const f = field(label, wrap, { forId: id, hint });
      if (saved && clearable) {
        clearBtn = h("button", { type: "button", class: "linkbtn", text: "Forget the saved " + label.toLowerCase() }) as HTMLButtonElement;
        clearBtn.onclick = () => {
          const on = !(d.clear as any)[key];
          (d.clear as any)[key] = on;
          clearBtn!.textContent = on ? "Undo — keep the saved " + label.toLowerCase() : "Forget the saved " + label.toLowerCase();
          badge.textContent = on ? "will be removed" : "saved";
          inp.disabled = on;
          validate();
        };
        f.el.appendChild(clearBtn);
      }
      inp.addEventListener("input", () => {
        badge.hidden = !!inp.value;
      });
      fields[key] = f;
      return f.el;
    };

    function renderTypeFields() {
      clear(typeHost);
      clear(bridgeHost);
      for (const k of ["api_key", "password", "access_code", "serial", "username", "storage", "model"]) delete fields[k];
      portIn.placeholder = DEFAULT_PORT[d.type] ? "Default " + DEFAULT_PORT[d.type] : "";
      // Bambu printers are reached through print-bridge by IP; no port.
      fields.port.el.hidden = d.type === "bambu";
      hostIn.placeholder = d.type === "bambu" ? "192.168.1.50" : d.type === "moonraker" ? "192.168.1.40" : "printer.local";
      fields.host.el.querySelector(".hint")?.remove();
      fields.host.el.insertBefore(h("span", { class: "hint", text: HOST_HINT[d.type] }), fields.host.el.querySelector(".field-error"));
      const saved = existing && existing.type === d.type ? existing : null;
      if (d.type === "moonraker") {
        typeHost.append(secretInput("api_key", "pf-key", "API key", !!saved?.has_api_key, "Only if Moonraker has authorization enabled."));
      } else if (d.type === "octoprint") {
        typeHost.append(secretInput("api_key", "pf-key", "API key", !!saved?.has_api_key, "OctoPrint → Settings → Application Keys (or the global API key)."));
      } else if (d.type === "prusalink") {
        const user = text("username", "pf-user", { placeholder: "maker" });
        fields.username = field("Username", user, { forId: "pf-user", hint: "Default: maker" });
        const storage = select(
          "pf-storage",
          [
            { value: "", label: "Automatic (usb)" },
            { value: "usb", label: "USB drive (MK4 / XL / MINI)" },
            { value: "local", label: "Local storage" },
          ],
          d.storage,
          (v) => (d.storage = v),
        );
        fields.storage = field("Storage", storage, { forId: "pf-storage" });
        typeHost.append(
          h("div", { class: "grid2" }, fields.username.el, secretInput("password", "pf-pass", "Password", !!saved?.has_password, "Printer screen → Settings → Network → PrusaLink.")),
          secretInput("api_key", "pf-key", "API key", !!saved?.has_api_key, "Older firmware only — leave blank when using the password."),
          fields.storage.el,
        );
      } else if (d.type === "bambu") {
        const serial = text("serial", "pf-serial", { placeholder: "01S00C123456789" });
        fields.serial = field("Serial number", serial, { forId: "pf-serial" });
        const model = select("pf-model", BAMBU_MODELS.map((x) => ({ value: x, label: x || "Not specified" })), d.model, (v) => (d.model = v));
        fields.model = field("Model", model, { forId: "pf-model", hint: "Optional" });
        const slot = h("div");
        const paint = () =>
          slot.replaceChildren(
            bridgeBanner(state.diagnostics?.bridge, check, !state.printers.some((x) => x.type === "bambu")) ||
              h("div", { class: "banner info", role: "status" }, icon("info"), h("div", { class: "grow" }, h("b", { text: "Checking print-bridge…" }), h("p", { text: LAN_NOTE }))),
          );
        const check = () => {
          loadDiagnostics(true).then(paint);
        };
        paint();
        check();
        bridgeHost.append(slot);
        typeHost.append(
          h("div", { class: "grid2" }, fields.serial.el, fields.model.el),
          secretInput("access_code", "pf-code", "Access code", !!saved?.bambu?.has_access_code, "8 characters, shown on the printer's network screen."),
        );
      }
      if (d.type !== "bambu") typeHost.append(tlsRow);
    }

    const picker = profilePicker("pf-prof", { printer: d.orca_printer_profile, filament: d.orca_filament_profile, process: d.orca_process_profile }, { allowEmpty: true });

    const saveBtn = btn(existing ? "Save changes" : "Add printer", { cls: "primary" });
    const reason = h("span", { class: "reason" });
    const testBtn = existing ? btn("Test connection", { icon: "plug" }) : null;
    const testOut = h("div");

    function validate(): boolean {
      const err = validatePrinter(d, existing && existing.type === d.type ? existing : null);
      for (const [k, f] of Object.entries(fields)) f.setError(touched || d[k as keyof PrinterDraft] ? err[k] || null : null);
      const n = Object.keys(err).length;
      saveBtn.disabled = n > 0 || saving;
      reason.textContent = saving ? "" : n ? (n === 1 ? Object.values(err)[0] : `Fix ${n} fields to continue.`) : "";
      return n === 0;
    }

    async function save(thenTest: boolean) {
      touched = true;
      if (!validate()) return;
      const pv = picker.values();
      d.orca_printer_profile = pv.printer;
      d.orca_filament_profile = pv.filament;
      d.orca_process_profile = pv.process;
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const body = printerBody(d, !!existing);
        const r = existing ? await put<{ printer: Printer; warning: string | null }>(`printers/${encodeURIComponent(existing.id)}`, body) : await post<{ printer: Printer; warning: string | null }>("printers", body);
        if (r.warning) toast(r.warning, "bad");
        else toast(existing ? `Saved ${r.printer.name}.` : `Added ${r.printer.name}.`, "ok");
        m.close();
        await refresh();
        onChanged();
        if (thenTest) runTest(r.printer);
      } catch (e) {
        saving = false;
        saveBtn.textContent = existing ? "Save changes" : "Add printer";
        reason.textContent = "";
        testOut.replaceChildren(h("div", { class: "testres bad", role: "alert", text: errText(e) }));
        validate();
      }
    }
    saveBtn.onclick = () => save(!existing);
    if (testBtn) {
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        testOut.replaceChildren(h("div", { class: "testres run", text: "Connecting… (up to 40 s)" }));
        try {
          const r = await post<{ ok: boolean; detail: string }>(`printers/${encodeURIComponent(existing!.id)}/test`);
          testOut.replaceChildren(h("div", { class: "testres " + (r.ok ? "ok" : "bad"), role: "status", text: (r.ok ? "Connected — " : "Failed — ") + r.detail }));
        } catch (e) {
          testOut.replaceChildren(h("div", { class: "testres bad", role: "status", text: errText(e) }));
        }
        testBtn.disabled = false;
      };
    }

    const form = h(
      "form",
      { class: "stack", novalidate: true },
      bridgeHost,
      h("div", { class: "grid2" }, fields.name.el, fields.type.el),
      h("div", { class: "grid3" }, fields.host.el, fields.port.el),
      typeHost,
      h("hr", { class: "divider" }),
      h("p", { class: "subhead", text: "Default slicing profiles" }),
      h("p", { class: "reason", style: { margin: "-8px 0 0" }, text: "Used when you slice for this printer without picking profiles." }),
      picker.el,
      testOut,
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      save(!existing);
    });
    // Enter in a text field submits (but not while a combobox list is open).
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).matches("input:not([role=combobox])")) {
        e.preventDefault();
        if (!saveBtn.disabled) save(!existing);
      }
    });
    m.body.appendChild(form);
    m.foot.append(reason, testBtn || "", btn("Cancel", { onClick: () => m.close() }), saveBtn);
    if (testBtn) testBtn.title = "Tests the saved settings — save first if you changed them.";
    renderTypeFields();
    validate();
  }

  // An install finished: new profiles mean defaults can be picked now, and a
  // fresh bridge changes the banners.
  window.addEventListener(SETUP_DONE, () => {
    refresh();
    loadDiagnostics().then(render);
  });

  return {
    el,
    show() {
      render();
      refresh();
      // Re-probe each visit: the bridge may have been installed meanwhile.
      loadDiagnostics().then(render);
    },
    openAdd() {
      openForm(null);
    },
  };
}

export { TYPE_SHORT };
