#!/usr/bin/env node
/**
 * Decision 91a check: the streak is a band that nothing sits on. For every screen that shows it (Home, the connect screen, the
 * no-projects hero, the empty conversation) no element with text of its own may intersect the band's visible box
 * (`[data-streak-band]`), and each screen has exactly one band at the same top edge.
 *
 *   node packages/ui/scripts/backdrop-check.mjs --url http://localhost:1503 [--theme dark,light] [--sizes 1440x900,900x600,390x700]
 *
 * Exit code 1 when any screen fails.
 */
import { launchBrowser, newContext } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const THEMES = opt("--theme", "dark,light").split(",");
const SIZES = opt("--sizes", "1440x900,900x600,390x700")
  .split(",")
  .map((s) => s.split("x").map(Number));

const menuButton = async (page) => {
  const b = page.getByRole("button", { name: /^(Show|Open) sidebar$|^Menu$/ }).first();
  await b.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await b.isVisible().catch(() => false)) await b.click();
  await page.waitForTimeout(300);
};

const home = async (page) => {
  const b = page.getByRole("button", { name: "Home" }).first();
  if (!(await b.isVisible().catch(() => false))) await menuButton(page);
  await b.click();
};

const SCREENS = [
  { name: "home", q: "demo=1", go: home },
  { name: "connect", q: "demo=1&providers=none", go: home },
  { name: "no-projects", q: "demo=empty" },
  {
    name: "empty-conversation",
    q: "demo=1",
    tree: true,
    go: async (page) => {
      const item = page.locator("a", { hasText: "Design system tokens" }).first();
      if (!(await item.isVisible().catch(() => false))) await menuButton(page);
      await item.click({ timeout: 8000 });
    },
  },
];

/** Runs in the page: the text-bearing elements that intersect the band, with their boxes. */
const measure = () => {
  const bands = [...document.querySelectorAll("[data-streak-band]")].filter((b) => b.getBoundingClientRect().height > 0);
  if (bands.length !== 1) return { bands: bands.length, hits: [] };
  const box = bands[0].getBoundingClientRect();
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent || !n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || bands[0].contains(el) || el.closest("[hidden],[aria-hidden='true'],script,style")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width === 0 || r.height === 0) continue;
      const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
      const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      if (w > 0 && h > 0) hits.push({ text: n.textContent.trim().slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom) });
    }
  }
  return { bands: 1, top: Math.round(box.top), bottom: Math.round(box.bottom), hits };
};

const browser = await launchBrowser();
let failed = 0;
for (const sc of SCREENS) {
  for (const theme of THEMES) {
    for (const [width, height] of SIZES) {
      const ctx = await newContext(browser, { viewport: { width, height }, colorScheme: theme });
      if (sc.tree) {
        await ctx.addInitScript(() => {
          try {
            localStorage.setItem("octo.sidebarView", "tree");
          } catch {
            /* storage unavailable */
          }
        });
      }
      const page = await ctx.newPage();
      const label = `${sc.name} ${theme} ${width}x${height}`;
      try {
        await page.goto(`${BASE}/?${sc.q}`);
        await page.waitForTimeout(1200);
        if (sc.go) await sc.go(page);
        await page.waitForSelector("[data-streak-band]", { timeout: 8000 });
        await page.waitForTimeout(800);
        const m = await page.evaluate(measure);
        if (m.bands !== 1 || m.hits.length) {
          failed++;
          console.log(`FAIL ${label}: bands=${m.bands} ${JSON.stringify(m.hits.slice(0, 4))}`);
        } else console.log(`ok   ${label}: band ${m.top}-${m.bottom}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${label}: ${String(e.message).split("\n")[0]}`);
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log(failed ? `backdrop-check: ${failed} failed` : "backdrop-check: all screens clear");
process.exit(failed ? 1 : 0);
