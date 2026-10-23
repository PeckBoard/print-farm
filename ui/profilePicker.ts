// Vendor <select> + printer / filament / process searchable comboboxes fed by
// GET profiles. Used by the printer form (defaults) and the slice form.

import { h, combobox, field, select, Combo } from "./dom";
import { loadVendors, loadProfiles } from "./state";

export interface ProfileValues {
  vendor: string;
  printer: string;
  filament: string;
  process: string;
}

export interface ProfilePicker {
  el: HTMLElement;
  values(): ProfileValues;
  set(v: Partial<ProfileValues>): void;
  /// Why the picker can't be used (no Orca profiles), or null.
  unavailable(): string | null;
  setError(kind: "printer" | "filament" | "process", msg: string | null): void;
}

/// Options for one kind under a vendor: the vendor's own presets, the user's
/// presets, and (filaments) Orca's shared filament library.
async function optionsFor(kind: "printer" | "filament" | "process", vendor: string, vendors: string[]): Promise<string[]> {
  const sources = [vendor];
  if (vendor !== "User" && vendors.indexOf("User") >= 0) sources.push("User");
  if (kind === "filament" && vendor !== "OrcaFilamentLibrary" && vendors.indexOf("OrcaFilamentLibrary") >= 0) sources.push("OrcaFilamentLibrary");
  const lists = await Promise.all(sources.map((s) => loadProfiles(kind, s).catch(() => [] as string[])));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) for (const n of l) if (!seen.has(n)) (seen.add(n), out.push(n));
  return out;
}

export function profilePicker(idPrefix: string, initial: Partial<ProfileValues>, opts: { allowEmpty?: boolean; onChange?: () => void } = {}): ProfilePicker {
  let vendors: string[] = [];
  let unavailable: string | null = "Loading profiles…";
  let vendor = initial.vendor || "";
  const vendorSel = select(idPrefix + "-vendor", [{ value: "", label: "Loading vendors…" }], "");
  vendorSel.disabled = true;
  const mk = (kind: "printer" | "filament" | "process", label: string) => {
    const c = combobox({
      id: `${idPrefix}-${kind}`,
      placeholder: `Search ${label.toLowerCase()} profiles…`,
      value: (initial as any)[kind] || "",
      allowEmpty: opts.allowEmpty,
      onChange: () => opts.onChange?.(),
    });
    c.setDisabled("Loading profiles…");
    const f = field(label + " profile", c.el, { forId: `${idPrefix}-${kind}` });
    return { c, f };
  };
  const P = mk("printer", "Printer");
  const F = mk("filament", "Filament");
  const R = mk("process", "Process");
  const combos: Record<string, { c: Combo; f: ReturnType<typeof field> }> = { printer: P, filament: F, process: R };
  const note = h("div", { class: "reason" });
  note.hidden = true;

  const refill = async () => {
    for (const k of ["printer", "filament", "process"] as const) {
      const { c } = combos[k];
      c.setDisabled("Loading profiles…");
      const list = await optionsFor(k, vendor, vendors);
      c.setOptions(list);
      c.setDisabled(list.length ? null : `No ${k} profiles for ${vendor}`);
    }
  };

  vendorSel.addEventListener("change", () => {
    vendor = vendorSel.value;
    refill();
    opts.onChange?.();
  });

  loadVendors()
    .then((vs) => {
      vendors = vs;
      while (vendorSel.firstChild) vendorSel.removeChild(vendorSel.firstChild);
      if (!vs.length) {
        unavailable = "No OrcaSlicer profiles found on this host.";
        vendorSel.appendChild(h("option", { value: "", text: "No profiles found" }));
        for (const k of Object.keys(combos)) combos[k].c.setDisabled("No OrcaSlicer profiles found");
        note.textContent = "Install OrcaSlicer (or set “OrcaSlicer profile directories” in the plugin settings) to pick profiles.";
        note.hidden = false;
        opts.onChange?.();
        return;
      }
      unavailable = null;
      for (const v of vs) vendorSel.appendChild(h("option", { value: v, text: v }));
      if (!vendor || vs.indexOf(vendor) < 0) vendor = vs[0];
      vendorSel.value = vendor;
      vendorSel.disabled = false;
      refill();
      opts.onChange?.();
    })
    .catch((e) => {
      unavailable = "Couldn't load profiles: " + (e as Error).message;
      vendorSel.replaceChildren(h("option", { value: "", text: "Unavailable" }));
      for (const k of Object.keys(combos)) combos[k].c.setDisabled("Profiles unavailable");
      note.textContent = unavailable;
      note.hidden = false;
      opts.onChange?.();
    });

  const el = h(
    "div",
    { class: "stack" },
    field("Vendor", vendorSel, { forId: idPrefix + "-vendor", hint: "Where the presets come from (User = your own Orca presets)." }).el,
    P.f.el,
    h("div", { class: "grid2" }, F.f.el, R.f.el),
    note,
  );
  return {
    el,
    values: () => ({ vendor, printer: P.c.value(), filament: F.c.value(), process: R.c.value() }),
    set(v) {
      if (v.vendor && v.vendor !== vendor && vendors.indexOf(v.vendor) >= 0) {
        vendor = v.vendor;
        vendorSel.value = vendor;
        refill();
      }
      if (v.printer !== undefined) P.c.setValue(v.printer);
      if (v.filament !== undefined) F.c.setValue(v.filament);
      if (v.process !== undefined) R.c.setValue(v.process);
    },
    unavailable: () => unavailable,
    setError(kind, msg) {
      combos[kind].f.setError(msg);
    },
  };
}
