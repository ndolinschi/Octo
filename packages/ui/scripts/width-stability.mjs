#!/usr/bin/env node
/**
 * Decision 79: a pane's width comes from the layout state only, never from what it shows. Drives the demo UI (Atlas API)
 * with Playwright and measures the panes in every content state:
 *
 *   conversation   top of the transcript, then scrolled to a wide table and a wide code block (one full-width group)
 *   files          a 20-column file, a 400-column file and a one-line minified bundle, each opened from the tree and
 *                  once more with the caret at the end of the longest line (the editor scrolls, the pane must not)
 *   changes        the Changes tab on a diff with a very wide line
 *
 * Asserts, per layout (one group, then the split), that the bounding width of every dock group and of the editor area is
 * identical in every state, that no scroll container on the way (the conversation's scroller, the groups) has scrolled
 * or can scroll sideways, and that `document.documentElement.scrollWidth === clientWidth`. Prints `width-stability: ok`
 * or the measurements that differ. Exit code 1 on a difference, 2 on a problem driving the page.
 *
 *   node packages/ui/scripts/width-stability.mjs [--url http://localhost:1420] [--width 1440] [--height 900] [--project "Atlas API"]
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("node packages/ui/scripts/width-stability.mjs [--url http://localhost:1420] [--width 1440] [--height 900] [--project \"Atlas API\"]");
  process.exit(0);
}
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const PROJECT = opt("--project", "Atlas API");
const TOL = 0.5;

function loadPlaywright() {
  const roots = [import.meta.url, "file:///opt/node-tools/", "file:///usr/local/lib/node_modules_global/"];
  try {
    roots.push(`file://${execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}/`);
  } catch {
    /* no npm */
  }
  for (const from of roots) {
    try {
      return createRequire(from)("playwright");
    } catch {
      /* try the next place */
    }
  }
  throw new Error("playwright is not installed");
}

/** What is measured, in the page: every dock group, the editor area, and the sideways overflow of what could scroll. */
const MEASURE = () => {
  const round = (n) => Math.round(n * 10) / 10;
  const groups = [...document.querySelectorAll("[data-dock-group]")].map((g) => round(g.getBoundingClientRect().width));
  const editor = [...document.querySelectorAll("[data-editor-area]")].find((e) => e.offsetParent);
  const scrollers = [];
  // Anything between a pane and its content that is, or can be made, a scroll container: it must not have moved.
  for (const el of document.querySelectorAll("[data-dock-group], [data-dock-group] *, body, html, #root")) {
    if (el.closest(".monaco-editor") || el.closest(".octo-table-scroll") || el.closest("pre")) continue;
    if (el.scrollLeft > 0) scrollers.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : ""} scrollLeft=${el.scrollLeft}`);
  }
  const conv = document.querySelector("[data-column]")?.closest(".overflow-y-auto");
  const root = document.documentElement;
  return {
    groups,
    editor: editor ? round(editor.getBoundingClientRect().width) : null,
    convOverflow: conv && conv.offsetParent ? conv.scrollWidth - conv.clientWidth : 0,
    docOverflow: root.scrollWidth - root.clientWidth,
    scrolled: scrollers,
  };
};

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("octo.theme", "dark");
    for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const states = { single: [], split: [] };
const measure = async (phase, name) => states[phase].push({ name, ...(await page.evaluate(MEASURE)) });
const fail = (why) => {
  console.error(`width-stability: could not drive the page: ${why}`);
  process.exit(2);
};

await page.goto(`${BASE}/?demo=1`, { waitUntil: "domcontentloaded" });
const projects = page.locator('nav[aria-label="Projects"] a');
// Below the sidebar's breakpoint the project list is a drawer that is not mounted until it is opened.
if (!(await projects.first().waitFor({ state: "attached", timeout: 3000 }).then(() => true, () => false)))
  await page.getByRole("button", { name: /sidebar/i }).first().click();
await projects.first().waitFor({ state: "attached", timeout: 10000 });
const href = await page.evaluate((name) => {
  for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]'))
    if ((a.getAttribute("title") || a.textContent.trim()).startsWith(name)) return a.getAttribute("href");
  return null;
}, PROJECT);
if (!href) fail(`project "${PROJECT}" not in the sidebar`);
await page.evaluate((h) => (window.location.hash = h.slice(h.indexOf("#"))), href);
await page.locator("[data-column]").first().waitFor({ timeout: 10000 });
await page.waitForTimeout(2500); // let the warmed chunks arrive: the test is about layout, not first-load latency

// 1. The conversation: top, then each wide block scrolled into view.
await measure("single", "conversation, top");
for (const [name, selector] of [
  ["conversation, wide table", "[data-column] .octo-table"],
  ["conversation, wide code block", "[data-column] pre.octo-code, [data-column] pre"],
]) {
  const target = page.locator(selector).last();
  if (!(await target.count())) fail(`no ${name} in the demo conversation`);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await measure("single", name);
}

// 2. The split: open the Files tool, then files of every line length.
await page.locator("[data-tab-plus]:visible").last().click();
await page.locator('[role=option][data-picker-row="tool:files"]').first().click();
const tree = page.locator('[role="tree"][aria-label="Project files"]:visible');
await tree.first().waitFor({ timeout: 8000 });
await page.waitForTimeout(600);

async function showTree() {
  if (!(await tree.count())) await page.locator('[data-dock-group] button[aria-label="Show file tree"]:visible').first().click();
  await tree.first().waitFor({ timeout: 4000 });
}
async function openFile(name) {
  await showTree();
  const dir = tree.locator('[role="treeitem"][data-path="atlas-api/width"]').first();
  if ((await dir.getAttribute("aria-expanded")) === "false") await dir.click();
  await tree.locator(`[role="treeitem"][data-path="atlas-api/width/${name}"]`).first().click();
  try { await page.locator('[data-testid="code-editor"] .monaco-editor:visible').first().waitFor({ timeout: 8000 }); } catch (e) { await page.screenshot({ path: "/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/ws-fail.png" }); throw e; }
  await page.waitForTimeout(900);
  // The tree is a column of the editor pane: measure with it hidden, so only the editor's own width is compared.
  const hide = page.locator('[data-dock-group] button[aria-label="Hide file tree"]:visible').first();
  if (await hide.count()) await hide.click();
  await page.waitForTimeout(300);
}

await openFile("narrow.txt");
await measure("split", "file, 20 columns");
await openFile("wide.txt");
await measure("split", "file, 400 columns");
await page.locator(".monaco-editor textarea:visible").first().focus();
await page.keyboard.press("End");
await page.waitForTimeout(400);
await measure("split", "file, 400 columns, caret at the end");
await openFile("minified.js");
await measure("split", "file, one-line bundle");
await page.locator(".monaco-editor textarea:visible").first().focus();
await page.keyboard.press("Control+End");
await page.waitForTimeout(400);
await measure("split", "file, one-line bundle, caret at the end");
await openFile("narrow.txt");
await measure("split", "file, 20 columns again");

// 3. The Changes tab on a very wide line.
await page.locator("[data-tab-plus]:visible").last().click();
await page.locator('[role=option][data-picker-row="tool:changes"]').first().click();
await page.getByRole("tab", { name: "Changes" }).first().click();
const row = page.locator('[role="tabpanel"]:visible span', { hasText: /^wide\.txt$/ }).first();
await row.waitFor({ timeout: 8000 }).catch(() => fail("the Changes tab does not list width/wide.txt"));
await row.click();
await page.locator(".monaco-diff-editor:visible").first().waitFor({ timeout: 8000 }).catch(async () => { await page.screenshot({ path: "/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/ws-fail.png" }); fail("the diff of width/wide.txt did not open"); });
await page.waitForTimeout(900);
await measure("split", "changes, diff with a wide line");
await browser.close();

const problems = [];
for (const [phase, list] of Object.entries(states)) {
  const base = list[0];
  if (!base) continue;
  for (const s of list) {
    const label = `${phase}: ${s.name}`;
    if (s.groups.length !== base.groups.length || s.groups.some((w, i) => Math.abs(w - base.groups[i]) > TOL))
      problems.push(`${label}: group widths ${JSON.stringify(s.groups)} (${base.name}: ${JSON.stringify(base.groups)})`);
    if (s.editor !== null && base.editor === null) base.editor = s.editor;
    if (s.editor !== null && base.editor !== null && Math.abs(s.editor - base.editor) > TOL)
      problems.push(`${label}: editor area ${s.editor} (first file: ${base.editor})`);
    if (s.docOverflow !== 0) problems.push(`${label}: document scrollWidth - clientWidth = ${s.docOverflow}`);
    if (s.convOverflow > 0) problems.push(`${label}: the conversation scrolls sideways by ${s.convOverflow}px`);
    for (const x of s.scrolled) problems.push(`${label}: scrolled sideways: ${x}`);
  }
}
for (const e of errors) problems.push(`page error: ${e}`);
if (problems.length) {
  console.log(`width-stability @ ${W}x${H}: FAIL`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
const count = Object.values(states).reduce((n, l) => n + l.length, 0);
console.log(`width-stability: ok (${W}x${H}, ${count} states, groups ${JSON.stringify(states.split[0]?.groups)})`);
