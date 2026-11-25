#!/usr/bin/env node
/**
 * Rule: scrolling never closes a popup list on its own. Scrolling inside it (wheel, keys, trackpad inertia, a finger) and a
 * programmatic scroll of its active row leave it open; a scroll outside closes it only when the anchor was moved by it
 * (`components/primitives/popupScroll.ts`). Drives the demo UI with Playwright:
 *
 *   1. the model list (`?providers=owner`, a window short enough that the list scrolls): wheel over it, PageDown / End / arrows,
 *      trackpad inertia (many tiny wheel steps), a `scroll` event that moved nothing; a transcript streaming under it,
 *   2. a Select in Settings: wheel over its list; the settings page scrolled under it closes it, a sidebar scrolled does not,
 *   3. the menu of a sidebar row (right click): wheel over it and over the conversation leave it open,
 *   4. (Chromium only) on a phone (390x844, touch) a swipe inside the \"+\" sheet leaves it open.
 *
 *   node packages/ui/scripts/dropdown-scroll.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--project "Atlas API"]
 *
 * Prints `dropdown-scroll: ok` or the failures. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { BROWSER, launchBrowser, newContext, PHONE, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const PROJECT = opt("--project", "Atlas API");
const POPUP = 'body > [role="menu"], body > .octo-overlay, body > [role="listbox"]';

/** On a phone a popup is a sheet over the page (`Sheet`, or a popover turned into one by CSS). */
const SHEET = `${POPUP}, body > .fixed.inset-0 [role="dialog"]`;

const fail = (why) => {
  console.error(`dropdown-scroll: could not drive the page: ${why}`);
  process.exit(2);
};
const failures = [];
const note = (what) => failures.push(what);
const problems = [];

const browser = await launchBrowser();
const ctx = await newContext(browser, { viewport: { width: 1440, height: 360 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("octo.theme", "dark");
    for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
});
const page = await ctx.newPage();
page.on("pageerror", (e) => isAbortedImport(e.message) || problems.push(`page error: ${String(e.stack ?? e).slice(0, 400)}`));

const open = () =>
  page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].some((e) => (!e.dataset.state || e.dataset.state === "open") && getComputedStyle(e).display !== "none"),
    POPUP,
  );
const box = () =>
  page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => !e.dataset.state || e.dataset.state === "open");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const list = [el, ...el.querySelectorAll("*")].find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: list ? list.scrollTop : null };
  }, POPUP);
const listTop = async () => (await box())?.top ?? null;
const wheel = async (x, y, dy, n = 1, gap = 20) => {
  await page.mouse.move(x, y);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(gap);
  }
  await page.waitForTimeout(250);
};
const close = async () => {
  if (await open()) await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
};
const must = async (name, cond) => {
  if (!(await cond())) note(name);
};

async function toProject() {
  await page.goto(`${BASE}/?demo=1&providers=owner`, { waitUntil: "domcontentloaded" });
  const link = page.locator('nav[aria-label="Projects"] a', { hasText: PROJECT }).first();
  await link.waitFor({ state: "attached", timeout: 10000 }).catch(() => fail("no project list"));
  await link.click();
  await page
    .locator("#octo-composer")
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => fail("no composer"));
  await page.waitForTimeout(1200);
}

// 1. The model list.
await toProject();
const model = page.locator("[data-composer] [data-model-picker]").first();
await model.click();
await page.waitForTimeout(400);
let b = await box();
if (!b) fail("the model list did not open");
if (b.top === null) fail("the model list does not scroll in this window");
{
  const t0 = b.top;
  await wheel(b.x, b.y, 300, 3);
  await must("model list: closed by a wheel over it", open);
  if ((await listTop()) <= t0) note("model list: the wheel over it did not scroll it");
  for (const k of ["PageDown", "End", "ArrowDown", "PageUp", "Home", "ArrowUp"]) {
    await page.keyboard.press(k);
    await page.waitForTimeout(80);
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(250);
  await must("model list: closed by PageDown / End / arrows", open);
  b = await box();
  await wheel(b.x, b.y, 3, 40, 8);
  await must("model list: closed by trackpad inertia over it", open);
  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
  await page.waitForTimeout(200);
  await must("model list: closed by a scroll event that moved nothing", open);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*"))
      if (el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
        el.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await page.waitForTimeout(200);
  await must("model list: closed by scroll events of boxes that did not move", open);
}
await close();

// 1g. A transcript streaming under the open list: it follows the end by itself.
{
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.waitForTimeout(500);
  const composer = page.locator("#octo-composer");
  await composer.click();
  await composer.fill("Summarise the failing tests and fix them one by one");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await model.click();
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => document.querySelector(".scroll-quiet")?.scrollTop ?? -1);
  let alive = true;
  for (let i = 0; i < 12 && alive; i++) {
    await page.waitForTimeout(250);
    alive = await open();
  }
  const after = await page.evaluate(() => document.querySelector(".scroll-quiet")?.scrollTop ?? -1);
  if (!alive) note("model list: closed while the answer streamed under it");
  console.log(`  stream: transcript scrollTop ${String(before)} -> ${String(after)}, list ${alive ? "stayed open" : "CLOSED"}`);
  await close();
}

// 2. A Select in Settings.
await page.setViewportSize({ width: 1440, height: 360 });
await page.goto(`${BASE}/?demo=1&providers=owner`, { waitUntil: "domcontentloaded" });
await page.locator('nav[aria-label="Projects"] a').first().waitFor({ state: "attached", timeout: 10000 });
await page.evaluate(() => (window.location.hash = "#/settings/usage"));
await page.waitForTimeout(1200);
{
  const period = page.locator('[role="combobox"][aria-label="Period"]');
  await period.click();
  await page.waitForTimeout(400);
  b = await box();
  if (!b) fail("the Period list did not open");
  await wheel(b.x, b.y, 300, 3);
  await must("settings Select: closed by a wheel over its list", open);
  await wheel(b.x, b.y, 3, 40, 8);
  await must("settings Select: closed by inertia over its list", open);
  await close();
  // The page the control sits in scrolls under it: it closes (the anchor left), or stays when nothing moved.
  const scroller = await period.evaluate((el) => {
    let e = el.parentElement;
    while (e && !(e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width * 0.9, y: r.y + r.height / 2, top: e.scrollTop };
  });
  if (scroller) {
    await period.click();
    await page.waitForTimeout(400);
    const a0 = await period.evaluate((el) => el.getBoundingClientRect().top);
    await wheel(scroller.x, scroller.y, 120, 2);
    const a1 = await period.evaluate((el) => el.getBoundingClientRect().top);
    const isOpen = await open();
    if (Math.abs(a1 - a0) > 1 && isOpen) note("settings Select: stayed open although the page scrolled it away from its list");
    if (Math.abs(a1 - a0) <= 1 && !isOpen) note("settings Select: closed by a scroll that did not move it");
    console.log(`  settings page: control moved ${(a1 - a0).toFixed(0)}px, list ${isOpen ? "open" : "closed"}`);
    await close();
  } else console.log("  settings page: not scrollable in this window (not asserted)");
}

// 3. The menu of a sidebar row.
await toProject();
{
  const row = page.locator('nav[aria-label="Projects"] a[aria-haspopup="menu"]').nth(1);
  await row.click({ button: "right" });
  await page.waitForTimeout(400);
  b = await box();
  if (!b) fail("the sidebar row menu did not open");
  await wheel(b.x, b.y, 300, 3);
  await must("row menu: closed by a wheel over it", open);
  await wheel(b.x, b.y, 3, 40, 8);
  await must("row menu: closed by inertia over it", open);
  const col = await page.evaluate(() => {
    const r = document.querySelector(".scroll-quiet")?.getBoundingClientRect();
    return r ? { x: r.x + r.width * 0.9, y: r.y + r.height / 2 } : null;
  });
  if (col) {
    await wheel(col.x, col.y, -200, 2);
    await must("row menu: closed by the conversation scrolling elsewhere", open);
  }
  await close();
}

// 4. A phone: a swipe inside the sheet (Chromium: real touch events through CDP).
if (BROWSER === "chromium") {
  const phone = await newContext(browser, { ...PHONE, colorScheme: "dark" });
  const p = await phone.newPage();
  await p.goto(`${BASE}/?demo=1&providers=owner`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  const href = await page.evaluate((n) => {
    for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href*="#/p/"]'))
      if (`${a.getAttribute("title") ?? ""} ${a.textContent}`.includes(n)) return a.getAttribute("href");
    return null;
  }, PROJECT);
  if (href) {
    await p.evaluate((h) => (window.location.hash = h.slice(h.indexOf("#"))), href);
    await p
      .locator("#octo-composer")
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => fail("phone: no composer"));
    await p.waitForTimeout(1200);
    const chip = p.locator('[data-composer] [aria-haspopup="listbox"]').first();
    if (await chip.count()) {
      await chip.tap();
      await p.waitForTimeout(500);
      const r = await p.evaluate((sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => !e.dataset.state || e.dataset.state === "open");
        if (!el) return null;
        const q = el.getBoundingClientRect();
        return { x: q.x + q.width / 2, y: q.y + q.height * 0.75 };
      }, SHEET);
      if (r) {
        const cdp = await phone.newCDPSession(p);
        const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: r.x, y }] });
        for (let rep = 0; rep < 3; rep++) {
          await touch("touchStart", r.y);
          for (let i = 1; i <= 10; i++) {
            await touch("touchMove", r.y - i * 14);
            await p.waitForTimeout(16);
          }
          await touch("touchEnd", 0);
          await p.waitForTimeout(250);
        }
        const still = await p.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => !e.dataset.state || e.dataset.state === "open"), SHEET);
        if (!still) note('phone: the "+" sheet closed by a swipe inside it');
      } else console.log('  phone: the "+" list did not open as a popup (not asserted)');
    } else console.log('  phone: no "+" button (not asserted)');
  } else console.log("  phone: no project link (not asserted)");
  await phone.close();
}

await browser.close();
for (const x of problems) failures.push(x);
if (failures.length) {
  console.error(`dropdown-scroll: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("dropdown-scroll: ok");
