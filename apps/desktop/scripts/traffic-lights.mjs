#!/usr/bin/env node
/**
 * macOS title bar check in the browser (dev server, `?demo=1&titlebar=mac`): the placeholder traffic lights (drawn from the
 * same constants as `trafficLightPosition`) against the top bar's buttons and the sidebar's glyph column.
 *
 *   node apps/desktop/scripts/traffic-lights.mjs [--url http://localhost:1497] [--shots DIR] [--label before|after] [--no-assert]
 *
 * Asserts, in dark and light, with the sidebar shown / hidden and at the default / a widened width (tolerance 0.5 px):
 *   1. the lights' centre line = the toggle's, back's, forward's (and the first tab's) centre line;
 *   2. the red light's left edge = the left edge of the sidebar's glyph column (the Home glyph);
 *   3. green light -> toggle gap = toggle -> back gap (the bar's own gap);
 * and in `titlebar=mac-fullscreen` and a plain browser: no lights, no inset (the toggle's icon sits on the glyph column).
 * Needs Playwright (see packages/ui/scripts/browser.mjs). Exit code 1 when an assertion fails.
 */
import { mkdirSync } from "node:fs";
import { launchBrowser, newContext } from "../../../packages/ui/scripts/browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.indexOf(n) >= 0 && argv[argv.indexOf(n) + 1] ? argv[argv.indexOf(n) + 1] : d);
const BASE = opt("--url", "http://localhost:1497").replace(/\/$/, "");
const SHOTS = opt("--shots", "");
const LABEL = opt("--label", "run");
const ASSERT = !argv.includes("--no-assert");
const TOL = 0.5;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Runs in the page: the rectangles that matter. */
function measure() {
  const r = (e) => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 };
  };
  const byLabel = (re) => [...document.querySelectorAll("button[aria-label]")].find((b) => re.test(b.getAttribute("aria-label") ?? ""));
  const homeRow = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Home");
  return {
    lights: [...document.querySelectorAll("[data-mac-light]")].map(r),
    toggle: r(byLabel(/sidebar$/i)),
    back: r(byLabel(/^Previous page$/)),
    fwd: r(byLabel(/^Next page$/)),
    tab: r(document.querySelector('[role="tab"]')),
    homeRow: r(homeRow),
    homeGlyph: r(homeRow?.querySelector("svg") ?? null),
    statusGlyph: r(document.querySelector("[data-status-bar] svg")),
  };
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}  ${detail}`);
  if (!ok) failures.push(name);
};
const near = (a, b) => Math.abs(a - b) <= TOL;
const f = (n) => (n === undefined || n === null ? "n/a" : n.toFixed(2));

async function run(browser, { theme, query, width, hide, tag }) {
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: theme });
  await ctx.addInitScript(
    ([t, w]) => {
      try {
        localStorage.setItem("octo.theme", t);
        if (w) localStorage.setItem("octo.sidebarWidth", String(w));
      } catch {
        /* no storage */
      }
    },
    [theme, width],
  );
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=1${query}`);
  await page.waitForSelector("[data-title-bar]");
  await page.waitForTimeout(1800);
  if (hide) {
    await page.getByRole("button", { name: /Hide sidebar/ }).click();
    await page.waitForTimeout(600);
  }
  const m = await page.evaluate(measure);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${LABEL}-${tag}.png`, clip: { x: 0, y: 0, width: 700, height: 160 } });
  await ctx.close();
  return m;
}

const browser = await launchBrowser();
for (const theme of ["dark", "light"]) {
  for (const hide of [false, true]) {
    for (const width of [null, 380]) {
      if (hide && width) continue;
      const tag = `${theme}-${hide ? "sidebar-hidden" : width ? "sidebar-wide" : "sidebar-default"}`;
      const m = await run(browser, { theme, query: "&titlebar=mac", width, hide, tag });
      const [red, , green] = m.lights;
      if (!ASSERT) continue;
      if (!red || !green || !m.toggle || !m.back) {
        check(`${tag} elements found`, false, JSON.stringify(m));
        continue;
      }
      const cy = m.lights.map((l) => l.cy);
      for (const [name, el] of [
        ["toggle", m.toggle],
        ["back", m.back],
        ["forward", m.fwd],
        ["first tab", m.tab],
      ]) {
        if (el) check(`${tag} lights centre = ${name} centre`, cy.every((y) => near(y, el.cy)), `lights ${cy.map(f)} vs ${f(el.cy)}`);
      }
      if (!hide) {
        check(`${tag} red left = Home glyph left`, near(red.left, m.homeGlyph.left), `${f(red.left)} vs ${f(m.homeGlyph.left)}`);
        console.log(`     (Home row box left ${f(m.homeRow.left)}, status-bar glyph left ${f(m.statusGlyph?.left)})`);
      }
      const gapLights = m.toggle.left - green.right;
      const gapButtons = m.back.left - m.toggle.right;
      check(`${tag} green -> toggle gap = toggle -> back gap`, near(gapLights, gapButtons), `${f(gapLights)} vs ${f(gapButtons)}`);
    }
  }
}
// Full screen and a plain browser: no lights, no reserved inset.
for (const [query, tag] of [
  ["&titlebar=mac-fullscreen", "fullscreen"],
  ["", "browser"],
]) {
  const m = await run(browser, { theme: "dark", query, width: null, hide: false, tag });
  if (!ASSERT) continue;
  check(`${tag} no lights drawn`, m.lights.length === 0, `${m.lights.length}`);
  check(`${tag} no inset (toggle icon on the glyph column)`, near(m.toggle.left + 6, m.homeGlyph.left), `${f(m.toggle.left + 6)} vs Home glyph ${f(m.homeGlyph.left)}`);
}
await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log(ASSERT ? "\nall traffic-light assertions hold" : "\nshots only");
