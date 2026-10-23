// Runs the real install scripts against a FAKE home with stubbed downloads
// (file:// "releases") and stub systemctl/loginctl — never the real host's
// home. Also drives the OrcaSlicer auto-install end to end through
// ensureSetup and the wrapper-following profile detection.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const ROOT = resolve(__dirname, ".tmp-setup");
const HOME = join(ROOT, "home");
const BIN = join(ROOT, "bin");
const settings: Record<string, string> = {};
const store = new Map<string, unknown>();
const env: Record<string, string> = {};

vi.mock("../src/host", () => ({
  getSetting: (k: string) => settings[k] ?? null,
  storePut: (c: string, k: string, v: unknown) => void store.set(`${c}/${k}`, JSON.parse(JSON.stringify(v))),
  storeGet: (c: string, k: string) => store.get(`${c}/${k}`) ?? null,
  storeDelete: (c: string, k: string) => void store.delete(`${c}/${k}`),
  storeList: (c: string) =>
    [...store.entries()].filter(([k]) => k.startsWith(c + "/")).map(([k, value]) => ({ key: k.slice(c.length + 1), value })),
  execAny: (command: string, args: string[], timeout?: number) => {
    const r = spawnSync(command, args, { encoding: "utf8", timeout: (timeout ?? 120) * 1000, maxBuffer: 4 << 20, env: { ...process.env, ...env } });
    return { exit_code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", stdout_truncated: false, stderr_truncated: false, timed_out: false };
  },
  httpRequest: () => {
    throw new Error("no http in shell tests");
  },
}));

import { ORCA_INSTALL, ORCA_LIBS_INSTALL, BRIDGE_INSTALL, ensureSetup, invalidateSetup } from "../src/setup";
import { detectRoots, invalidateRoots } from "../src/profiles";
import { autoFill } from "../src/autoprofiles";
import { PrinterRecord } from "../src/drivers/types";
import { JOB_ALIVE } from "../src/storage";

const ARCH = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim() === "aarch64" ? "aarch64" : "x86_64";

function run(script: string, dir: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  return spawnSync("sh", ["-c", script, "sh", dir], { encoding: "utf8", env: { ...process.env, ...env, ...extra }, timeout: 60_000 });
}

function fakeAppImage(path: string) {
  // `--appimage-extract` unpacks a tiny Orca tree with one BBL machine preset.
  writeFileSync(
    path,
    `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 9
r=squashfs-root/resources/profiles/BBL/machine
mkdir -p "$r" squashfs-root/resources/profiles/BBL/process squashfs-root/resources/profiles/BBL/filament
printf '#!/bin/sh\\necho orca\\n' > squashfs-root/AppRun; chmod +x squashfs-root/AppRun
printf '{\\n  "type": "machine",\\n  "name": "Bambu Lab P1S 0.4 nozzle",\\n  "instantiation": "true",\\n  "default_print_profile": "0.20mm Standard @BBL X1C",\\n  "default_filament_profile": ["Bambu PLA Basic @BBL X1C"]\\n}\\n' > "$r/Bambu Lab P1S 0.4 nozzle.json"
`,
  );
  chmodSync(path, 0o755);
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  // Stub systemd: log every call; `show-environment` fails when NO_SYSTEMD=1.
  writeFileSync(join(BIN, "systemctl"), `#!/bin/sh\necho "$@" >> "$HOME/systemctl.log"\n[ "$NO_SYSTEMD" = 1 ] && [ "$2" = show-environment ] && exit 1\nexit 0\n`);
  writeFileSync(join(BIN, "loginctl"), `#!/bin/sh\necho "$@" >> "$HOME/loginctl.log"\n`);
  chmodSync(join(BIN, "systemctl"), 0o755);
  chmodSync(join(BIN, "loginctl"), 0o755);
  // Fake OrcaSlicer "releases": /latest resolves to tag "latest".
  const rel = join(ROOT, "orca-releases");
  mkdirSync(join(rel, "download/latest"), { recursive: true });
  writeFileSync(join(rel, "latest"), "");
  const suffix = ARCH === "aarch64" ? "_aarch64" : "";
  fakeAppImage(join(rel, `download/latest/OrcaSlicer_Linux_AppImage_Ubuntu2404${suffix}_Vlatest.AppImage`));
  // Fake print-bridge release + checksum.
  const dl = join(ROOT, "bridge-dl");
  mkdirSync(dl, { recursive: true });
  const asset = join(dl, `print-bridge-linux-${ARCH}`);
  writeFileSync(asset, "#!/bin/sh\necho print-bridge 0.1.3\n");
  writeFileSync(asset + ".sha256", createHash("sha256").update(readFileSync(asset)).digest("hex") + `  print-bridge-linux-${ARCH}\n`);
  // PATH without the real ~/.local/bin, so the host's own Orca stays invisible.
  Object.assign(env, {
    HOME,
    PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(HOME, ".config"),
    XDG_DATA_HOME: join(HOME, ".local/share"),
    PF_ORCA_RELEASES: "file://" + rel,
    PF_BRIDGE_RELEASES: "file://" + dl,
  });
  settings.storage_dir = join(ROOT, "store");
  settings.orca_headless = "never";
});

describe("detached job liveness", () => {
  it("counts a fresh heartbeat as alive when the pid isn't visible (other PID namespace)", () => {
    const d = join(ROOT, "hb");
    mkdirSync(d, { recursive: true });
    const alive = () => spawnSync("sh", ["-c", `d=${d}; pid=999999; ${JOB_ALIVE}`], { encoding: "utf8" }).stdout.trim();
    expect(alive()).toBe("0");
    writeFileSync(join(d, "hb"), "");
    expect(alive()).toBe("1");
  });
});

describe("print-bridge install script", () => {
  it("installs the checked binary, keeps an existing token, writes the unit, restarts", () => {
    mkdirSync(join(HOME, ".config/print-bridge"), { recursive: true });
    writeFileSync(join(HOME, ".config/print-bridge/token"), "keepme");
    const r = run(BRIDGE_INSTALL, join(ROOT, "job-bridge"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("print-bridge 0.1.3");
    expect(readFileSync(join(HOME, ".config/print-bridge/token"), "utf8")).toBe("keepme");
    const unit = readFileSync(join(HOME, ".config/systemd/user/print-bridge.service"), "utf8");
    expect(unit).toContain("ExecStart=%h/.local/bin/print-bridge --bind 127.0.0.1:7781 --token-file %h/.config/print-bridge/token");
    const calls = readFileSync(join(HOME, "systemctl.log"), "utf8");
    expect(calls).toMatch(/--user daemon-reload\n--user enable print-bridge\n--user restart print-bridge/);
    expect(readFileSync(join(HOME, "loginctl.log"), "utf8")).toContain("enable-linger");
  });
  it("creates a token when there is none", () => {
    rmSync(join(HOME, ".config/print-bridge/token"));
    expect(run(BRIDGE_INSTALL, join(ROOT, "job-bridge")).status).toBe(0);
    expect(readFileSync(join(HOME, ".config/print-bridge/token"), "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses a bad checksum and a host without systemd --user", () => {
    const bad = join(ROOT, "bridge-bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, `print-bridge-linux-${ARCH}`), "evil");
    writeFileSync(join(bad, `print-bridge-linux-${ARCH}.sha256`), "0".repeat(64) + "\n");
    const r = run(BRIDGE_INSTALL, join(ROOT, "job-bad"), { PF_BRIDGE_RELEASES: "file://" + bad });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256 mismatch");
    const n = run(BRIDGE_INSTALL, join(ROOT, "job-nosd"), { NO_SYSTEMD: "1" });
    expect(n.status).toBe(3);
    expect(n.stderr).toContain("no systemd user manager");
  });
});

describe("OrcaSlicer auto-install", () => {
  it("installs in the background on first check, then the profiles show up via the wrapper", async () => {
    invalidateRoots();
    expect(detectRoots().filter((r) => r.kind === "system")).toEqual([]);
    let s = ensureSetup();
    expect(s.orca.status).toBe("running");
    for (let i = 0; i < 100 && s.orca.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = ensureSetup();
    }
    expect(s.orca, JSON.stringify(s.orca)).toMatchObject({ status: "ok" });
    expect(readFileSync(join(HOME, ".local/bin/orca-slicer"), "utf8")).toBe(
      '#!/bin/sh\nexport LD_LIBRARY_PATH="$HOME/.local/share/orca-slicer/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\n',
    );
    expect(existsSync(join(HOME, ".local/share/orca-slicer/VERSION"))).toBe(true);
    // The wrapper isn't on PATH here; detection still finds the bundled tree.
    expect(detectRoots()).toContainEqual({ kind: "system", path: join(HOME, ".local/share/orca-slicer/resources/profiles") });
    // A Bambu printer without defaults gets the model's machine preset and
    // that preset's own default process + filament (model from the serial).
    const p: PrinterRecord = { id: "p9", name: "Shop P1S", type: "bambu", host: "10.0.0.9", bambu: { serial: "01P00A431400749", access_code: "x" } };
    expect(autoFill(p, true)).toMatchObject({
      orca_printer_profile: "Bambu Lab P1S 0.4 nozzle",
      orca_process_profile: "0.20mm Standard @BBL X1C",
      orca_filament_profile: "Bambu PLA Basic @BBL X1C",
    });
    // Installed now: a later check starts nothing.
    expect(ensureSetup().orca.status).toBe("ok");
  });
  it("surfaces the installer's real error and waits for Retry", async () => {
    store.delete("setup_jobs/orca");
    invalidateSetup();
    rmSync(join(HOME, ".local/share/orca-slicer"), { recursive: true, force: true });
    rmSync(join(HOME, ".local/bin/orca-slicer"), { force: true });
    invalidateRoots();
    env.PF_ORCA_RELEASES = "file://" + join(ROOT, "nowhere");
    let s = ensureSetup();
    for (let i = 0; i < 100 && s.orca.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = ensureSetup();
    }
    expect(s.orca.status).toBe("failed");
    expect(s.orca.error).toContain("couldn't reach");
    expect(ensureSetup().orca.status).toBe("failed"); // no automatic loop
    env.PF_ORCA_RELEASES = "file://" + join(ROOT, "orca-releases");
    expect(ensureSetup("orca").orca.status).toBe("running"); // Retry
  });
});

describe("OrcaSlicer missing-library fix", () => {
  // Stub ldd: libGLU is "not found" unless the first LD_LIBRARY_PATH dir (the
  // install's extra-lib) has it; libnope.so.7 is missing when MISS_NOPE=1.
  // Stub apt-get/dpkg-deb: only libglu1-mesa exists, and unpacks the real
  // .so + its soname symlink.
  beforeAll(async () => {
    // Let the Retry install above finish first: it replaces the same tree.
    for (let i = 0; i < 100 && ensureSetup().orca.status === "running"; i++) await new Promise((r) => setTimeout(r, 100));
    writeFileSync(
      join(BIN, "ldd"),
      `#!/bin/sh\nx=\${LD_LIBRARY_PATH%%:*}\n[ -e "$x/libGLU.so.1" ] || printf '\\tlibGLU.so.1 => not found\\n'\n[ "$MISS_NOPE" = 1 ] && printf '\\tlibnope.so.7 => not found\\n'\nprintf '\\tlibc.so.6 => /lib/libc.so.6\\n'\n`,
    );
    writeFileSync(join(BIN, "apt-get"), `#!/bin/sh\necho "$@" >> "$HOME/apt.log"\n[ "$1" = download ] && [ "$2" = libglu1-mesa ] && touch libglu1-mesa_9.0.2_amd64.deb && exit 0\nexit 100\n`);
    writeFileSync(
      join(BIN, "dpkg-deb"),
      `#!/bin/sh\n[ "$1" = -x ] || exit 2\nl="$3/usr/lib/x86_64-linux-gnu"; mkdir -p "$l"; echo so > "$l/libGLU.so.1.3.1"; ln -sf libGLU.so.1.3.1 "$l/libGLU.so.1"\n`,
    );
    for (const f of ["ldd", "apt-get", "dpkg-deb"]) chmodSync(join(BIN, f), 0o755);
  });
  const O = () => join(HOME, ".local/share/orca-slicer");
  const fakeInstall = () => {
    rmSync(O(), { recursive: true, force: true });
    mkdirSync(join(O(), "bin"), { recursive: true });
    writeFileSync(join(O(), "bin/orca-slicer"), "#!/bin/sh\n");
    chmodSync(join(O(), "bin/orca-slicer"), 0o755);
  };

  it("fetches the package rootless into extra-lib", () => {
    fakeInstall();
    const r = run(ORCA_LIBS_INSTALL, join(ROOT, "job-libs"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("fetched libGLU.so.1 from libglu1-mesa");
    expect(readFileSync(join(O(), "extra-lib/libGLU.so.1.3.1"), "utf8")).toBe("so\n");
    expect(existsSync(join(O(), "extra-lib/libGLU.so.1"))).toBe(true);
    // Already fixed: a second run does nothing.
    expect(run(ORCA_LIBS_INSTALL, join(ROOT, "job-libs")).stdout).not.toContain("fetched");
  });

  it("tries the Debian name guess for unmapped libs and fails naming what's left", () => {
    fakeInstall();
    const r = run(ORCA_LIBS_INSTALL, join(ROOT, "job-libs2"), { MISS_NOPE: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("fetched libGLU.so.1");
    expect(r.stderr).toContain("OrcaSlicer still can't load libnope.so.7");
    expect(readFileSync(join(HOME, "apt.log"), "utf8")).toMatch(/download libnope7\ndownload libnope7t64/);
  });

  it("is part of the full install too", () => {
    expect(ORCA_INSTALL).toContain("\nfix_libs\n");
  });
});