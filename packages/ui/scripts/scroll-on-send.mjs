#!/usr/bin/env node
/**
 * Rule: sending always scrolls to the sent message and re-pins to the bottom (owner: "the chat does not scroll down when a
 * message is sent"). Drives the demo UI with Playwright:
 *
 *   1. opens a project with a long conversation, scrolls the transcript to the top (the reader has let go of the end),
 *   2. sends a message from the composer,
 *   3. asserts that the newest request is on screen and the scroller sits at its end (within 8 px), and that the "Jump to
 *      latest" button is gone.
 *
 *   node packages/ui/scripts/scroll-on-send.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--width 1440] [--height 900] [--project "Atlas API"]
 *
 * Prints `scroll-on-send: ok` or the measurements. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const PROJECT = opt("--project", "Atlas API");

const fail = (why) => {
  console.error(`scroll-on-send: could not drive the page: ${why}`);
  process.exit(2);
};

const browser = await launchBrowser();
const ctx = await newContext(browser, { viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("octo.theme", "dark");
    for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
});
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => isAbortedImport(e.message) || problems.push(`page error: ${String(e.stack ?? e).slice(0, 600)}`));
await page.goto(`${BASE}/?demo=1`, { waitUntil: "domcontentloaded" });
const projects = page.locator('nav[aria-label="Projects"] a');
if (
  !(await projects
    .first()
    .waitFor({ state: "attached", timeout: 3000 })
    .then(
      () => true,
      () => false,
    ))
) {
  await page
    .getByRole("button", { name: /sidebar/i })
    .first()
    .click();
}
await projects.first().waitFor({ state: "attached", timeout: 10000 });
const href = await page.evaluate((n) => {
  for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]'))
    if ((a.getAttribute("title") || a.textContent.trim()).startsWith(n)) return a.getAttribute("href");
  return null;
}, PROJECT);
if (!href) fail(`project "${PROJECT}" not in the sidebar`);
await page.evaluate((h) => (window.location.hash = h.slice(h.indexOf("#"))), href);
await page.locator("[data-column]").first().waitFor({ timeout: 10000 });
await page.waitForTimeout(2500);

const scroller = () =>
  page.evaluate(() => {
    const col = document.querySelector("[data-column]");
    let el = col;
    while (el && !(el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible")) el = el.parentElement;
    return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null;
  });
const before = await scroller();
if (!before || before.height <= before.client + 200) fail("the conversation is not long enough to scroll");
// The reader has scrolled to the top: a wheel event, so the stick-to-bottom logic sees a reader and not a reflow.
await page.evaluate(() => {
  const col = document.querySelector("[data-column]");
  let el = col;
  while (el && !(el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible")) el = el.parentElement;
  if (el) {
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -el.scrollTop }));
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  }
});
await page.waitForTimeout(300);
const top = await scroller();
if (!top || top.top > 4) fail("could not scroll the conversation to the top");

const composer = page.locator("textarea#octo-composer:visible, textarea#octo-composer-float:visible").first();
await composer.waitFor({ timeout: 8000 }).catch(() => fail("no composer"));
const text = `scroll check ${Date.now()}`;
await composer.click();
await page.keyboard.type(text);
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);

const after = await scroller();
const sent = await page.evaluate((t) => {
  const el = [...document.querySelectorAll("[data-turn-id]")].at(-1);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const col = document.querySelector("[data-column]");
  let sc = col;
  while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && getComputedStyle(sc).overflowY !== "visible")) sc = sc.parentElement;
  const v = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  return { has: el.textContent.includes(t), onScreen: r.bottom > v.top && r.top < v.bottom };
}, text);
const jump = await page.locator("[data-jump-room]").count();
if (!after) fail("no scroller after sending");
const fromEnd = after.height - after.top - after.client;
if (!sent?.has) problems.push("the sent message is not the newest request in the transcript");
else if (!sent.onScreen) problems.push("the sent message is not on screen");
if (fromEnd > 8) problems.push(`the conversation is ${fromEnd.toFixed(0)}px short of its end after sending`);
if (jump > 0) problems.push('"Jump to latest" is still showing after sending');
console.log(`scroll-on-send: before send top=${top.top.toFixed(0)} of ${top.height - top.client}; after send ${fromEnd.toFixed(0)}px from the end`);
await browser.close();
if (problems.length) {
  for (const p of problems) console.error(`scroll-on-send: ${p}`);
  process.exit(1);
}
console.log("scroll-on-send: ok");
