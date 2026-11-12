#!/usr/bin/env node
/**
 * Decision 85: opening a file changes nothing but the editor's content and the selected row. Drives the demo UI with
 * Playwright and, for every open below, samples EVERY frame (a requestAnimationFrame loop whose message task runs after
 * paint, as `flicker.mjs` does) from just before the click until 600 ms after it:
 *
 *   tree      first file from the tree of the Files tab, then narrow, 400-column, one-line bundle, a normal source file and a file
 *             too large to open, with the tree scrolled (strict: nothing but the editor's content may differ)
 *   link      a file link in the conversation: the first one creates the editor group (ONE layout change, in one frame), the
 *             next ones are strict
 *   palette   Ctrl/Cmd+K and Enter on an open file's tab (strict)
 *   changes   the "Open file" button of the Changes tab (the group shows its file view again: ONE layout change)
 *
 * Per frame it records the boxes of the dock groups, the editor area, the file bar, the tree column and the status bar, the tree
 * list's scrollTop, the horizontal overflow of the document, and every running animation or transition. Strict opens assert that
 * every frame equals the frame before the click (0.5 px) and that no running animation animates a geometry property of a pane
 * (tab-strip tabs are reported, not failed: they are the dock's). A "one change" open asserts that the layout signature differs in
 * at most one frame step and that nothing changes after it. Prints `file-open-stability: ok` or the frames that differ; the per-frame
 * data goes to `--out DIR` as JSON. Exit code 1 on a difference, 2 on a problem driving the page.
 *
 *   node packages/ui/scripts/file-open-stability.mjs [--url http://localhost:1420] [--width 1440] [--height 900] [--project "Atlas API"]
 *                                                    [--out DIR] [--browser chromium|webkit]
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    'node packages/ui/scripts/file-open-stability.mjs [--url http://localhost:1420] [--width 1440] [--height 900] [--project "Atlas API"] [--out DIR] [--browser chromium|webkit]',
  );
  process.exit(0);
}
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const PROJECT = opt("--project", "Atlas API");
const OUT = opt("--out", null);
const BROWSER = opt("--browser", "chromium");
const TOL = 0.5;
const AFTER_MS = 600;

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

const fail = (why) => {
  console.error(`file-open-stability: could not drive the page: ${why}`);
  process.exit(2);
};

/** Starts the per-frame recorder in the page. */
const RECORD = () => {
  const rec = { frames: [], stop: false, t0: performance.now() };
  window.__fo = rec;
  const GEOMETRY =
    /^(width|height|min-width|max-width|min-height|max-height|flex|flex-basis|flex-grow|flex-shrink|grid-template-columns|grid-template-rows|transform|translate|scale|left|right|top|bottom|inset|margin|padding|all)/;
  const round = (n) => Math.round(n * 10) / 10;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [round(r.left), round(r.top), round(r.width), round(r.height)];
  };
  const visible = (sel) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed");
  const PANES = "[data-dock-group], [data-dock-body], [data-editor-area], [data-file-bar], [data-status-bar], [data-strip], aside[aria-label='File tree']";
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    if (rec.stop) return;
    const tree = visible("aside[aria-label='File tree'], aside[data-tree-skeleton]");
    const list = tree?.querySelector("[id$='-tree-list']");
    const anims = [];
    for (const a of document.getAnimations()) {
      if (a.playState !== "running") continue;
      const eff = a.effect;
      const target = eff && "target" in eff ? eff.target : null;
      const props =
        a instanceof CSSTransition
          ? [a.transitionProperty]
          : eff
            ? eff.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))
            : [];
      const geometry = props.filter((p) => GEOMETRY.test(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)));
      if (!geometry.length || !(target instanceof Element)) continue;
      const pane = target.closest(PANES) === target || target.matches(PANES);
      const inStrip = target.closest("[data-strip]") !== null && !pane;
      anims.push({
        target: `${target.tagName.toLowerCase()}${target.className && typeof target.className === "string" ? "." + target.className.split(" ")[0] : ""}`,
        props: geometry,
        pane,
        strip: inStrip,
      });
    }
    const root = document.documentElement;
    rec.frames.push({
      t: round(performance.now() - rec.t0),
      groups: [...document.querySelectorAll("[data-dock-group]")].filter((e) => e.offsetParent !== null).map(box),
      editor: box(visible("[data-editor-area]")),
      bar: box(visible("[data-file-bar]")),
      status: box(document.querySelector("[data-status-bar]")),
      strips: [...document.querySelectorAll("[data-strip]")].filter((e) => e.offsetParent !== null).map(box),
      tree: box(tree),
      scroll: list ? round(list.scrollTop) : null,
      docOverflow: root.scrollWidth - root.clientWidth,
      anims,
    });
  };
  const tick = () => {
    if (rec.stop) return;
    channel.port2.postMessage(0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const { chromium, webkit } = loadPlaywright();
const engine = BROWSER === "webkit" ? webkit : chromium;
if (!engine) fail(`playwright has no ${BROWSER}`);
const browser = await engine.launch().catch((e) => fail(`${BROWSER} did not start: ${String(e).split("\n")[0]}`));
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("octo.theme", "dark");
    if (!sessionStorage.getItem("fo-cleared")) {
      sessionStorage.setItem("fo-cleared", "1");
      for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

async function openProject() {
  await page.goto(`${BASE}/?demo=1`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.removeItem("fo-cleared")).catch(() => {});
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
  )
    await page
      .getByRole("button", { name: /sidebar/i })
      .first()
      .click();
  await projects.first().waitFor({ state: "attached", timeout: 10000 });
  const href = await page.evaluate((name) => {
    for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]'))
      if ((a.getAttribute("title") || a.textContent.trim()).startsWith(name)) return a.getAttribute("href");
    return null;
  }, PROJECT);
  if (!href) fail(`project "${PROJECT}" not in the sidebar`);
  await page.evaluate((h) => (window.location.hash = h.slice(h.indexOf("#"))), href);
  await page.locator("[data-column]").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(2500);
}

const tree = page.locator('[role="tree"][aria-label="Project files"]:visible');
async function openFilesTool() {
  await page.locator("[data-tab-plus]:visible").last().click();
  await page.locator('[role=option][data-picker-row="tool:files"]').first().click();
  await tree.first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
}
/** Expands every folder of the tree (so it is tall and scrolls), then scrolls the tree list to `fraction` of its range. */
async function expandAndScroll(fraction) {
  for (let i = 0; i < 40; i++) {
    const closed = tree.locator('[role="treeitem"][aria-expanded="false"]').first();
    if (!(await closed.count())) break;
    await closed.click();
    await page.waitForTimeout(40);
  }
  await page.evaluate((f) => {
    const list = document.querySelector("aside[aria-label='File tree'] [id$='-tree-list']");
    if (list) list.scrollTop = (list.scrollHeight - list.clientHeight) * f;
  }, fraction);
  await page.waitForTimeout(200);
}
const item = (path) => tree.locator(`[role="treeitem"][data-path="${path}"]`).first();

/** Records from just before `act` until AFTER_MS after it; returns the frames and the index of the first frame after the act. */
async function record(label, mode, act) {
  await page.evaluate(RECORD);
  await page.waitForTimeout(120);
  const before = await page.evaluate(() => window.__fo.frames.length);
  let error = null;
  await act().catch((e) => {
    error = String(e.message ?? e)
      .split("\n")[0]
      .slice(0, 160);
  });
  await page.waitForTimeout(AFTER_MS);
  const frames = await page.evaluate(() => {
    window.__fo.stop = true;
    return window.__fo.frames;
  });
  // The editor area must show something: text lines, the skeleton, a message or a preview (never a blank box).
  const shows = await page.evaluate(() => {
    const area = [...document.querySelectorAll("[data-editor-area]")].find((e) => e.offsetParent !== null);
    return Boolean(area && (area.querySelector(".view-line, [data-editor-skeleton], [data-md-preview]") || (area.textContent ?? "").trim().length > 0));
  });
  return { label, mode, before, frames, error, shows };
}

const runs = [];
const clickRow = (path) => async () => {
  const row = item(path);
  await row.waitFor({ timeout: 3000 });
  await row.click();
};

// 1. Tree: the Files tab turns into the first file in place; then more files with the tree scrolled.
await openProject();
await openFilesTool();
await expandAndScroll(0.5);
for (const [label, path] of [
  ["tree: first file (20 columns)", "atlas-api/width/narrow.txt"],
  ["tree: 400-column file", "atlas-api/width/wide.txt"],
  ["tree: one-line bundle", "atlas-api/width/minified.js"],
  ["tree: source file", "atlas-api/src/auth/login.ts"],
  ["tree: file too large to open", "atlas-api/test/fixtures/events.ndjson"],
  ["tree: third source file", "atlas-api/src/auth/tokens.ts"],
]) {
  // Only visible rows are clicked (a click on a row outside the viewport scrolls the list, which is the browser's, not ours).
  const visibleRow = await page.evaluate((p) => {
    const list = document.querySelector("aside[aria-label='File tree'] [id$='-tree-list']");
    const row = [...document.querySelectorAll("aside[aria-label='File tree'] [role=treeitem]")].find((r) => r.getAttribute("data-path") === p);
    if (!list || !row) return false;
    const a = list.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    return b.top >= a.top && b.bottom <= a.bottom;
  }, path);
  if (!visibleRow) {
    await page.evaluate((p) => {
      const row = [...document.querySelectorAll("aside[aria-label='File tree'] [role=treeitem]")].find((r) => r.getAttribute("data-path") === p);
      row?.scrollIntoView({ block: "center" });
    }, path);
    await page.waitForTimeout(200);
  }
  runs.push(await record(label, "strict", clickRow(path)));
  await page.waitForTimeout(500);
}

// 2. Chat link: the first one creates the file group (one layout change), the next are strict.
await openProject();
const links = page.locator("[data-column] [data-file-link]");
if (
  !(await links
    .first()
    .waitFor({ timeout: 8000 })
    .then(
      () => true,
      () => false,
    ))
)
  fail("no file link in the demo conversation");
const nLinks = await links.count();
for (let i = 0; i < Math.min(nLinks, 3); i++) {
  // One group at a time (narrow windows): once the file group has focus the conversation is not on screen, so there is no link to click.
  if (i > 0 && !(await links.nth(i).isVisible())) {
    console.log(`  skipped: link: file link ${i + 1} (the conversation is not visible at ${W}x${H} once a file is open)`);
    continue;
  }
  await links.nth(i).scrollIntoViewIfNeeded({ timeout: 3000 });
  await page.waitForTimeout(250);
  runs.push(await record(`link: file link ${i + 1}`, i === 0 ? "one" : "strict", async () => links.nth(i).click()));
  await page.waitForTimeout(500);
}

// 3. Palette: Enter on an open file's tab.
await openProject();
await openFilesTool();
await clickRow("atlas-api/width/narrow.txt")().catch(() => {});
await page
  .locator('[data-testid="code-editor"] .monaco-editor:visible')
  .first()
  .waitFor({ timeout: 8000 })
  .catch(() => {});
await page.waitForTimeout(700);
await clickRow("atlas-api/width/wide.txt")().catch(() => {});
await page.waitForTimeout(1200);
for (const name of ["narrow.txt", "wide.txt"]) {
  runs.push(
    await record(`palette: ${name}`, "strict", async () => {
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.press("Control+k");
      const input = page.locator('input[aria-label^="Search tabs"]:visible').first();
      await input.waitFor({ timeout: 3000 });
      await page.keyboard.type(name);
      await page.waitForTimeout(150);
      await page.keyboard.press("Enter");
    }),
  );
  await page.waitForTimeout(500);
}

// 4. Changes: the file's tab shows again (a fresh project, so the palette run cannot leave anything open).
await openProject();
await openFilesTool();
await clickRow("atlas-api/width/narrow.txt")().catch(() => {});
await page
  .locator('[data-testid="code-editor"] .monaco-editor:visible')
  .first()
  .waitFor({ timeout: 8000 })
  .catch(() => {});
await page.waitForTimeout(700);
await page.locator("[data-tab-plus]:visible").last().click();
await page.locator('[role=option][data-picker-row="tool:changes"]').first().click();
await page.getByRole("tab", { name: "Changes" }).first().click();
const row = page.locator('[role="tabpanel"]:visible span', { hasText: /^wide\.txt$/ }).first();
await row.waitFor({ timeout: 8000 }).catch(() => fail("the Changes tab does not list width/wide.txt"));
await row.click();
await page
  .locator(".monaco-diff-editor:visible")
  .first()
  .waitFor({ timeout: 8000 })
  .catch(() => fail("the diff did not open"));
await page.waitForTimeout(900);
runs.push(await record("changes: Open file", "one", async () => page.getByRole("button", { name: "Open file" }).first().click()));
await browser.close();

// Assertions.
const same = (a, b) => (a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= TOL));
const sameList = (a, b) => a.length === b.length && a.every((v, i) => same(v, b[i]));
const KEYS = ["groups", "editor", "bar", "status", "strips", "tree"];
const sig = (f) =>
  KEYS.map((k) => (k === "groups" || k === "strips" ? f[k].map((x) => x.join(",")).join("|") : f[k] === null ? "-" : f[k].join(","))).join(" / ");
const diffKeys = (f, base) =>
  KEYS.filter((k) => (k === "groups" || k === "strips" ? !sameList(f[k], base[k]) : !same(f[k], base[k]))).concat(
    f.scroll !== base.scroll && !(f.scroll !== null && base.scroll !== null && Math.abs(f.scroll - base.scroll) <= TOL) ? ["tree scrollTop"] : [],
  );

const problems = [];
const warnings = [];
for (const r of runs) {
  if (!r.shows && !r.error) problems.push(`${r.label}: the editor area is blank 600 ms after the open`);
  if (r.error) problems.push(`${r.label}: the open could not be driven (${r.error}); the tree or the link it needs is not there`);
  const base = r.frames[Math.max(0, r.before - 1)];
  const after = r.frames.slice(r.before);
  if (!base || after.length < 3) {
    problems.push(`${r.label}: only ${after.length} frames recorded`);
    continue;
  }
  const bad = (f, msg) => problems.push(`${r.label}: frame +${Math.round(f.t - r.frames[r.before].t)} ms: ${msg}`);
  if (r.mode === "strict") {
    let reported = 0;
    for (const f of after) {
      const d = diffKeys(f, base);
      if (d.length && reported++ < 3)
        bad(f, `${d.join(", ")} changed: ${sig(base)}  ->  ${sig(f)}${d.includes("tree scrollTop") ? ` (scrollTop ${base.scroll} -> ${f.scroll})` : ""}`);
    }
    if (reported > 3) problems.push(`${r.label}: ${reported} frames differ in all`);
  } else {
    const sigs = after.map(sig);
    let steps = 0;
    for (let i = 1; i < sigs.length; i++) if (sigs[i] !== sigs[i - 1]) steps++;
    if (sigs[0] !== sig(base)) steps++;
    if (steps > 1) problems.push(`${r.label}: the layout changed in ${steps} steps, expected one: ${[...new Set([sig(base), ...sigs])].join("  ->  ")}`);
  }
  for (const f of after) {
    if (f.docOverflow !== 0) bad(f, `document scrollWidth - clientWidth = ${f.docOverflow}`);
    for (const a of f.anims) {
      if (a.pane) bad(f, `running animation of ${a.props.join(",")} on a pane (${a.target})`);
      else if (a.strip) warnings.push(`${r.label}: tab strip animates ${a.props.join(",")} (${a.target}); the dock's, not failed`);
    }
  }
}
for (const e of errors) problems.push(`page error: ${e}`);

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/file-open-${BROWSER}-${W}x${H}.json`,
    JSON.stringify({ width: W, height: H, browser: BROWSER, runs, problems, warnings: [...new Set(warnings)] }),
  );
}
if (problems.length) {
  console.log(`file-open-stability @ ${W}x${H} (${BROWSER}): FAIL`);
  for (const p of problems) console.log(`  ${p}`);
  for (const w of new Set(warnings)) console.log(`  note: ${w}`);
  process.exit(1);
}
for (const w of new Set(warnings)) console.log(`  note: ${w}`);
console.log(
  `file-open-stability: ok (${W}x${H}, ${BROWSER}, ${runs.length} opens, ${runs.reduce((n, r) => n + r.frames.length - r.before, 0)} frames after the clicks)`,
);
