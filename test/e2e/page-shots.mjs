#!/usr/bin/env node
// Browser walkthrough of the Print Farm page against a running scratch
// Peckboard (plugin approved, a fake Moonraker printer added — see
// test/fixtures/fake-moonraker.js). Drives the real UI, asserts the key flows,
// and writes screenshots in light + dark and at phone width.
//
//   node test/e2e/page-shots.mjs <base-url> <user> <pass> <out-dir> <stl> <gcode>
//
// Uses the repo's Playwright (web/node_modules). Not part of `npm test`: it
// needs a live server, a built wasm and a printer to talk to.
import { createRequire } from "module";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../web/node_modules/playwright"));

const [base, user, pass, out, stl, gcode] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const shots = [];
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

async function session(scheme, viewport) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ colorScheme: scheme, viewport });
  const page = await ctx.newPage();
  await page.goto(base + "/");
  await page.getByRole("textbox", { name: "Username" }).fill(user);
  await page.getByRole("textbox", { name: "Password" }).fill(pass);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForTimeout(1500);
  return { browser, page };
}

async function open(page, tab) {
  await page.goto(`${base}/plugin-page/print-farm/print-farm?tab=${tab}`);
  const f = page.frameLocator('[data-testid="plugin-fullpage-frame"]');
  await f.locator("#app header").waitFor();
  return f;
}

async function shot(page, name, frame, selector) {
  const file = path.join(out, name + ".png");
  if (frame && selector) await frame.locator(selector).first().screenshot({ path: file });
  else await page.screenshot({ path: file });
  shots.push(file);
}

for (const scheme of ["light", "dark"]) {
  const { browser, page } = await session(scheme, { width: 1360, height: 900 });
  // Farm
  let f = await open(page, "farm");
  await f.locator(".card[data-id]").first().waitFor({ timeout: 15000 });
  await f.locator(".card img:not([hidden])").first().waitFor({ timeout: 15000 }).catch(() => fail("no camera image"));
  await page.waitForTimeout(800);
  await shot(page, `farm-${scheme}`);
  // Printers + forms
  f = await open(page, "printers");
  await f.locator(".prow").first().waitFor();
  await shot(page, `printers-${scheme}`);
  await f.getByRole("button", { name: "Add printer" }).first().click();
  await f.locator("#pf-type").selectOption("bambu");
  await f.locator("#pf-host").fill("192.168.1.50");
  await f.locator("#pf-host").blur();
  await page.waitForTimeout(300);
  await shot(page, `add-bambu-${scheme}`);
  if (!(await f.getByText("Enter the serial number").count())) fail("bambu serial validation missing");
  await f.getByRole("button", { name: "Cancel" }).click();
  // Slice: model + gcode previews
  f = await open(page, "slice");
  await f.locator(".file[data-id]").first().waitFor({ timeout: 15000 });
  await f.locator(".file[data-id]", { hasText: path.basename(stl) }).first().click();
  await f.locator(".viewer canvas").waitFor();
  await f.locator(".viewer .overlay[hidden]").waitFor({ timeout: 20000, state: "attached" });
  await page.waitForTimeout(600);
  await shot(page, `slice-model-${scheme}`);
  await f.locator(".slice .stack > .panel").last().scrollIntoViewIfNeeded();
  await shot(page, `slice-form-${scheme}`, f, ".slice .stack > .panel >> nth=-1");
  await f.locator(".file[data-id]", { hasText: path.basename(gcode) }).first().click();
  await f.locator("#pf-layer").waitFor({ timeout: 20000 });
  await f.locator("#pf-layer").fill("30");
  await f.locator("#pf-travel").check();
  await page.waitForTimeout(500);
  const lbl = await f.locator(".layerbar .lbl").textContent();
  if (!/^Layer 30 \//.test(lbl || "")) fail("layer label: " + lbl);
  await f.locator(".viewer").scrollIntoViewIfNeeded();
  await shot(page, `slice-gcode-${scheme}`);
  await shot(page, `send-panel-${scheme}`, f, ".slice .stack > .panel >> nth=-1");
  await browser.close();
}

// Flows (light): cancel any running print (confirm) → upload-only → queue →
// Start (confirm) → printing → pause → resume.
{
  const { browser, page } = await session("light", { width: 1360, height: 900 });
  let f = await open(page, "farm");
  await f.locator(".card[data-id]").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const cancel = f.locator(".card-foot").getByRole("button", { name: "Cancel" });
  if (await cancel.count()) {
    await cancel.first().click();
    await f.getByRole("dialog").getByRole("button", { name: "Cancel print" }).click();
    await f.locator(".card .pill", { hasText: "Idle" }).first().waitFor({ timeout: 15000 });
  }
  await f.getByRole("tab", { name: "Slice" }).click();
  await f.locator(".file[data-id]", { hasText: path.basename(gcode) }).first().click();
  await page.waitForTimeout(1500); // let the panel settle after the initial loads
  const sel = f.locator('select[id^="pf-send-"]');
  await sel.selectOption(await sel.locator("option", { hasText: "Voron" }).getAttribute("value"));
  await f.getByRole("button", { name: "Upload only" }).click();
  await f.locator(".qitem", { hasText: path.basename(gcode) }).first().waitFor({ timeout: 20000 });
  await shot(page, "farm-queue-light");
  await f.locator(".qitem").first().getByRole("button", { name: "Start print" }).click();
  await f.getByRole("dialog").getByText("This will start the printer").waitFor();
  await shot(page, "start-confirm-light");
  await f.getByRole("dialog").getByRole("button", { name: "Start print" }).click();
  await f.locator(".card .pill", { hasText: "Printing" }).first().waitFor({ timeout: 15000 });
  await f.locator(".card-foot").getByRole("button", { name: "Pause" }).first().click();
  await f.locator(".card .pill", { hasText: "Paused" }).first().waitFor({ timeout: 15000 });
  await f.locator(".card-foot").getByRole("button", { name: "Resume" }).first().click();
  await f.locator(".card .pill", { hasText: "Printing" }).first().waitFor({ timeout: 15000 });
  console.log("flows ok: cancel → upload-only → queue → start → pause → resume");
  await browser.close();
}

// Phone width (dark)
{
  const { browser, page } = await session("dark", { width: 390, height: 844 });
  let f = await open(page, "farm");
  await f.locator(".card[data-id]").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot(page, "farm-mobile-dark");
  f = await open(page, "slice");
  await f.locator(".file[data-id]").first().waitFor({ timeout: 15000 });
  await shot(page, "slice-mobile-dark");
  await browser.close();
}

console.log(shots.join("\n"));
