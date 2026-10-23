// Project 3MFs (Bambu Studio / OrcaSlicer) carry the slicer settings they
// were saved with: Metadata/project_settings.config, model_settings.config
// (plates, per-object settings), slice_info, and an `Application` /
// `BambuStudio:3mfVersion` stamp in 3D/3dmodel.model. Print Farm slices with
// its OWN printer/filament/process presets, and the CLI rejects what it
// can't read — a file from a newer Bambu Studio fails with "Unsupported 3MF
// version", and `--allow-newer-file` only moves that to "Invalid parameter
// value(s) included in the 3mf file". So before slicing, the job gets a
// geometry-only copy: every `Metadata/*` entry dropped, the two stamps cut
// from the root model, `3D/Objects/*.model` components kept. A plain 3MF (no
// Metadata/) is used as is.
//
// The copy is written by python3's zipfile (no zip tool on minimal hosts;
// the model is too big to round-trip through the plugin). No python3 → the
// original is sliced and Orca's own error says why if that fails.

import { sh } from "./storage";

/// argv: <src.3mf> <dst.3mf>. Prints `stripped` (dst written) or `plain`.
export const STRIP_3MF_PY = `import re, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
if not any(n.startswith("Metadata/") for n in zin.namelist()):
    print("plain"); sys.exit(0)
stamp = re.compile(r'[ \\t]*<metadata name="(?:Application|BambuStudio:3mfVersion)"(?:\\s*/>|[^>]*>.*?</metadata>)[ \\t]*\\r?\\n?', re.S)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        if info.filename.startswith("Metadata/"):
            continue
        data = zin.read(info.filename)
        if info.filename == "3D/3dmodel.model":
            data = stamp.sub("", data.decode("utf-8")).encode("utf-8")
        zout.writestr(info.filename, data, zipfile.ZIP_DEFLATED)
print("stripped")
`;

/// The model path to hand OrcaSlicer: a geometry-only copy at `dst` for a
/// project 3MF, else `src` unchanged (never throws).
export function sliceableModel(src: string, dst: string): { path: string; stripped: boolean } {
  if (!/\.3mf$/i.test(src)) return { path: src, stripped: false };
  try {
    const out = sh(
      'command -v python3 >/dev/null 2>&1 || { echo nopython; exit 0; }; python3 -c "$1" "$2" "$3" 2>&1 || true',
      [STRIP_3MF_PY, src, dst],
      120,
    ).trim();
    if (out.split("\n").pop() === "stripped") return { path: dst, stripped: true };
  } catch (_e) {
    /* fall through: slice the original */
  }
  return { path: src, stripped: false };
}
