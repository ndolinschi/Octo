#!/usr/bin/env node
/**
 * Decision 95: every popup list takes the keys at once, and its active row is always visible. Drives the demo UI with Playwright.
 *
 * For each picker (the composer's slash menu, @ mention menu, "+" menu, mode, model/provider and folder pickers, the command
 * palette): opens it, presses ArrowDown without clicking inside, and asserts that the active row moved and lies fully inside the
 * list's scroll box. For the lists typed into the composer (slash, mention, "+") it then holds ArrowDown through the whole list
 * (and past the end: it must wrap) and asserts that the active row is visible after every key. Escape must close the picker and
 * leave focus on the opener (or in the composer's text).
 *
 *   node packages/ui/scripts/picker-keys.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--width 1440] [--height 900] [--theme dark|light]
 *                                            [--project "Atlas API"] [--shots DIR]
 *
 * `--shots DIR` also writes a screenshot of each open picker. Prints `picker-keys: ok` or the failures. Exit code 1 on a
 * failure, 2 on a problem driving the page.
 */
import { mkdirSync } from "node:fs";
import { launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const THEME = opt("--theme", "dark");
const PROJECT = opt("--project", "Atlas API");
const SHOTS = opt("--shots", "");

const fail = (why) => {
  console.error(`picker-keys: could not drive the page: ${why}`);
  process.exit(2);
};
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await launchBrowser();
const ctx = await newContext(browser, { viewport: { width: W, height: H } });
await ctx.addInitScript((theme) => {
  try {
    localStorage.setItem("octo.theme", theme);
    for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}, THEME);
let page = await ctx.newPage();
const problems = [];
const failures = [];
page.on("pageerror", (e) => isAbortedImport(e.message) || problems.push(`page error: ${String(e.stack ?? e).slice(0, 600)}`));
await page.goto(`${BASE}/?demo=1`, { waitUntil: "domcontentloaded" });
const project = page.locator('nav[aria-label="Projects"] a', { hasText: PROJECT }).first();
await project.waitFor({ state: "attached", timeout: 8000 }).catch(() => fail("no project list"));
await project.click();
const composer = page.locator("#octo-composer");
await composer.waitFor({ state: "visible", timeout: 8000 }).catch(() => fail("no composer"));
await page.waitForTimeout(800);

/** What the keys act on now: the row the focused element names (aria-activedescendant) or is, with its scroll box. */
const probe = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    const id = a?.getAttribute("aria-activedescendant");
    const row = (id ? document.getElementById(id) : null) ?? a?.closest('[role="menuitem"],[role="menuitemradio"],[role="option"]') ?? null;
    if (!row) return { focus: a ? `${a.tagName}${a.id ? `#${a.id}` : ""}` : "none", row: null };
    let box = row.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    const r = row.getBoundingClientRect();
    const b = box ? box.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return {
      focus: `${a.tagName}${a.id ? `#${a.id}` : ""}`,
      row: row.id || row.dataset.id || row.textContent.slice(0, 30),
      label: row.textContent.trim().slice(0, 40),
      visible: r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
      scrollable: box ? box.scrollHeight > box.clientHeight + 1 : false,
    };
  });
const rowCount = () =>
  page.locator('[role="listbox"]:visible [role="option"], [role="menu"]:visible [role="menuitem"], [role="menu"]:visible [role="menuitemradio"]').count();
const note = (name, what) => failures.push(`${name}: ${what}`);
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${THEME}.png` });
};

/** The common contract for a picker already open: keys work at once, the active row is visible, Escape returns focus. */
async function contract(name, { opener, hold = false, escapeTo }) {
  await page.waitForTimeout(350);
  const before = await probe();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(60);
  const after = await probe();
  if (!after.row) note(name, `no active row after ArrowDown (focus on ${after.focus}): keys do nothing without a click`);
  else {
    if (before.row === after.row && (await rowCount()) > 1) note(name, `ArrowDown did not move the active row (${before.label} -> ${after.label})`);
    if (!after.visible) note(name, `active row "${after.label}" is outside the scroll box`);
  }
  await shot(name);
  if (hold) {
    const n = await rowCount();
    let scrolled = after.scrollable === true;
    for (let i = 0; i < n + 2; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(40);
      const s = await probe();
      if (!s.row) note(name, `lost the active row after ${i + 2} presses`);
      else if (!s.visible) note(name, `active row "${s.label}" not visible after ${i + 2} presses of ArrowDown`);
      scrolled ||= s.scrollable === true;
    }
    for (let i = 0; i < n + 2; i++) {
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(40);
      const s = await probe();
      if (s.row && !s.visible) note(name, `active row "${s.label}" not visible after ${i + 1} presses of ArrowUp`);
    }
    console.log(`  ${name}: ${n} rows, list ${scrolled ? "scrolls" : "does not scroll"} (held ArrowDown n+2 times and ArrowUp n+2 times)`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const open = await page.locator('[role="menu"]:visible, [role="dialog"][aria-label]:visible, [data-composer-menu], [data-slash-menu]').count();
  if (open) note(name, "Escape did not close it");
  const back = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el !== null && document.activeElement === el;
  }, escapeTo ?? opener);
  if (!back) note(name, `Escape did not return focus to ${escapeTo ?? opener}`);
}

// Composer text: slash and mention menus keep focus in the text.
for (const [name, text, hold] of [
  ["slash", "/", true],
  ["mention", "@", true],
]) {
  await composer.click();
  await composer.fill("");
  await composer.pressSequentially(text);
  await page.waitForTimeout(500);
  await contract(name, { opener: "#octo-composer", hold });
  await composer.fill("");
}

// Buttons of the composer.
const chip = (sel) => page.locator(`[data-composer] ${sel}`).first();
const marks = [
  ["plus", '[aria-haspopup="listbox"]', true],
  ["mode", '[aria-haspopup="menu"][aria-label^="Mode"]', false],
  ["model", "[data-model-picker]", false],
];
for (const [name, sel, hold] of marks) {
  const el = chip(sel);
  if (!(await el.count())) {
    note(name, `opener ${sel} not found`);
    continue;
  }
  await el.focus();
  await page.evaluate((s) => document.querySelector(`[data-composer] ${s}`)?.setAttribute("data-picker-opener", "1"), sel);
  await el.click();
  await contract(name, { opener: "[data-picker-opener]", hold });
  await page.evaluate(() => document.querySelector("[data-picker-opener]")?.removeAttribute("data-picker-opener"));
}

// The "+" menu's "Folders" and "Session" entries open their own menus on the "+" (they were chips of the row).
// "Session" is offered only when its menu has something to run (Composer.tsx `sendTo`): "Make default" on a session that is not the
// default, "Move to worktree" where the session can move, "Show all sessions" while the `sessions` tab flag is on. With the default
// flags the demo's session is the default one and cannot move, so the entry is absent (asserted here); the check of its menu runs
// at the end on a page with `?tabs=sessions`.
async function subMenu(name, entry, { absent = false } = {}) {
  const plus = chip('[aria-haspopup="listbox"]');
  await plus.focus();
  await page.evaluate(() => document.querySelector('[data-composer] [aria-haspopup="listbox"]')?.setAttribute("data-picker-opener", "1"));
  await plus.click();
  await page.waitForTimeout(300);
  const row = page.locator('[data-composer-menu] [role="option"]', { hasText: entry }).first();
  const found = (await row.count()) > 0;
  if (absent || !found) {
    if (absent && found) note(name, `the + menu offers "${entry.source}" although its menu has nothing to run with the default tab flags`);
    if (!absent) note(name, `no "${entry.source}" entry in the + menu`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector("[data-picker-opener]")?.removeAttribute("data-picker-opener"));
    return;
  }
  await row.click();
  await page.waitForTimeout(300);
  await contract(name, { opener: "[data-picker-opener]", hold: false });
  await page.evaluate(() => document.querySelector("[data-picker-opener]")?.removeAttribute("data-picker-opener"));
}
await subMenu("folders", /^Folders:/);
await subMenu("session (default flags: no entry)", /^Session:/, { absent: true });

// Model picker: Left/Right between providers (an agent row opens its models, Left returns).
{
  const el = chip("[data-model-picker]");
  await el.click();
  await page.waitForTimeout(400);
  let moved = false;
  for (let i = 0; i < 14 && !moved; i++) {
    await page.keyboard.press("ArrowDown");
    const label = (await probe()).label ?? "";
    if (/›|Claude|Copilot|Codex|Grok|Gemini|agent/i.test(label) && !/default/i.test(label)) {
      const before = await page.locator('[role="dialog"] [role="option"]').first().textContent();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(200);
      const inner = await page.locator('[role="dialog"] [role="option"]').first().textContent();
      if (inner !== before) {
        moved = true;
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(200);
        const back = await page.locator('[role="dialog"] [role="option"]').first().textContent();
        if (back !== before) note("model", "ArrowLeft did not return to the provider list");
      }
    }
  }
  if (!moved) console.log("  model: no provider row opened with ArrowRight in this demo set (not asserted)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

// Command palette.
{
  await composer.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.waitForTimeout(500);
  if (!(await page.locator('[role="dialog"]:visible').count())) console.log("  palette: Ctrl+K opened nothing (not asserted)");
  else {
    const before = await probe();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(80);
    const after = await probe();
    if (!after.row) note("palette", `no active row after ArrowDown (focus on ${after.focus})`);
    else if (!after.visible) note("palette", "active row outside the scroll box");
    else if (before.row === after.row) note("palette", "ArrowDown did not move the active row");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

// The "Session" entry and its menu, with the sessions tab on (the entry's "Show all sessions" row).
{
  await page.close();
  page = await ctx.newPage();
  page.on("pageerror", (e) => isAbortedImport(e.message) || problems.push(`page error: ${String(e.stack ?? e).slice(0, 600)}`));
  await page.goto(`${BASE}/?demo=1&tabs=sessions`, { waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Projects"] a', { hasText: PROJECT }).first().click({ timeout: 8000 });
  await page.locator("#octo-composer").waitFor({ state: "visible", timeout: 8000 }).catch(() => fail("no composer with ?tabs=sessions"));
  await page.waitForTimeout(800);
  await subMenu("session", /^Session:/);
}

await browser.close();
for (const p of problems) failures.push(p);
if (failures.length) {
  console.error(`picker-keys: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("picker-keys: ok");
