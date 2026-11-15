#!/usr/bin/env node
/**
 * A long conversation opens at its end and stays there until the reader scrolls away themselves (P1 found in WebKit: the
 * engine moves scrollTop up by itself after the first layout, and the view used to take that for the reader and let go).
 *
 *   open      Stress test at 1440×900: 4 s after opening, nothing is cut off below (≤ 2 px) and "Jump to latest" is hidden.
 *   wheel     the reader wheels up: the view lets go (Jump to latest shows) and is not pulled back down.
 *   jump      Jump to latest goes back to the end.
 *   keys      PageUp in the conversation lets go too.
 *   stream    a sent request streams; the reader wheels up during it and stays where they went.
 *   phone     Atlas API on a phone (390×844, touch): opens at the end (its approval cards in view).
 *
 *   node packages/ui/scripts/stick-on-open.mjs [--url http://localhost:1420] [--browser chromium|webkit]
 *
 * Prints `stick-on-open: ok` or each failed check. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { BROWSER, launchBrowser, newContext, PHONE, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const fail = (why) => {
  console.error(`stick-on-open: could not drive the page: ${why}`);
  process.exit(2);
};
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
};

const GAP = () => {
  const s = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector("section[data-turn-key]") && e.clientHeight > 0);
  return s ? Math.round(s.scrollHeight - s.clientHeight - s.scrollTop) : null;
};

const browser = await launchBrowser().catch((e) => fail(`${BROWSER} did not start: ${String(e).split("\n")[0]}`));
const prep = async (ctx) => {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("octo.theme", "dark");
      for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.")) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  });
};
const errors = [];
const watch = (page) => page.on("pageerror", (e) => !isAbortedImport(e.message) && errors.push(String(e.message).slice(0, 200)));

{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  await prep(ctx);
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${BASE}/?demo=1#/p/prj_000t`).catch((e) => fail(String(e).split("\n")[0]));
  await page
    .waitForFunction(() => document.querySelectorAll("section[data-turn-key]").length > 50, null, { timeout: 20000 })
    .catch(() => fail("Stress test did not load"));
  await page.waitForTimeout(4000);
  const jump = page.getByRole("button", { name: "Jump to latest" }).filter({ visible: true });
  const gap = await page.evaluate(GAP);
  check(gap !== null && gap <= 2, `open: ${gap}px cut off below 4 s after opening (want ≤ 2)`);
  check((await jump.count()) === 0, "open: Jump to latest shows on a conversation that was never scrolled");

  const box = await page.evaluate(() => {
    const s = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector("section[data-turn-key]"));
    const r = s.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  await page.mouse.move(box[0], box[1]);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1500);
  const up = await page.evaluate(GAP);
  check(up !== null && up > 300, `wheel: ${up}px from the end after wheeling up 600 (want > 300: let go, not pulled back)`);
  check((await jump.count()) > 0, "wheel: no Jump to latest after the reader wheeled up");

  if ((await jump.count()) > 0) {
    await jump.first().click();
    await page.waitForTimeout(1500);
    const back = await page.evaluate(GAP);
    check(back !== null && back <= 2, `jump: ${back}px from the end after Jump to latest`);
  }

  // Keyboard: focus a control of the last reply in view (keys then scroll its scroller), then PageUp.
  const focused = await page.evaluate(() => {
    const s = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector("section[data-turn-key]"));
    const r = s.getBoundingClientRect();
    const b = [...s.querySelectorAll("section[data-turn-mounted] button")].filter((x) => {
      const q = x.getBoundingClientRect();
      return q.height > 0 && q.top > r.top && q.bottom < r.bottom;
    });
    const target = b[b.length - 1];
    target?.focus({ preventScroll: true });
    return !!target && document.activeElement === target;
  });
  check(focused, "keys: no control of a reply in view to focus");
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(1200);
  const key = await page.evaluate(GAP);
  check(key !== null && key > 200, `keys: ${key}px from the end after PageUp (want > 200)`);

  // Streaming: the reader scrolls up while the reply comes in and stays there.
  const composer = page.locator("#octo-composer:visible, #octo-composer-float:visible").first();
  await composer.click();
  await composer.fill("stick-on-open: summarise the last answer");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const sent = await page.evaluate(GAP);
  check(sent !== null && sent <= 2, `stream: ${sent}px from the end after sending (want ≤ 2)`);
  await page.mouse.move(box[0], box[1]);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(2500);
  const reading = await page.evaluate(GAP);
  check(reading !== null && reading > 400, `stream: ${reading}px from the end 2.5 s after wheeling up during the reply (want > 400)`);
  await ctx.close();
}

{
  const ctx = await newContext(browser, { ...PHONE });
  await prep(ctx);
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${BASE}/?demo=1#/p/prj_0001`).catch((e) => fail(String(e).split("\n")[0]));
  await page
    .waitForFunction(() => document.querySelectorAll("section[data-turn-key]").length > 0, null, { timeout: 20000 })
    .catch(() => fail("Atlas API did not load"));
  await page.waitForTimeout(3500);
  const gap = await page.evaluate(GAP);
  check(gap !== null && gap <= 2, `phone: Atlas API opens ${gap}px short of the end (want ≤ 2)`);
  await ctx.close();
}

await browser.close();
for (const e of errors) problems.push(`page error: ${e}`);
if (problems.length) {
  console.error(`stick-on-open (${BROWSER}): FAIL\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`stick-on-open: ok (${BROWSER})`);
