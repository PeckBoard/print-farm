// Slicing with the OrcaSlicer CLI, as a detached background job.
//
// A slice can take minutes — past the plugin call budget and exec's 600s cap
// — so the job is launched detached (nohup, output to a log, exit code to a
// file) and polled. The CLI line (see buildOrcaArgs):
//
//   orca-slicer --arrange 1 [--orient 1] --slice 0
//     --load-settings "<job>/printer.json;<job>/process.json"
//     --load-filaments "<job>/filament.json"
//     --outputdir <job>/out [--export-3mf result.gcode.3mf] <model>
//
// `--slice 0` slices every plate; plain targets get `<out>/plate_1.gcode`,
// Bambu targets get `<out>/result.gcode.3mf` (G-code embedded). On a headless
// host the run is wrapped in `xvfb-run -a` when no DISPLAY is set and
// xvfb-run is installed (setting `orca_headless`).

import { storeGet, storePut, storeList } from "./host";
import { nextSeq } from "./counter";
import { orcaPath, orcaHeadless } from "./config";
import { sh, storageDir, requireFile, newFileRecord, putFile, headTail, FileRecord, writeText } from "./storage";
import { parseGcodeEstimate, GcodeEstimate } from "./gcode";
import { resolveProfile, isBambuMachine } from "./profiles";
import { getPrinter } from "./printers";

export type SliceTarget = "gcode" | "gcode.3mf";

export interface SliceJob {
  id: string;
  status: "running" | "succeeded" | "failed";
  model_file_id: string;
  printer_id?: string;
  profiles: { printer: string; filament: string; process: string; vendor?: string };
  target: SliceTarget;
  dir: string;
  pid: number;
  command: string[];
  result_file_id?: string;
  estimate?: GcodeEstimate;
  error?: string;
  log_tail?: string;
}

// ── pure ────────────────────────────────────────────────────────────────────

export interface OrcaArgsInput {
  orca: string;
  modelPath: string;
  jobDir: string;
  target: SliceTarget;
  arrange?: boolean;
  orient?: boolean;
}

export const RESULT_3MF = "result.gcode.3mf";

/// The OrcaSlicer CLI argv (program first). Pure — tested.
export function buildOrcaArgs(i: OrcaArgsInput): string[] {
  const a = [i.orca, "--arrange", i.arrange === false ? "0" : "1"];
  if (i.orient) a.push("--orient", "1");
  a.push(
    "--slice", "0",
    "--load-settings", `${i.jobDir}/printer.json;${i.jobDir}/process.json`,
    "--load-filaments", `${i.jobDir}/filament.json`,
    "--outputdir", `${i.jobDir}/out`,
  );
  if (i.target === "gcode.3mf") a.push("--export-3mf", RESULT_3MF);
  a.push(i.modelPath);
  return a;
}

export interface PollResult {
  exited: boolean;
  exitCode: number | null;
  alive: boolean;
  outFiles: string[];
  logTail: string;
  resultJson: any | null;
}

/// Parse the poll script's output. Pure — tested.
export function parsePoll(out: string): PollResult {
  const sections: Record<string, string[]> = {};
  let cur = "";
  for (const line of out.split("\n")) {
    const m = /^@@([A-Z]+)$/.exec(line);
    if (m) {
      cur = m[1];
      sections[cur] = [];
    } else if (cur) {
      sections[cur].push(line);
    }
  }
  const sec = (tag: string) => (sections[tag] ?? []).join("\n");
  const exitRaw = sec("EXIT").trim();
  const code = exitRaw === "" ? null : Number(exitRaw);
  let resultJson: any = null;
  const rj = sec("RESULT").trim();
  if (rj) {
    try {
      resultJson = JSON.parse(rj);
    } catch (_e) {
      resultJson = null;
    }
  }
  return {
    exited: code !== null && isFinite(code),
    exitCode: code !== null && isFinite(code) ? code : null,
    alive: sec("ALIVE").trim() === "1",
    outFiles: sec("LS").split("\n").map((s) => s.trim()).filter(Boolean),
    logTail: sec("LOG"),
    resultJson,
  };
}

/// Decide a finished job's outcome. Pure — tested.
export function settle(p: PollResult, target: SliceTarget): { status: SliceJob["status"]; output?: string; error?: string } {
  if (!p.exited) {
    if (p.alive) return { status: "running" };
    return { status: "failed", error: "OrcaSlicer exited without reporting a result (crashed or killed)" };
  }
  const want = target === "gcode.3mf" ? RESULT_3MF : p.outFiles.find((f) => /^plate_\d+\.gcode$/.test(f)) ?? "";
  const rjErr = p.resultJson && (p.resultJson.error_string || p.resultJson.message);
  if (p.exitCode === 0 && want && p.outFiles.includes(want)) return { status: "succeeded", output: want };
  const lastLog = p.logTail.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  return {
    status: "failed",
    error: String(rjErr || lastLog || `OrcaSlicer exited with code ${p.exitCode} and produced no output`),
  };
}

// ── job store ───────────────────────────────────────────────────────────────

const JOBS = "slice_jobs";

export function getJob(id: string): SliceJob | null {
  return (storeGet(JOBS, id) as SliceJob) ?? null;
}

export function listJobs(): SliceJob[] {
  return storeList(JOBS)
    .map((i) => i.value as SliceJob)
    .filter((j) => j && j.id)
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
}

function putJob(j: SliceJob): void {
  storePut(JOBS, j.id, j);
}

export interface SliceRequest {
  file_id: string;
  printer_id?: string;
  printer_profile?: string;
  filament_profile?: string;
  process_profile?: string;
  vendor?: string;
  target?: SliceTarget;
  arrange?: boolean;
  orient?: boolean;
}

/// Is there a display, or a usable xvfb-run? Returns the argv prefix.
function headlessPrefix(): string[] {
  const mode = orcaHeadless();
  if (mode === "never") return [];
  const out = sh(
    'if [ "$1" = always ] || { [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; }; then command -v xvfb-run || true; fi',
    [mode],
    15,
  ).trim();
  return out ? ["xvfb-run", "-a"] : [];
}

const LAUNCH = [
  'dir=$1; shift',
  'mkdir -p "$dir/out" || exit 1',
  'cd "$dir/out" || exit 1',
  `nohup sh -c 'd=$1; shift; "$@" > "$d/orca.log" 2>&1; echo $? > "$d/exit"' sh "$dir" "$@" > /dev/null 2>&1 < /dev/null &`,
  'echo $!',
].join("\n");

export function startSlice(req: SliceRequest): SliceJob {
  const model = requireFile(req.file_id);
  if (!model.complete) throw new Error(`file ${model.id} is still uploading`);
  if (model.kind !== "model") throw new Error(`file ${model.id} (${model.name}) is not a model (STL/3MF/STEP/OBJ)`);

  const printer = req.printer_id ? getPrinter(req.printer_id) : null;
  if (req.printer_id && !printer) throw new Error(`unknown printer '${req.printer_id}'`);
  const names = {
    printer: req.printer_profile || printer?.orca_printer_profile || "",
    filament: req.filament_profile || printer?.orca_filament_profile || "",
    process: req.process_profile || printer?.orca_process_profile || "",
  };
  for (const [k, v] of Object.entries(names)) {
    if (!v) throw new Error(`${k}_profile is required (or set a default on the printer)`);
  }

  const machine = resolveProfile(names.printer, "printer", req.vendor);
  const vendor = req.vendor || machine.vendor || undefined;
  const process = resolveProfile(names.process, "process", vendor);
  const filament = resolveProfile(names.filament, "filament", vendor);
  const target: SliceTarget =
    req.target ?? (printer?.type === "bambu" || isBambuMachine(machine.profile, machine.vendor) ? "gcode.3mf" : "gcode");

  const id = "j" + nextSeq("slice_seq");
  const dir = `${storageDir()}/jobs/${id}`;
  sh('mkdir -p "$1/out"', [dir]);
  writeText(`${dir}/printer.json`, JSON.stringify(machine.profile, null, 2));
  writeText(`${dir}/process.json`, JSON.stringify(process.profile, null, 2));
  writeText(`${dir}/filament.json`, JSON.stringify(filament.profile, null, 2));

  const command = [
    ...headlessPrefix(),
    ...buildOrcaArgs({ orca: orcaPath(), modelPath: model.path, jobDir: dir, target, arrange: req.arrange, orient: req.orient }),
  ];
  const pid = Number(sh(LAUNCH, [dir, ...command], 30).trim());
  const job: SliceJob = {
    id,
    status: "running",
    model_file_id: model.id,
    profiles: { ...names, vendor },
    target,
    dir,
    pid: isFinite(pid) ? pid : 0,
    command,
  };
  if (printer) job.printer_id = printer.id;
  putJob(job);
  return job;
}

const POLL = [
  'd=$1; pid=$2',
  'echo @@EXIT; cat "$d/exit" 2>/dev/null',
  'echo @@ALIVE; if [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; then echo 1; else echo 0; fi',
  'echo @@LS; ls -1 "$d/out" 2>/dev/null',
  'echo @@RESULT; cat "$d/out/result.json" 2>/dev/null',
  'echo @@LOG; tail -c 3000 "$d/orca.log" 2>/dev/null',
  'true',
].join("\n");

/// Poll a job and, when it has finished, register its output as a file.
export function pollSlice(id: string): SliceJob {
  const job = getJob(id);
  if (!job) throw new Error(`unknown slice job '${id}'`);
  if (job.status !== "running") return job;
  const p = parsePoll(sh(POLL, [job.dir, String(job.pid)], 30));
  const outcome = settle(p, job.target);
  if (outcome.status === "running") return { ...job, log_tail: p.logTail.slice(-1500) };
  const next: SliceJob = { ...job, status: outcome.status, log_tail: p.logTail.slice(-1500) };
  if (outcome.status === "failed") {
    next.error = outcome.error;
  } else if (outcome.output) {
    const model = requireFile(job.model_file_id);
    const base = model.name.replace(/\.[^.]+$/, "");
    const rec: FileRecord = newFileRecord(`${base}.${job.target}`, "slice");
    const src = `${job.dir}/out/${outcome.output}`;
    const size = sh('mv -- "$1" "$2" && wc -c < "$2"', [src, rec.path], 60).trim();
    const done: FileRecord = { ...rec, size: Number(size) || 0, complete: true, slice_job: job.id };
    done.estimate = estimateFor(done, `${job.dir}/out`);
    putFile(done);
    next.result_file_id = done.id;
    next.estimate = done.estimate;
  }
  putJob(next);
  return next;
}

function estimateFor(f: FileRecord, outDir: string): GcodeEstimate | undefined {
  try {
    if (f.kind === "gcode") return parseGcodeEstimate(headTail(f.path));
    // .gcode.3mf: the G-code is embedded at Metadata/plate_1.gcode.
    const text = sh(
      'if command -v unzip >/dev/null 2>&1; then unzip -p "$1" Metadata/plate_1.gcode > "$2/plate.tmp" 2>/dev/null; ' +
        'elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(\'Metadata/plate_1.gcode\'))" "$1" > "$2/plate.tmp"; fi; ' +
        '[ -s "$2/plate.tmp" ] && { head -c 65536 "$2/plate.tmp"; echo; tail -c 65536 "$2/plate.tmp"; }; rm -f "$2/plate.tmp"; true',
      [f.path, outDir],
      60,
    );
    return text.trim() ? parseGcodeEstimate(text) : undefined;
  } catch (_e) {
    return undefined;
  }
}

/// Diagnostics for the UI: is the CLI reachable, does it need xvfb?
export function orcaDiagnostics(): Record<string, unknown> {
  const out = sh(
    'o=$1; p=$(command -v "$o" 2>/dev/null); echo "path=$p"; ' +
      'echo "display=${DISPLAY:-}${WAYLAND_DISPLAY:-}"; echo "xvfb=$(command -v xvfb-run 2>/dev/null)"; ' +
      'echo "curl=$(command -v curl 2>/dev/null)"; true',
    [orcaPath()],
    15,
  );
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return {
    orca_path: orcaPath(),
    orca_found: !!kv.path,
    orca_resolved: kv.path || null,
    display: !!kv.display,
    xvfb_run: kv.xvfb || null,
    headless_mode: orcaHeadless(),
    curl_found: !!kv.curl,
  };
}
