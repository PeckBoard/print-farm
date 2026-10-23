// Slice tab: upload models (chunked), the file list, a 3D / G-code preview,
// the slice form (printer + Orca profiles), slice-job progress, and sending
// G-code to a printer (upload only, or upload & start after a confirm).

import { h, clear, icon, btn, toast, errText, confirmDialog, select, field } from "./dom";
import { get, post, del, bytesToB64, b64ToBytes, openPluginPage } from "./api";
import { state, FileRec, SliceJob, Print, Printer, Diagnostics, Status, printerById, loadPrinters } from "./state";
import { fmtBytes, fmtDuration, fmtFilament, accepts, previewKind, TYPE_SHORT } from "./format";
import { parseGcode, ParsedGcode } from "./gcode";
import { Viewer, ViewerTheme, webglAvailable } from "./viewer";
import { profilePicker, ProfilePicker } from "./profilePicker";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";

const CHUNK_RAW = 768 * 1024; // → exactly 1 MiB of base64 per request
const READ_LEN = 786432;
const PREVIEW_MAX = 96 * 1024 * 1024;
const ACCEPT = ".stl,.3mf,.step,.stp,.obj,.amf,.gcode,.gco,.bgcode";

interface Upload {
  key: string;
  name: string;
  size: number;
  sent: number;
  error?: string;
}

export interface SliceView {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
function viewerTheme(): ViewerTheme {
  return {
    bg: cssVar("--viewer-bg"),
    grid: cssVar("--grid"),
    gridMinor: cssVar("--grid-minor"),
    model: cssVar("--model"),
    extrude: cssVar("--extrude"),
    extrudeTop: cssVar("--extrude-top"),
    travel: cssVar("--travel"),
  };
}

export function sliceView(goPrinters: () => void, goFarm: () => void): SliceView {
  const banner = h("div");
  // Visually hidden (not display:none) so automation and assistive tech can
  // still reach it; the drop zone is the visible, focusable control.
  const fileInput = h("input", { type: "file", accept: ACCEPT, multiple: true, class: "sr", tabindex: "-1", "aria-label": "Choose files to upload" }) as HTMLInputElement;
  const drop = h(
    "div",
    { class: "drop", role: "button", tabindex: "0", "aria-label": "Upload models or G-code: drop files here or press Enter to choose" },
    icon("upload"),
    h("b", { text: "Drop STL, 3MF, STEP or G-code" }),
    h("span", { class: "small", text: "or click to choose files" }),
  );
  const fileList = h("div", { class: "files", role: "listbox", "aria-label": "Files" });
  const left = h(
    "div",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Files" }), btn(null, { icon: "refresh", cls: "ghost sm", aria: "Refresh files", onClick: () => loadFiles() })),
    drop,
    fileInput,
    fileList,
  );
  const previewTitle = h("h3", { text: "Preview" });
  const previewTools = h("div", { class: "row" });
  const viewerHost = h("div", { class: "viewer" });
  const overlay = h("div", { class: "overlay" });
  const layerBar = h("div", { class: "layerbar" });
  layerBar.hidden = true;
  viewerHost.appendChild(overlay);
  const actions = h("div", { class: "panel" });
  const right = h(
    "div",
    { class: "stack" },
    h("div", { class: "panel" }, h("div", { class: "panel-head" }, previewTitle, previewTools), viewerHost, layerBar),
    actions,
  );
  const el = h("section", { "aria-label": "Slice" }, banner, h("div", { class: "slice" }, left, right));

  let selected: string | null = null;
  let uploads: Upload[] = [];
  let viewer: Viewer | null = null;
  let loadToken = 0;
  let jobTimer = 0;
  let active = false;
  const cache = new Map<string, Uint8Array>();

  // ── diagnostics banner ───────────────────────────────────────────────
  async function loadDiagnostics() {
    try {
      state.diagnostics = await get<Diagnostics>("diagnostics");
    } catch (e) {
      state.diagnostics = null;
      banner.replaceChildren(h("div", { class: "banner warn" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Couldn't check the slicer setup" }), h("p", { text: errText(e) }))));
      return;
    }
    renderBanner();
  }

  function renderBanner() {
    clear(banner);
    const d = state.diagnostics;
    if (!d) return;
    const am = (q: string) => {
      const a = h("a", { class: "btn sm", href: "/plugin-page/app-manager/app-manager?" + q }, icon("ext"), "Open App Manager");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openPluginPage("app-manager", "app-manager", q);
      });
      return a;
    };
    if (!d.orca.orca_found) {
      banner.appendChild(
        h(
          "div",
          { class: "banner warn", role: "status" },
          icon("warn"),
          h(
            "div",
            { class: "grow" },
            h("b", { text: "OrcaSlicer isn't installed — slicing is unavailable" }),
            h("p", {
              text:
                `“${d.orca.orca_path}” wasn't found on this host (also checked ~/.local/bin and flatpak). Install OrcaSlicer (the AppImage works), or point the “OrcaSlicer executable” plugin setting at it. ` +
                "You can still upload G-code and send it to printers.",
            }),
            h("div", { class: "row" }, am("install=orca-slicer,xvfb&from=print-farm")),
          ),
        ),
      );
    } else if (!d.orca.display && !d.orca.xvfb_run && d.orca.headless_mode !== "never") {
      banner.appendChild(
        h(
          "div",
          { class: "banner warn", role: "status" },
          icon("warn"),
          h(
            "div",
            { class: "grow" },
            h("b", { text: "No display and no xvfb-run" }),
            h("p", { text: "Some OrcaSlicer builds refuse to start without a display. Install xvfb (provides xvfb-run) so Print Farm can slice headless." }),
            h("div", { class: "row" }, am("install=xvfb&from=print-farm")),
          ),
        ),
      );
    }
    if (d.orca.orca_found && !d.profile_roots.length) {
      banner.appendChild(
        h(
          "div",
          { class: "banner warn", role: "status" },
          icon("warn"),
          h(
            "div",
            { class: "grow" },
            h("b", { text: "No OrcaSlicer profiles found" }),
            h("p", { text: "Open OrcaSlicer once (it writes ~/.config/OrcaSlicer/system), or set “OrcaSlicer profile directories” in the plugin settings." }),
          ),
        ),
      );
    }
  }

  // ── files ────────────────────────────────────────────────────────────
  async function loadFiles() {
    try {
      const [f, j] = await Promise.all([get<{ files: FileRec[] }>("files"), get<{ jobs: SliceJob[] }>("slice")]);
      state.files = f.files.filter((x) => x.source !== "snapshot");
      state.jobs = j.jobs;
      state.filesLoaded = true;
    } catch (e) {
      toast("Couldn't load files: " + errText(e), "bad");
      state.filesLoaded = true;
    }
    renderFiles();
    if (selected && !state.files.some((f) => f.id === selected)) select_(null);
    else if (selected) renderActions();
    else if (state.files.length && !selected) select_(state.files[0].id);
    else renderActions();
  }

  function renderFiles() {
    clear(fileList);
    for (const u of uploads) {
      const pct = u.size ? Math.round((u.sent / u.size) * 100) : 0;
      fileList.appendChild(
        h(
          "div",
          { class: "file", "aria-busy": u.error ? "false" : "true" },
          h("div", { class: "ico" }, icon("upload")),
          h("div", { class: "nm", text: u.name }),
          h("div", { class: "meta" }, u.error ? h("span", { class: "field-error", text: u.error }) : h("span", { text: `Uploading… ${pct}% of ${fmtBytes(u.size)}` })),
          u.error
            ? btn(null, {
                icon: "x",
                cls: "ghost sm x",
                aria: "Dismiss",
                onClick: () => {
                  uploads = uploads.filter((x) => x !== u);
                  renderFiles();
                },
              })
            : null,
          u.error ? null : h("div", { class: "prog" }, h("div", { style: { width: pct + "%" } })),
        ),
      );
    }
    if (!state.filesLoaded) {
      for (let i = 0; i < 3; i++) fileList.appendChild(h("div", { class: "file" }, h("div", { class: "ico skel" }), h("div", { class: "skel", style: { height: "12px", width: "70%" } }), h("div", { class: "meta" }, h("div", { class: "skel", style: { height: "10px", width: "40%" } }))));
      return;
    }
    if (!state.files.length && !uploads.length) {
      fileList.appendChild(h("div", { class: "empty small" }, h("p", { text: "No files yet. Upload a model to slice it, or G-code to send it straight to a printer." })));
      return;
    }
    for (const f of state.files) {
      const isModel = f.kind === "model";
      const isG = f.kind === "gcode" || f.kind === "gcode.3mf" || f.kind === "bgcode";
      const row = h(
        "div",
        { class: "file" + (f.id === selected ? " active" : ""), role: "option", tabindex: "0", "aria-selected": f.id === selected ? "true" : "false", "data-id": f.id },
        h("div", { class: "ico" + (isModel ? " model" : isG ? " gcode" : "") }, icon(isModel ? "box" : isG ? "layers" : "file")),
        h("div", { class: "nm", title: f.name, text: f.name }),
        h(
          "div",
          { class: "meta" },
          h("span", { text: fmtBytes(f.size) }),
          h("span", { class: "badge", text: f.source === "slice" ? "Sliced" : f.source === "project" ? "From project" : f.kind === "model" ? "Model" : f.kind }),
          f.estimate?.print_time_s ? h("span", { text: "⏱ " + fmtDuration(f.estimate.print_time_s) }) : null,
          f.complete ? null : h("span", { class: "field-error", text: "incomplete upload" }),
        ),
        btn(null, {
          icon: "trash",
          cls: "ghost sm x",
          aria: "Delete " + f.name,
          onClick: (e) => {
            e.stopPropagation();
            removeFile(f);
          },
        }),
      );
      row.addEventListener("click", () => select_(f.id));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select_(f.id);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const sib = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
          sib?.focus();
        }
      });
      fileList.appendChild(row);
    }
  }

  async function removeFile(f: FileRec) {
    const ok = await confirmDialog({ title: `Delete ${f.name}?`, body: "The file is removed from Print Farm's storage. Copies already sent to printers stay there.", confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      await del(`files/${encodeURIComponent(f.id)}`);
      cache.delete(f.id);
      toast(`Deleted ${f.name}.`, "ok");
    } catch (e) {
      toast("Couldn't delete: " + errText(e), "bad");
    }
    if (selected === f.id) selected = null;
    loadFiles();
  }

  // ── uploads ──────────────────────────────────────────────────────────
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer?.files?.length) uploadAll(Array.from(e.dataTransfer.files));
  });
  // Dropping anywhere on the tab works too.
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer?.files?.length) uploadAll(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) uploadAll(Array.from(fileInput.files));
    fileInput.value = "";
  });

  async function uploadAll(files: File[]) {
    let last: string | null = null;
    for (const f of files) {
      const id = await uploadOne(f);
      if (id) last = id;
    }
    await loadFiles();
    if (last) select_(last);
  }

  async function uploadOne(file: File): Promise<string | null> {
    const u: Upload = { key: Math.random().toString(36), name: file.name, size: file.size, sent: 0 };
    uploads.push(u);
    renderFiles();
    try {
      const chunk = async (off: number) => bytesToB64(new Uint8Array(await file.slice(off, off + CHUNK_RAW).arrayBuffer()));
      const first = await chunk(0);
      let rec = (await post<{ file: FileRec }>("uploads", { name: file.name, data_base64: first, done: file.size <= CHUNK_RAW })).file;
      u.sent = rec.size;
      renderFiles();
      let retries = 0;
      while (!rec.complete) {
        const off = rec.size;
        const data = await chunk(off);
        const done = off + CHUNK_RAW >= file.size;
        try {
          rec = (await post<{ file: FileRec }>(`uploads/${encodeURIComponent(rec.id)}/chunk`, { offset: off, data_base64: data, done })).file;
          retries = 0;
        } catch (e) {
          const m = /offset mismatch: expected (\d+)/.exec(errText(e));
          if (!m || ++retries > 3) throw e;
          rec = { ...rec, size: Number(m[1]) };
        }
        u.sent = rec.size;
        renderFiles();
      }
      uploads = uploads.filter((x) => x !== u);
      toast(`Uploaded ${file.name}.`, "ok");
      return rec.id;
    } catch (e) {
      u.error = "Upload failed: " + errText(e);
      renderFiles();
      return null;
    }
  }

  // ── selection + preview ──────────────────────────────────────────────
  function select_(id: string | null) {
    selected = id;
    for (const r of Array.from(fileList.querySelectorAll<HTMLElement>(".file[data-id]"))) {
      const on = r.dataset.id === id;
      r.classList.toggle("active", on);
      r.setAttribute("aria-selected", on ? "true" : "false");
    }
    renderActions(true);
    preview();
  }

  function setOverlay(content: (Node | string)[] | null) {
    clear(overlay);
    overlay.hidden = !content;
    if (content) overlay.appendChild(h("div", { class: "box" }, ...content));
  }

  function ensureViewer(): Viewer | null {
    if (viewer) return viewer;
    if (!webglAvailable()) return null;
    try {
      viewer = new Viewer(viewerHost, viewerTheme());
      viewerHost.insertBefore(viewerHost.lastChild!, overlay); // keep canvas under the overlay
      viewerHost.appendChild(overlay);
    } catch (_e) {
      viewer = null;
    }
    return viewer;
  }

  async function fetchBytes(f: FileRec, token: number, onProgress: (n: number) => void): Promise<Uint8Array | null> {
    const hit = cache.get(f.id);
    if (hit) return hit;
    const parts: Uint8Array[] = [];
    let off = 0;
    let size = f.size;
    for (;;) {
      const r = await get<{ offset: number; length: number; size: number; eof: boolean; data_base64: string }>(`files/${encodeURIComponent(f.id)}?offset=${off}&length=${READ_LEN}`);
      if (token !== loadToken) return null;
      const b = b64ToBytes(r.data_base64);
      parts.push(b);
      off += b.length;
      size = r.size;
      onProgress(size ? off / size : 1);
      if (r.eof || !b.length) break;
    }
    const out = new Uint8Array(off);
    let p = 0;
    for (const part of parts) {
      out.set(part, p);
      p += part.length;
    }
    cache.set(f.id, out);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return out;
  }

  async function preview(force = false) {
    const token = ++loadToken;
    layerBar.hidden = true;
    clear(previewTools);
    const f = state.files.find((x) => x.id === selected);
    previewTitle.textContent = f ? f.name : "Preview";
    if (!f) {
      setOverlay([icon("box"), h("span", { text: state.files.length ? "Pick a file to preview it." : "Upload a model to preview and slice it." })]);
      viewer?.showGcode({ layers: [], bounds: null, moves: 0 });
      return;
    }
    const kind = previewKind(f.name, f.kind);
    if (!kind) {
      setOverlay([icon("box"), h("span", { text: f.kind === "bgcode" ? "Binary G-code can't be previewed." : "No 3D preview for this format (STEP / OBJ / AMF) — it can still be sliced." })]);
      viewer?.showGcode({ layers: [], bounds: null, moves: 0 });
      return;
    }
    if (!f.complete) {
      setOverlay([h("span", { text: "This upload didn't finish — delete it and upload again." })]);
      return;
    }
    const v = ensureViewer();
    if (!v) {
      setOverlay([icon("warn"), h("span", { text: "3D preview needs WebGL, which isn't available in this browser." })]);
      return;
    }
    if (f.size > PREVIEW_MAX && !force) {
      setOverlay([h("span", { text: `This file is large (${fmtBytes(f.size)}); previewing downloads all of it.` }), btn("Preview anyway", { cls: "primary", onClick: () => preview(true) })]);
      return;
    }
    const prog = h("div", { class: "prog", style: { width: "220px" } }, h("div", { style: { width: "0%" } }));
    const label = h("span", { text: "Loading " + fmtBytes(f.size) + "…" });
    setOverlay([label, prog]);
    try {
      const bytes = await fetchBytes(f, token, (p) => ((prog.firstChild as HTMLElement).style.width = Math.round(p * 100) + "%"));
      if (!bytes || token !== loadToken) return;
      label.textContent = kind === "gcode" || kind === "gcode.3mf" ? "Parsing G-code…" : "Building mesh…";
      await new Promise((r) => setTimeout(r, 20));
      if (token !== loadToken) return;
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (kind === "stl") {
        v.showStl(buf);
        modelTools(v);
      } else if (kind === "3mf") {
        v.show3mf(buf);
        modelTools(v);
      } else {
        let text: string;
        if (kind === "gcode.3mf") {
          const files = unzipSync(bytes);
          const name = Object.keys(files).find((n) => /^Metadata\/plate_\d+\.gcode$/.test(n)) || Object.keys(files).find((n) => n.endsWith(".gcode"));
          if (!name) throw new Error("no G-code inside this .gcode.3mf");
          text = new TextDecoder().decode(files[name]);
        } else text = new TextDecoder().decode(bytes);
        const parsed = parseGcode(text);
        if (token !== loadToken) return;
        if (!parsed.layers.length) {
          setOverlay([icon("warn"), h("span", { text: "No extrusion moves found in this G-code." })]);
          return;
        }
        v.showGcode(parsed);
        gcodeTools(v, parsed);
      }
      setOverlay(null);
    } catch (e) {
      if (token !== loadToken) return;
      setOverlay([icon("warn"), h("span", { text: "Couldn't preview this file: " + errText(e) })]);
    }
  }

  function modelTools(v: Viewer) {
    clear(previewTools);
    previewTools.appendChild(btn("Fit", { icon: "fit", cls: "sm", aria: "Fit model to view", onClick: () => v.fit() }));
    viewerHost.querySelector(".hint")?.remove();
    viewerHost.appendChild(h("div", { class: "hint", text: "Drag to orbit · right-drag to pan · scroll to zoom" }));
  }

  function gcodeTools(v: Viewer, g: ParsedGcode) {
    modelTools(v);
    const n = g.layers.length;
    const range = h("input", { type: "range", min: "1", max: String(n), value: String(n), step: "1", id: "pf-layer", "aria-label": "Layer" }) as HTMLInputElement;
    const lbl = h("span", { class: "lbl" });
    const travel = h("input", { type: "checkbox", id: "pf-travel" }) as HTMLInputElement;
    const upd = () => {
      const i = Number(range.value) - 1;
      v.setLayer(i);
      lbl.textContent = `Layer ${i + 1} / ${n} · Z ${g.layers[i].z.toFixed(2)} mm`;
      range.setAttribute("aria-valuetext", lbl.textContent);
    };
    range.addEventListener("input", upd);
    travel.addEventListener("change", () => v.setShowTravel(travel.checked, Number(range.value) - 1));
    clear(layerBar);
    layerBar.append(
      lbl,
      range,
      h("label", { class: "check", for: "pf-travel" }, travel, "Travel moves"),
      h(
        "span",
        { class: "legend" },
        h("span", null, h("i", { style: { background: cssVar("--extrude") } }), "Extrusion"),
        h("span", null, h("i", { style: { background: cssVar("--extrude-top") } }), "Current layer"),
        h("span", null, h("i", { style: { background: cssVar("--travel") } }), "Travel"),
      ),
    );
    layerBar.hidden = false;
    upd();
  }

  // ── actions panel (slice form / send panel) ──────────────────────────
  let picker: ProfilePicker | null = null;
  let pickerFor: string | null = null;

  function latestJob(fileId: string): SliceJob | undefined {
    return state.jobs.filter((j) => j.model_file_id === fileId).sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0];
  }

  // Re-render only when what the panel shows changed, so background refreshes
  // never rebuild a form the user is filling in.
  let actionsSig = "";
  function renderActions(force = false) {
    const f = state.files.find((x) => x.id === selected);
    const job = f ? latestJob(f.id) : undefined;
    const sig = JSON.stringify([
      selected,
      f,
      job && [job.id, job.status, job.result_file_id],
      state.printers.map((p) => [p.id, p.name, p.type]),
      state.diagnostics?.orca.orca_found,
      state.filesLoaded,
      state.files.length > 0,
    ]);
    if (!force && sig === actionsSig) return;
    actionsSig = sig;
    clearTimeout(jobTimer);
    clear(actions);
    if (!f) {
      actions.hidden = !state.filesLoaded || !state.files.length;
      actions.appendChild(h("div", { class: "empty small" }, h("p", { text: "Select a model to slice it, or a G-code file to send it to a printer." })));
      return;
    }
    actions.hidden = false;
    if (f.kind === "model") sliceForm(f);
    else if (f.kind === "gcode" || f.kind === "gcode.3mf" || f.kind === "bgcode") {
      actions.appendChild(h("div", { class: "panel-head" }, icon("send"), h("h3", { text: "Send to a printer" })));
      const body = h("div", { class: "panel-body" });
      if (f.estimate) body.appendChild(estimateTiles(f.estimate));
      body.appendChild(sendPanel(f));
      actions.appendChild(body);
    } else {
      actions.appendChild(h("div", { class: "empty small" }, h("p", { text: "Nothing to do with this file type." })));
    }
  }

  function sliceForm(f: FileRec) {
    actions.appendChild(h("div", { class: "panel-head" }, icon("slice"), h("h3", { text: "Slice with OrcaSlicer" })));
    const body = h("div", { class: "panel-body" });
    actions.appendChild(body);
    const job = latestJob(f.id);
    const jobHost = h("div", { class: "stack" });
    const formHost = h("div", { class: "stack" });
    body.append(formHost, jobHost);

    const printerOpts = [{ value: "", label: "No printer — just pick profiles" }].concat(state.printers.map((p) => ({ value: p.id, label: `${p.name} (${TYPE_SHORT[p.type] || p.type})` })));
    const lastPrinter = job?.printer_id && printerById(job.printer_id) ? job.printer_id : state.printers.length === 1 ? state.printers[0].id : "";
    const prSel = select("pf-slice-printer", printerOpts, lastPrinter);
    const init = (pid: string) => {
      const p = printerById(pid);
      return {
        vendor: job?.profiles.vendor,
        printer: p?.orca_printer_profile || job?.profiles.printer || "",
        filament: p?.orca_filament_profile || job?.profiles.filament || "",
        process: p?.orca_process_profile || job?.profiles.process || "",
      };
    };
    if (!picker || pickerFor !== f.id) {
      picker = profilePicker("pf-slice", init(lastPrinter), { onChange: () => validate() });
      pickerFor = f.id;
    }
    const pk = picker;
    prSel.addEventListener("change", () => {
      const p = printerById(prSel.value);
      if (p) pk.set({ printer: p.orca_printer_profile || pk.values().printer, filament: p.orca_filament_profile || pk.values().filament, process: p.orca_process_profile || pk.values().process });
      validate();
    });
    const arrange = h("input", { type: "checkbox", id: "pf-arrange", checked: true }) as HTMLInputElement;
    const orient = h("input", { type: "checkbox", id: "pf-orient" }) as HTMLInputElement;
    const sliceBtn = btn("Slice", { cls: "primary", icon: "slice" });
    const reason = h("span", { class: "reason" });
    formHost.append(
      field("Printer", prSel, { forId: "pf-slice-printer", hint: "Picks the output format and fills in the printer's default profiles." }).el,
      pk.el,
      h("div", { class: "row" }, h("label", { class: "check", for: "pf-arrange" }, arrange, "Auto-arrange on the plate"), h("label", { class: "check", for: "pf-orient" }, orient, "Auto-orient")),
      h("div", { class: "row" }, sliceBtn, reason),
    );

    function validate() {
      let why = "";
      const v = pk.values();
      if (state.diagnostics && !state.diagnostics.orca.orca_found) why = "OrcaSlicer isn't installed on this host.";
      else if (pk.unavailable()) why = pk.unavailable()!;
      else if (!v.printer) why = "Pick a printer profile.";
      else if (!v.filament) why = "Pick a filament profile.";
      else if (!v.process) why = "Pick a process profile.";
      else if (!f.complete) why = "The upload didn't finish.";
      const running = latestJob(f.id)?.status === "running";
      if (running) why = "A slice is already running for this model.";
      sliceBtn.disabled = !!why;
      reason.textContent = why;
    }
    validate();

    sliceBtn.onclick = async () => {
      const v = pk.values();
      sliceBtn.disabled = true;
      reason.textContent = "Starting…";
      try {
        const r = await post<{ job: SliceJob }>("slice", {
          file_id: f.id,
          printer_id: prSel.value || undefined,
          vendor: v.vendor || undefined,
          printer_profile: v.printer,
          filament_profile: v.filament,
          process_profile: v.process,
          arrange: arrange.checked,
          orient: orient.checked,
        });
        state.jobs.unshift(r.job);
        renderJob(r.job);
        validate();
      } catch (e) {
        toast("Couldn't start slicing: " + errText(e), "bad");
        validate();
      }
    };

    function renderJob(j: SliceJob) {
      clear(jobHost);
      clearTimeout(jobTimer);
      jobHost.appendChild(h("hr", { class: "divider" }));
      if (j.status === "running") {
        const started = Date.now();
        const t = h("span", { class: "muted", text: "0s" });
        jobHost.append(
          h("div", { class: "row" }, h("span", { class: "pill busy", text: "Slicing" }), h("span", { text: `${j.profiles.printer} · ${j.profiles.filament}` }), t),
          h("div", { class: "prog indet", role: "progressbar", "aria-label": "Slicing" }, h("div")),
        );
        if (j.log_tail) jobHost.appendChild(logBox(j.log_tail, false));
        const poll = async () => {
          if (!active || selected !== f.id) return;
          try {
            const r = await get<{ job: SliceJob }>(`slice/${encodeURIComponent(j.id)}`);
            state.jobs = state.jobs.map((x) => (x.id === r.job.id ? r.job : x));
            if (r.job.status !== "running") {
              renderJob(r.job);
              validate();
              if (r.job.status === "succeeded") {
                toast("Slicing finished.", "ok");
                loadFiles();
              } else toast("Slicing failed: " + (r.job.error || "see the log"), "bad");
              return;
            }
            t.textContent = fmtDuration((Date.now() - started) / 1000);
          } catch (e) {
            t.textContent = "status unavailable: " + errText(e);
          }
          jobTimer = window.setTimeout(poll, 1500);
        };
        const tick = setInterval(() => {
          if (!t.isConnected) return clearInterval(tick);
          if (!/unavailable/.test(t.textContent || "")) t.textContent = fmtDuration((Date.now() - started) / 1000);
        }, 1000);
        jobTimer = window.setTimeout(poll, 1200);
      } else if (j.status === "failed") {
        jobHost.append(
          h("div", { class: "banner bad", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("b", { text: "Slicing failed" }), h("p", { text: j.error || "OrcaSlicer exited with an error." }))),
        );
        if (j.log_tail) jobHost.appendChild(logBox(j.log_tail, true));
      } else {
        const out = state.files.find((x) => x.id === j.result_file_id);
        jobHost.append(h("div", { class: "row" }, h("span", { class: "pill ok", text: "Sliced" }), h("span", { text: out ? out.name : j.result_file_id || "" })));
        if (j.estimate) jobHost.appendChild(estimateTiles(j.estimate));
        if (out) {
          jobHost.append(
            h("div", { class: "row" }, btn("Preview G-code", { icon: "layers", onClick: () => select_(out.id) })),
            h("p", { class: "subhead", text: "Send to a printer" }),
            sendPanel(out, j.printer_id),
          );
        } else if (j.result_file_id) {
          jobHost.appendChild(h("p", { class: "reason", text: "Loading the result…" }));
        }
      }
    }
    if (job) renderJob(job);
  }

  function logBox(text: string, open: boolean) {
    return h("details", { class: "log", open }, h("summary", { text: "OrcaSlicer log" }), h("pre", { text }));
  }

  function estimateTiles(e: NonNullable<FileRec["estimate"]>) {
    const tile = (k: string, v: string) => h("div", { class: "tile" }, h("div", { class: "k", text: k }), h("div", { class: "v", text: v }));
    return h("div", { class: "est" }, tile("Print time", fmtDuration(e.print_time_s)), tile("Filament", fmtFilament(e)), tile("Layers", e.layers != null ? String(e.layers) : "—"));
  }

  // ── send ─────────────────────────────────────────────────────────────
  function sendPanel(f: FileRec, preferPrinter?: string): HTMLElement {
    const wrap = h("div", { class: "stack" });
    if (!state.printers.length) {
      wrap.append(h("p", { class: "reason", text: "Add a printer first." }), h("div", { class: "row" }, btn("Add printer", { icon: "plus", onClick: goPrinters })));
      return wrap;
    }
    const opts = state.printers.map((p) => ({
      value: p.id,
      label: accepts(p.type, f.kind) ? `${p.name} (${TYPE_SHORT[p.type] || p.type})` : `${p.name} — needs ${p.type === "bambu" ? ".gcode.3mf" : ".gcode"}`,
      disabled: !accepts(p.type, f.kind),
    }));
    const compatible = state.printers.filter((p) => accepts(p.type, f.kind));
    // Default to the slice's printer, else a ready one, else any reachable one.
    const st = (p: Printer) => state.status.get(p.id)?.state;
    const first =
      (preferPrinter && compatible.find((p) => p.id === preferPrinter)?.id) ||
      compatible.find((p) => st(p) === "idle" || st(p) === "finished")?.id ||
      compatible.find((p) => st(p) && st(p) !== "offline")?.id ||
      compatible[0]?.id ||
      "";
    const sel = select("pf-send-" + f.id, [{ value: "", label: compatible.length ? "Choose a printer…" : "No compatible printer", disabled: true }].concat(opts as any), first);
    const bambuOpts = h("div", { class: "row" });
    const plate = h("input", { type: "number", min: "1", max: "16", value: "1", id: "pf-plate", style: { width: "70px" } }) as HTMLInputElement;
    const ams = h("input", { type: "checkbox", id: "pf-ams" }) as HTMLInputElement;
    const level = h("input", { type: "checkbox", id: "pf-level", checked: true }) as HTMLInputElement;
    bambuOpts.append(
      h("label", { class: "check", for: "pf-plate" }, "Plate", plate),
      h("label", { class: "check", for: "pf-ams" }, ams, "Use AMS"),
      h("label", { class: "check", for: "pf-level" }, level, "Bed leveling"),
    );
    const upBtn = btn("Upload only", { icon: "upload" });
    const goBtn = btn("Upload & start", { icon: "play", cls: "primary" });
    const reason = h("span", { class: "reason" });
    const sync = () => {
      const p = printerById(sel.value);
      bambuOpts.hidden = p?.type !== "bambu";
      const st = p ? state.status.get(p.id) : undefined;
      let why = "";
      if (!f.complete) why = "The upload didn't finish.";
      else if (!compatible.length) why = f.kind === "gcode.3mf" ? "Only Bambu printers take .gcode.3mf files." : "Bambu printers need a .gcode.3mf — slice with a Bambu printer profile.";
      else if (!p) why = "Choose a printer.";
      upBtn.disabled = goBtn.disabled = !!why;
      if (!why && st && (st.state === "printing" || st.state === "paused")) {
        goBtn.disabled = true;
        why = `${p!.name} is busy — you can upload now and start it later from the Farm tab.`;
      }
      reason.textContent = why;
    };
    sel.addEventListener("change", sync);
    sync();
    const send = async (start: boolean) => {
      const p = printerById(sel.value);
      if (!p) return;
      if (start) {
        const ok = await confirmDialog({
          title: "Start printing?",
          body: h(
            "div",
            { class: "stack" },
            h("p", { text: `This will start the printer “${p.name}” printing ${f.name}.` }),
            h("p", { text: "Make sure the build plate is clear and the right filament is loaded." }),
          ),
          confirm: "Upload & start",
        });
        if (!ok) return;
      }
      upBtn.disabled = goBtn.disabled = true;
      reason.textContent = `Uploading to ${p.name}…`;
      try {
        const options = p.type === "bambu" ? { plate: Math.max(1, Number(plate.value) || 1), use_ams: ams.checked, bed_leveling: level.checked } : undefined;
        const r = await post<{ print: Print }>("print", { printer_id: p.id, file_id: f.id, start, options });
        if (start) toast(`Started ${f.name} on ${p.name}.`, "ok");
        else toast(`Uploaded to ${p.name}. It's waiting on the Farm tab — press Start when the plate is clear.`, "ok");
        state.prints.unshift(r.print);
        goFarm();
      } catch (e) {
        toast(`Couldn't send to ${p.name}: ${errText(e)}`, "bad");
        sync();
      }
    };
    upBtn.onclick = () => send(false);
    goBtn.onclick = () => send(true);
    wrap.append(field("Printer", sel, { forId: sel.id }).el, bambuOpts, h("div", { class: "row" }, upBtn, goBtn), reason);
    return wrap;
  }

  // Theme changes (prefers-color-scheme) → recolour the viewer.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (viewer) {
      viewer.applyTheme(viewerTheme());
      if (selected) preview();
    }
  });

  return {
    el,
    show() {
      active = true;
      renderFiles();
      renderActions(true);
      if (!state.printersLoaded) loadPrinters().then(() => renderActions()).catch(() => {});
      // Printer states pick a sensible default in the send panel.
      if (!state.status.size)
        get<{ printers: { id: string; status: Status }[] }>("status")
          .then((r) => {
            if (!state.status.size) state.status = new Map(r.printers.map((x) => [x.id, x.status]));
          })
          .catch(() => {});
      loadDiagnostics().then(() => renderActions());
      loadFiles();
      if (!selected) preview();
    },
    hide() {
      active = false;
      clearTimeout(jobTimer);
    },
  };
}

export type { Printer };
