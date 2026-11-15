#!/usr/bin/env node
/**
 * Decision 62: the composer's text area grows a line at a time, then scrolls; no text is ever cut off without a scrollbar.
 * Run twice per layout (1440×900 and the phone): as the engine is (`field-sizing: content` where supported) and with the
 * script fallback forced (`useComposerText`'s path for Safari before 26: `CSS.supports("field-sizing", …)` answers false
 * and `field-sizing: fixed` is imposed). Types 14 lines one by one, deletes them, pastes 30 lines.
 *
 * Checks at every step: the text area is either tall enough for its text or scrolls (overflow-y auto); its height never
 * passes the CSS max-height (220 on the desktop, min(120px, 20% of the visible height) on the phone); the empty field is one
 * line (its line-height); a line more never shrinks it.
 *
 *   node packages/ui/scripts/composer-fit.mjs [--url http://localhost:1420] [--browser chromium|webkit]
 *
 * Prints `composer-fit: ok` or each failed check. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { BROWSER, launchBrowser, newContext, PHONE, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const fail = (why) => {
  console.error(`composer-fit: could not drive the page: ${why}`);
  process.exit(2);
};

const FALLBACK = () => {
  const orig = CSS.supports.bind(CSS);
  CSS.supports = (a, b) => (String(a).includes("field-sizing") ? false : b === undefined ? orig(a) : orig(a, b));
  const st = document.createElement("style");
  st.textContent = "[data-composer] textarea.octo-composer-input{field-sizing:fixed !important}";
  document.addEventListener("DOMContentLoaded", () => document.head.append(st));
};
const MEASURE = () => {
  const t = document.querySelector("#octo-composer, #octo-composer-float");
  if (!t) return null;
  const cs = getComputedStyle(t);
  return {
    h: Math.round(t.getBoundingClientRect().height * 10) / 10,
    sh: t.scrollHeight,
    ch: t.clientHeight,
    oy: cs.overflowY,
    max: Number.parseFloat(cs.maxHeight),
    line: Number.parseFloat(cs.lineHeight),
  };
};

const problems = [];
const errors = [];
const browser = await launchBrowser().catch((e) => fail(`${BROWSER} did not start: ${String(e).split("\n")[0]}`));
for (const mode of ["engine", "fallback"]) {
  for (const layout of ["desk", "phone"]) {
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
    if (mode === "fallback") await ctx.addInitScript(FALLBACK);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => !isAbortedImport(e.message) && errors.push(`${tag}: ${String(e.message).slice(0, 200)}`));
    await page.goto(`${BASE}/?demo=1#/p/prj_000q`).catch((e) => fail(String(e).split("\n")[0]));
    const ta = page.locator("#octo-composer:visible, #octo-composer-float:visible").first();
    await ta.waitFor({ timeout: 15000 }).catch(() => fail(`${tag}: no composer`));
    await page.waitForTimeout(800);
    await ta.click();
    const bad = (m, step) => {
      if (!m) return problems.push(`${tag} ${step}: no composer`);
      if (m.sh > m.ch + 1 && !/(auto|scroll)/.test(m.oy)) problems.push(`${tag} ${step}: text cut off (height ${m.h}, content ${m.sh}, overflow-y ${m.oy})`);
      if (Number.isFinite(m.max) && m.h > m.max + 0.5) problems.push(`${tag} ${step}: height ${m.h} past max-height ${m.max}`);
    };
    const empty = await page.evaluate(MEASURE);
    bad(empty, "empty");
    if (empty && Math.abs(empty.h - empty.line) > 0.5) problems.push(`${tag} empty: height ${empty.h} for a ${empty.line}px line`);
    let prev = empty?.h ?? 0;
    await page.keyboard.type("Line 1");
    for (let i = 2; i <= 14; i++) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`Line ${i}`);
      const m = await page.evaluate(MEASURE);
      bad(m, `line ${i}`);
      if (m && m.h < prev - 0.5) problems.push(`${tag} line ${i}: shrank ${prev} → ${m.h}`);
      prev = m?.h ?? prev;
    }
    for (let i = 14; i >= 2; i--) {
      for (let k = 0; k < `Line ${i}`.length + 1; k++) await page.keyboard.press("Backspace");
      bad(await page.evaluate(MEASURE), `delete to ${i - 1}`);
    }
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(Array.from({ length: 30 }, (_, i) => `pasted line ${i + 1}`).join("\n"));
    await page.waitForTimeout(150);
    bad(await page.evaluate(MEASURE), "paste 30 lines");
    await ctx.close();
  }
}
await browser.close();
problems.push(...errors.map((e) => `page error: ${e}`));
if (problems.length) {
  console.error(`composer-fit (${BROWSER}): FAIL\n  ${problems.slice(0, 30).join("\n  ")}`);
  process.exit(1);
}
console.log(`composer-fit: ok (${BROWSER})`);
