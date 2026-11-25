#!/usr/bin/env node
/**
 * Component gallery screenshots (decision 90): opens `?demo=1&gallery=1` and captures every `[data-gallery-section]`
 * in dark and light, and reports console errors and the measured height of the sized controls.
 *
 *   node packages/ui/scripts/gallery-shots.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--out <dir>] [--width 1440] [--height 900]
 *
 * Exit code 1 when the page logs a console error or a control is not the height of its size.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const OUT = opt("--out", "gallery-shots");
const VIEWPORT = { width: Number(opt("--width", "1440")), height: Number(opt("--height", "900")) };

const EXPECTED = { xs: 24, sm: 28, md: 32, lg: 40 };

mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser();
const errors = [];
const wrong = [];
for (const theme of ["dark", "light"]) {
  const page = await newPage(browser, { viewport: VIEWPORT });
  page.on("console", (m) => m.type() === "error" && errors.push(`[${theme}] ${m.text()}`));
  page.on("pageerror", (e) => isAbortedImport(e.message) || errors.push(`[${theme}] ${e.message}`));
  await page.goto(`${BASE}/?demo=1&gallery=1`);
  // The gallery is a fixed, scrolling page: a tall window lets each section be captured whole.
  await page.setViewportSize({ width: VIEWPORT.width, height: Math.max(VIEWPORT.height, 2600) });
  await page.waitForSelector("[data-gallery-section]");
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(300);
  const ids = await page.$$eval("[data-gallery-section]", (els) => els.map((e) => e.getAttribute("data-gallery-section")));
  for (const id of ids) {
    const section = page.locator(`[data-gallery-section="${id}"]`);
    await section.scrollIntoViewIfNeeded();
    const file = path.join(OUT, `${id}-${theme}.png`);
    await section.screenshot({ path: file });
    console.log(file);
  }
  if (theme === "dark") {
    // Boxed buttons are labelled "<size> <px>" in the Button rows (links have no box and read "link <size>").
    const boxes = await page.$$eval("[data-gallery-section=buttons] button", (els) =>
      els.map((e) => ({ text: (e.textContent ?? "").trim(), h: Math.round(e.getBoundingClientRect().height) })),
    );
    for (const b of boxes) {
      const m = /^(xs|sm|md|lg) \d+$/.exec(b.text);
      const want = m?.[1] ? EXPECTED[m[1]] : undefined;
      if (want !== undefined && b.h !== want) wrong.push(`${b.text}: ${b.h}px`);
    }
  }
  await page.close();
}
await browser.close();
console.log(`console errors: ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
console.log(`control heights off: ${wrong.length}`);
for (const w of wrong) console.log(`  ${w}`);
process.exit(errors.length || wrong.length ? 1 : 0);
