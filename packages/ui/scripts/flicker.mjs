#!/usr/bin/env node
/**
 * Decisions 69 and 76: nothing flickers, nothing jerks, and nothing animates unless something is in progress. Drives the demo
 * UI with Playwright (`--browser chromium|webkit`, default Chromium; the owner can point `--url` at any dev server):
 *
 *   typing   types a long multi-line prompt (2000 characters, 20 lines) into the composer of a project while a
 *            requestAnimationFrame recorder samples, every frame, the bounding boxes of the window's top row (the tab
 *            strips), the tab list, the conversation (its scroller and its column) and the composer. Asserts that none of
 *            them moves by more than 0.5 px between two frames, except the composer's own height, which may only grow
 *            (monotonically) with its bottom edge fixed.
 *   idle     loads Home with no project at work, an idle project and Settings and asserts that `document.getAnimations()`
 *            has no animation in `playState === "running"`.
 *
 * Changing the project (every way a person does it) is `project-switch.mjs` (decision 98): per-frame classification of the
 * conversation across the switch.
 *
 *   node packages/ui/scripts/flicker.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--width 1440] [--height 900] [--only typing|idle]
 *
 * Prints `flicker: ok` or the offending measurements. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "node packages/ui/scripts/flicker.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--width 1440] [--height 900] [--only typing|idle]",
  );
  process.exit(0);
}
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const ONLY = opt("--only", null);
const TOL = 0.5;

const fail = (why) => {
  console.error(`flicker: could not drive the page: ${why}`);
  process.exit(2);
};

/** Starts the per-frame recorder in the page. */
const RECORD = () => {
  const rec = { frames: [], stop: false };
  window.__flicker = rec;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom };
  };
  // Sampled as the frame is painted: from a ResizeObserver made after the page's own (observers run in the order they were
  // made, after layout and before paint), fed by a probe whose width changes every frame. So what is recorded is what the user
  // saw, not the layout between a change and the observers that settle it in the same frame. (A message task queued from the
  // rAF callback, the earlier way, can run after a key event task that already changed the layout for the NEXT frame: WebKit
  // then showed a composer grown without its column, a frame that was never painted.)
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  document.body.append(probe);
  const tick = () => {
    if (rec.stop) return;
    probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
    requestAnimationFrame(tick);
  };
  new ResizeObserver(() => {
    if (rec.stop) return;
    const strips = [...document.querySelectorAll("[data-strip]")].filter((e) => e.offsetParent).map(box);
    const lists = [...document.querySelectorAll("[data-tab-list]")].filter((e) => e.offsetParent).map(box);
    const column = [...document.querySelectorAll("[data-column]")].find((e) => e.offsetParent);
    const composer = [...document.querySelectorAll("textarea#octo-composer, textarea#octo-composer-float")].find((e) => e.offsetParent);
    rec.frames.push({
      strips,
      lists,
      scroller: box(column?.closest(".overflow-y-auto")),
      column: box(column),
      composer: box(composer),
    });
  }).observe(probe);
  requestAnimationFrame(tick);
};

/** Compares every frame with the one before; returns the problems. */
function analyse(frames) {
  const problems = [];
  const keys = ["top", "left", "width", "height"];
  const still = (name, pick, skip = []) => {
    let worst = 0;
    let at = -1;
    let key = "";
    for (let i = 1; i < frames.length; i++) {
      const a = pick(frames[i - 1]);
      const b = pick(frames[i]);
      if (!a || !b) continue;
      for (const k of keys) {
        if (skip.includes(k)) continue;
        const d = Math.abs(a[k] - b[k]);
        if (d > worst) [worst, at, key] = [d, i, k];
      }
    }
    if (worst > TOL) problems.push(`${name}: ${key} moved ${worst.toFixed(1)}px between frames ${at - 1} and ${at}`);
  };
  const count = Math.max(...frames.map((f) => f.strips.length), 0);
  for (let s = 0; s < count; s++) still(`top row, strip ${s + 1}`, (f) => f.strips[s]);
  const lists = Math.max(...frames.map((f) => f.lists.length), 0);
  for (let s = 0; s < lists; s++) still(`tab row, list ${s + 1}`, (f) => f.lists[s]);
  // The conversation. Its frame never moves; the composer sits under the scroller, so the scroller gives exactly the height the
  // composer takes, and a column pinned to the end moves up by that same amount (the last line stays glued to the composer).
  still("conversation scroller (top, left, width)", (f) => f.scroller, ["height"]);
  still("conversation column (left, width)", (f) => f.column, ["height", "top"]);
  for (let i = 1; i < frames.length; i++) {
    const [a, b] = [frames[i - 1], frames[i]];
    if (!a?.composer || !b?.composer || !a.scroller || !b.scroller || !a.column || !b.column) continue;
    const grew = b.composer.height - a.composer.height;
    const gave = a.scroller.height - b.scroller.height;
    const moved = a.column.top - b.column.top;
    if (Math.abs(gave - grew) > TOL)
      problems.push(`conversation scroller gave ${gave.toFixed(1)}px for a composer that grew ${grew.toFixed(1)}px at frame ${i}`);
    if (Math.abs(moved) > TOL && Math.abs(moved - grew) > TOL)
      problems.push(`conversation column moved ${moved.toFixed(1)}px for a composer that grew ${grew.toFixed(1)}px at frame ${i}`);
  }
  // The composer grows upward: its bottom edge is fixed, its height never shrinks.
  still("composer (bottom edge, left, width)", (f) => f.composer && { ...f.composer, top: f.composer.bottom, height: 0 });
  let prev = null;
  frames.forEach((f, i) => {
    if (f.composer && prev && f.composer.height < prev - TOL)
      problems.push(`composer: height shrank ${prev.toFixed(1)} -> ${f.composer.height.toFixed(1)} at frame ${i}`);
    if (f.composer) prev = f.composer.height;
  });
  return problems;
}

const RUNNING = () =>
  document
    .getAnimations()
    .filter((a) => a.playState === "running")
    .map((a) => {
      const target = a.effect && "target" in a.effect && a.effect.target instanceof Element ? a.effect.target : null;
      const name = "animationName" in a ? a.animationName : "transition";
      const where = target
        ? `${target.tagName.toLowerCase()}${typeof target.className === "string" && target.className ? `.${target.className.split(" ")[0]}` : ""}`
        : "?";
      return `${name} on ${where}`;
    });

const browser = await launchBrowser();
const problems = [];

async function open(query) {
  const ctx = await newContext(browser, { viewport: { width: W, height: H } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("octo.theme", "dark");
      // The scripts open a project by its sidebar row: the tree view lists every project (the flat Sessions view, the default,
      // lists a project only while it has no session).
      localStorage.setItem("octo.sidebarView", "tree");
      for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => isAbortedImport(e.message) || problems.push(`page error: ${String(e.stack ?? e).slice(0, 900)}`));
  await page.goto(`${BASE}/?${query}`, { waitUntil: "domcontentloaded" });
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
  return { ctx, page, projects };
}

async function openProject(page, projects, name) {
  const href = await page.evaluate((n) => {
    for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]'))
      // A project row starts with its name; in the flat Sessions list a session row carries it as its meta (the project's part of the link).
      if ((a.getAttribute("title") || a.textContent.trim()).startsWith(n) || a.textContent.includes(n)) return a.getAttribute("href").match(/^#\/p\/[^/]+/)[0];
    return null;
  }, name);
  if (!href) fail(`project "${name}" not in the sidebar`);
  await page.evaluate((h) => (window.location.hash = h.slice(h.indexOf("#"))), href);
  await page.locator("[data-column]").first().waitFor({ timeout: 10000 });
  // The warmed chunks arrive within ~2 s of start: the test is about layout, not first-load latency.
  await page.waitForTimeout(2500);
}

if (ONLY === null || ONLY === "typing") {
  const { ctx, page, projects } = await open("demo=1");
  await openProject(page, projects, "Atlas API");
  const composer = page.locator("textarea#octo-composer:visible, textarea#octo-composer-float:visible").first();
  await composer.waitFor({ timeout: 8000 }).catch(() => fail("no composer"));
  await composer.click();
  await page.evaluate(RECORD);
  await page.waitForTimeout(200);
  const line = "The quick brown fox jumps over the lazy dog, again and again and again until it is a hundred.".slice(0, 97);
  let typed = 0;
  for (let i = 0; i < 20; i++) {
    const part = `${line}${String(i).padStart(2, "0")}`;
    await page.keyboard.type(part);
    typed += part.length;
    if (i < 19) {
      await page.keyboard.press("Shift+Enter");
      typed += 1;
    }
  }
  await page.waitForTimeout(400);
  const frames = await page.evaluate(() => {
    window.__flicker.stop = true;
    return window.__flicker.frames;
  });
  const text = await composer.inputValue();
  // Every character arrives (a lost one means two composers overwrote each other or the field re-rendered mid-key).
  if (text.length !== typed) problems.push(`typing: ${text.length} of ${typed} characters arrived`);
  const found = analyse(frames);
  for (const p of found) problems.push(`typing: ${p}`);
  console.log(`typing: ${frames.length} frames, ${text.length} characters, ${found.length} problems`);
  await ctx.close();
}

if (ONLY === null || ONLY === "idle") {
  // One project that is idle: nothing in the window may run an animation (decision 76).
  const { ctx, page, projects } = await open("demo=one");
  const idle = async (name) => {
    await page.waitForTimeout(1500);
    const running = await page.evaluate(RUNNING);
    for (const r of running) problems.push(`idle, ${name}: running animation ${r}`);
    console.log(`idle: ${name}: ${running.length} running animations`);
  };
  await page.evaluate(() => (window.location.hash = "#/"));
  await idle("Home, no project at work");
  // The sidebar is a drawer on a narrow window and may be closed here: open it to read the name of the first project.
  if (
    !(await projects
      .first()
      .waitFor({ state: "attached", timeout: 1000 })
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
  const first = await page.evaluate(() => {
    const a = document.querySelector('nav[aria-label="Projects"] a[href^="#/p/"]');
    return a ? (a.getAttribute("title") || a.textContent || "").trim() : "";
  });
  await openProject(page, projects, first);
  await idle("an idle project");
  await page.evaluate(() => (window.location.hash = "#/settings/general"));
  await idle("Settings");
  await ctx.close();
}

await browser.close();
if (problems.length) {
  console.log(`flicker @ ${W}x${H}: FAIL`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log("flicker: ok");
