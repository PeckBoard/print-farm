// Per-printer slicing settings (GET/PUT printers/:id/settings): installed
// plate, default presets (searchable comboboxes over GET profiles), nozzle
// size, read-only capabilities, and the effective values as hints.

import { h, btn, toast, errText, openModal, field, select, icon } from "./dom";
import { get, put } from "./api";
import { Printer, loadFarmSettings } from "./state";
import { PrinterSettings, FarmSettings, plateOptions, deepEqual, diffTop } from "./settingsModel";
import { profilePicker } from "./profilePicker";
import { chip } from "./widgets";

const NOZZLES = [0.2, 0.4, 0.6, 0.8];
const CAPS: [keyof NonNullable<PrinterSettings["capabilities"]>, string][] = [
  ["heaters", "Heater control"],
  ["camera", "Camera"],
  ["gcode", "Raw G-code"],
];

type Editable = Pick<PrinterSettings, "plate_type" | "printer_preset" | "process_preset" | "filament_preset" | "nozzle_mm">;

function editable(s: PrinterSettings): Editable {
  return {
    plate_type: s.plate_type || null,
    printer_preset: s.printer_preset || null,
    process_preset: s.process_preset || null,
    filament_preset: s.filament_preset || null,
    nozzle_mm: s.nozzle_mm ?? null,
  };
}

/// Open the settings dialog for one printer. `onSaved` runs after a save.
export function openPrinterSettings(p: Printer, onSaved?: () => void): void {
  const m = openModal(`Slicing settings — ${p.name}`);
  const saveBtn = btn("Save settings", { cls: "primary" });
  saveBtn.disabled = true;
  const reason = h("span", { class: "reason", "aria-live": "polite" });
  m.foot.append(reason, btn("Cancel", { onClick: () => m.close() }), saveBtn);
  m.body.append(
    h("div", { class: "skel", style: { height: "56px" } }),
    h("div", { class: "skel", style: { height: "160px" } }),
    h("div", { class: "skel", style: { height: "40px" } }),
  );

  Promise.all([get<PrinterSettings>(`printers/${encodeURIComponent(p.id)}/settings`), loadFarmSettings().catch(() => null)])
    .then(([s, farm]) => build(s, farm))
    .catch((e) => {
      m.body.replaceChildren(
        h("div", { class: "banner bad", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Couldn't load this printer's settings" }), h("p", { text: errText(e) }))),
      );
    });

  function build(s: PrinterSettings, farm: FarmSettings | null) {
    const saved = editable(s);
    const draft: Editable = { ...saved };
    const eff = s.effective || {};

    const farmPlate = farm?.plate_type || eff.plate_type || "";
    const plate = select(
      "ps-plate",
      [{ value: "", label: farmPlate ? `Farm default (${farmPlate})` : "Farm default" }].concat(plateOptions(s.plate_type, eff.plate_type).map((x) => ({ value: x, label: x }))),
      draft.plate_type || "",
      (v) => {
        draft.plate_type = v || null;
        sync();
      },
    );
    const plateF = field("Installed plate", plate, { forId: "ps-plate", hint: "The build plate on this printer — picks the filament preset's bed temperature for it." });

    const noz = select(
      "ps-nozzle",
      [{ value: "", label: "Not set (from the printer preset)" }].concat(NOZZLES.map((n) => ({ value: String(n), label: n.toFixed(1) + " mm" }))),
      draft.nozzle_mm == null ? "" : String(draft.nozzle_mm),
      (v) => {
        draft.nozzle_mm = v ? Number(v) : null;
        sync();
      },
    );
    const nozF = field("Nozzle size", noz, { forId: "ps-nozzle" });

    const picker = profilePicker(
      "ps-prof",
      { printer: draft.printer_preset || "", filament: draft.filament_preset || "", process: draft.process_preset || "" },
      { allowEmpty: true, emptyLabel: "Automatic", onChange: () => readPicker() },
    );
    const effHint = (kind: "printer" | "filament" | "process", set: string | null, e: string | undefined) => {
      if (!e) return picker.setHint(kind, set ? null : "Picked automatically when slicing.");
      picker.setHint(kind, set && set === e ? null : `In effect: ${e}`);
    };
    const readPicker = () => {
      const v = picker.values();
      draft.printer_preset = v.printer || null;
      draft.filament_preset = v.filament || null;
      draft.process_preset = v.process || null;
      sync();
    };

    const caps = s.capabilities || {};
    const capRow = h(
      "div",
      { class: "chips", role: "list", "aria-label": "Capabilities" },
      ...CAPS.map(([k, label]) => {
        const c = chip(label, undefined, { tone: caps[k] ? "ok" : "off" });
        c.setAttribute("role", "listitem");
        c.title = caps[k] ? "Supported" : "Not supported by this printer / connection";
        return c;
      }),
    );

    const effBlock = h(
      "dl",
      { class: "kv" },
      ...(
        [
          ["Plate", eff.plate_type],
          ["Printer", eff.printer_preset],
          ["Process", eff.process_preset],
          ["Filament", eff.filament_preset],
        ] as [string, string | undefined][]
      ).flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { class: v ? "" : "muted", text: v || "—" })]),
    );

    m.body.replaceChildren(
      h("div", { class: "grid2" }, plateF.el, nozF.el),
      h("hr", { class: "divider" }),
      h("p", { class: "subhead", text: "Default presets" }),
      h("p", { class: "reason", style: { margin: "-8px 0 0" }, text: "Leave a preset on Automatic to use the farm defaults and the printer's detected model." }),
      picker.el,
      h("hr", { class: "divider" }),
      h("div", { class: "grid2 al-top" }, h("div", { class: "stack tight" }, h("p", { class: "subhead", text: "Capabilities" }), capRow), h("div", { class: "stack tight" }, h("p", { class: "subhead", text: "Currently in effect" }), effBlock)),
    );

    function sync() {
      effHint("printer", draft.printer_preset, eff.printer_preset);
      effHint("filament", draft.filament_preset, eff.filament_preset);
      effHint("process", draft.process_preset, eff.process_preset);
      const dirty = !deepEqual(saved, draft);
      saveBtn.disabled = !dirty;
      reason.textContent = dirty ? "Unsaved changes" : "";
    }
    sync();
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      reason.textContent = "Saving…";
      try {
        await put<PrinterSettings>(`printers/${encodeURIComponent(p.id)}/settings`, diffTop(saved, draft));
        toast(`Saved slicing settings for ${p.name}.`, "ok");
        m.close();
        onSaved?.();
      } catch (e) {
        reason.textContent = "";
        toast("Couldn't save: " + errText(e), "bad");
        sync();
      }
    };
  }
}
