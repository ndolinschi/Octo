#!/usr/bin/env node
/**
 * Stress P1-6: scrolling up a long conversation (turns mount as they come near, `useTurnWindow`) never moves the text under
 * the reader's eyes. Stress test, 30 steps of 400 px up from the end; at each step a line in the middle of the viewport is the
 * anchor, and on every painted frame for 700 ms after the step (sampled after paint) it must sit exactly 400 px lower than
 * before (≤ 1 px).
 *
 *   native   the engine's CSS scroll anchoring (Chromium; WebKit 26).
 *   manual   the path for engines without it (WebKit before 26): `overflow-anchor: none` everywhere and
 *            `CSS.supports("overflow-anchor", …)` answering false, so `useTurnWindow` keeps the place itself.
 *
 *   node packages/ui/scripts/scroll-anchor.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--mode native|manual]
 *     [--layout desk|phone] [--steps 30]
 *
 * Prints `scroll-anchor: ok` or the steps that jumped. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { BROWSER, launchBrowser, newContext, PHONE, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const MODES = opt("--mode", "native,manual").split(",");
const LAYOUTS = opt("--layout", "desk,phone").split(",");
const STEPS = Number(opt("--steps", "30"));
const STEP = 400;
const TOL = 1;
const fail = (why) => {
  console.error(`scroll-anchor: could not drive the page: ${why}`);
  process.exit(2);
};

const FORCE_MANUAL = () => {
  const orig = CSS.supports.bind(CSS);
  CSS.supports = (a, b) => (String(a).includes("overflow-anchor") ? false : b === undefined ? orig(a) : orig(a, b));
  const st = document.createElement("style");
  st.textContent = "*{overflow-anchor:none !important}";
  document.addEventListener("DOMContentLoaded", () => document.head.append(st));
};
const SETUP = () => {
  window.__sc = () => [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector("section[data-turn-key]") && e.clientHeight > 0);
  window.__pick = () => {
    const s = window.__sc();
    const r = s.getBoundingClientRect();
    const c = [...s.querySelectorAll("section[data-turn-mounted] :is(p, li, pre, tr, [data-prompt])")].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.height > 0 && b.top >= r.top + 60 && b.bottom <= r.bottom - 60;
    });
    window.__a = c[Math.floor(c.length / 2)] ?? null;
    return window.__a ? window.__a.getBoundingClientRect().top - r.top : null;
  };
  // One step: the reader's wheel (so the view stops following the end), the scroll, then the anchor's offset on every
  // frame as it is painted: read from a ResizeObserver made after the page's own (observers run in the order they were
  // made, after layout and before paint), fed by a probe whose width changes every frame.
  window.__step = (by, ms) =>
    new Promise((res) => {
      const s = window.__sc();
      const st0 = s.scrollTop;
      const tops = [];
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;visibility:hidden";
      document.body.append(probe);
      const t0 = performance.now();
      const ro = new ResizeObserver(() => {
        const r = s.getBoundingClientRect();
        tops.push(window.__a?.isConnected ? window.__a.getBoundingClientRect().top - r.top : null);
      });
      ro.observe(probe);
      const tick = () => {
        if (performance.now() - t0 >= ms) {
          ro.disconnect();
          probe.remove();
          res({ st0, st1: s.scrollTop, tops: tops.slice(1) });
          return;
        }
        probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
        requestAnimationFrame(tick);
      };
      s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -by }));
      s.scrollTop = st0 - by;
      requestAnimationFrame(tick);
    });
};

const problems = [];
const errors = [];
const summary = [];
const browser = await launchBrowser().catch((e) => fail(`${BROWSER} did not start: ${String(e).split("\n")[0]}`));
for (const mode of MODES) {
  for (const layout of LAYOUTS) {
    const tag = `${mode}/${layout}`;
    const ctx = await newContext(browser, layout === "phone" ? { ...PHONE } : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("octo.theme", "dark");
        for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.")) localStorage.removeItem(k);
      } catch {
        /* storage unavailable */
      }
    });
    if (mode === "manual") await ctx.addInitScript(FORCE_MANUAL);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => !isAbortedImport(e.message) && errors.push(`${tag}: ${String(e.message).slice(0, 200)}`));
    await page.goto(`${BASE}/?demo=1#/p/prj_000t`).catch((e) => fail(String(e).split("\n")[0]));
    await page
      .waitForFunction(() => document.querySelectorAll("section[data-turn-key]").length > 50, null, { timeout: 20000 })
      .catch(() => fail(`${tag}: Stress test did not load`));
    await page.waitForTimeout(4000);
    await page.evaluate(SETUP);
    const native = await page.evaluate(() => CSS.supports("overflow-anchor", "auto"));
    if ((mode === "manual") === native) fail(`${tag}: CSS.supports("overflow-anchor") is ${native}`);
    let worst = 0;
    let steps = 0;
    for (let i = 0; i < STEPS; i++) {
      const before = await page.evaluate(() => window.__pick());
      const r = await page.evaluate(([by, ms]) => window.__step(by, ms), [STEP, 700]);
      if (before === null) continue;
      steps += 1;
      const moved = Math.min(STEP, r.st0);
      const dev = r.tops.filter((t) => t !== null).map((t) => Math.abs(t - before - moved));
      const max = dev.length ? Math.max(...dev) : 0;
      worst = Math.max(worst, max);
      if (max > TOL) problems.push(`${tag} step ${i + 1}: the anchor jumped ${Math.round(max)} px (scrollTop ${Math.round(r.st0)} → ${Math.round(r.st1)})`);
      if (r.st1 <= 0) break;
    }
    if (steps < 5) problems.push(`${tag}: only ${steps} steps had an anchor`);
    summary.push(`${tag} ${steps} steps, worst ${Math.round(worst * 10) / 10} px`);
    await ctx.close();
  }
}
await browser.close();
problems.push(...errors.map((e) => `page error: ${e}`));
if (problems.length) {
  console.error(`scroll-anchor (${BROWSER}): FAIL (${summary.join("; ")})\n  ${problems.slice(0, 30).join("\n  ")}`);
  process.exit(1);
}
console.log(`scroll-anchor: ok (${BROWSER}; ${summary.join("; ")})`);
