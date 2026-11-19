#!/usr/bin/env node
/**
 * Decision 60: opening a file never makes the window jump. Drives the demo UI with Playwright from a full-width
 * conversation, opens the Files tool (the first split) and then a file, and samples the rects of the conversation column
 * and the sidebar every animation frame. A "shift" is a frame in which a rect differs from the previous frame's by more
 * than 0.5px. Asserts: the conversation column shifts at most once in the whole sequence (one frame, no animation
 * through intermediate sizes, no second re-wrap when the file view or Monaco arrives), the sidebar never, and the
 * conversation's scroll anchor (the message at the top of the viewport) moves by at most 2px.
 *
 *   node packages/ui/scripts/layout-shift.mjs [--anchor] [--url http://localhost:1420] [--browser chromium|webkit] [--width 1440] [--height 900] [--project "Atlas API"]
 */
import { launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const PROJECT = opt("--project", "Atlas API");
// --anchor: also run lib/scrollAnchorTrack.ts on the conversation's scroller (what the chat feature does once it calls the hook).
const ANCHOR = argv.includes("--anchor");
const ITEMS = "article, article :is(p, li, pre, h1, h2, h3, h4, blockquote, tr)";

const SAMPLER = (items) => {
  const col = () => [...document.querySelectorAll("[data-column]")].find((e) => e.offsetParent);
  const nav = () => document.querySelector('nav[aria-label="Projects"]');
  // Horizontal geometry only for the column: its top moves with the user's own scrolling, which is not a shift.
  const box = (e) => (e ? (({ left, top, width, height }) => [left, top, width, height])(e.getBoundingClientRect()) : null);
  const colBox = (e) => (e ? (({ left, width }) => [left, width])(e.getBoundingClientRect()) : null);
  const differs = (a, b) => (a === null) !== (b === null) || (a !== null && b !== null && a.some((v, i) => Math.abs(v - b[i]) > 0.5));
  const st = { column: 0, sidebar: 0, frames: 0, anchorMove: 0, on: true, log: [] };
  let pc = colBox(col());
  let pn = box(nav());
  const sc = () => col()?.closest(".overflow-y-auto") ?? null;
  // The anchor: the first article whose bottom is below the scroller's top, with its offset from that top.
  const anchor = () => {
    const s = sc();
    if (!s) return null;
    const top = s.getBoundingClientRect().top;
    const near = [...s.querySelectorAll(items)].filter((a) => a.getBoundingClientRect().bottom > top + 1).slice(0, 40);
    const el = near.find((c) => !near.some((o) => o !== c && c.contains(o)));
    return el ? { el, off: el.getBoundingClientRect().top - top } : null;
  };
  let pa = anchor();
  // Sampled in a task queued from the animation frame, i.e. after that frame was rendered: what the user saw, not the
  // layout the frame's resize observers are about to correct.
  const tick = () => setTimeout(sample, 0);
  const sample = () => {
    if (!st.on) return;
    st.frames++;
    const c = colBox(col());
    const n = box(nav());
    if (differs(c, pc)) {
      st.column++;
      st.log.push(`frame ${st.frames}: column ${pc ? pc.map(Math.round) : "-"} -> ${c ? c.map(Math.round) : "-"}`);
    }
    if (differs(n, pn)) st.sidebar++;
    const s = sc();
    if (pa && s && pa.el.isConnected) {
      const off = pa.el.getBoundingClientRect().top - s.getBoundingClientRect().top;
      if (Math.abs(off - pa.off) > st.anchorMove)
        st.log.push(
          `frame ${st.frames}: anchor ${pa.el.tagName} moved ${Math.round(off - pa.off)}px (scrollTop ${Math.round(s.scrollTop)}, h ${Math.round(s.scrollHeight)}, w ${s.clientWidth})`,
        );
      st.anchorMove = Math.max(st.anchorMove, Math.abs(off - pa.off));
    }
    pc = c;
    pn = n;
    requestAnimationFrame(tick);
  };
  window.__shift = st;
  window.__resetAnchor = () => {
    pa = anchor();
    st.anchorMove = 0;
  };
  requestAnimationFrame(tick);
};

const browser = await launchBrowser();
const ctx = await newContext(browser, { viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("octo.theme", "dark");
    // The scripts open a project by its sidebar row: the tree view lists every project (the flat Sessions view, the default,
    // lists a project only while it has no session).
    localStorage.setItem("octo.sidebarView", "tree");
    for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
  } catch {}
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => isAbortedImport(e.message) || errors.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/?demo=1`, { waitUntil: "domcontentloaded" });
await page.locator('nav[aria-label="Projects"] a').first().waitFor({ timeout: 8000 });
const href = await page.evaluate((name) => {
  for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]'))
    // A project row starts with its name; in the flat Sessions list a session row carries it as its meta (the project's part of the link).
    if ((a.getAttribute("title") || a.textContent.trim()).startsWith(name) || a.textContent.includes(name))
      return a.getAttribute("href").match(/^#\/p\/[^/]+/)[0];
  return null;
}, PROJECT);
if (!href) throw new Error(`project "${PROJECT}" not in the sidebar`);
await page.evaluate((h) => (window.location.hash = h.slice(h.indexOf("#"))), href);
await page.locator("[data-column]").first().waitFor({ timeout: 8000 });
await page.waitForTimeout(2500); // let the warmed chunks (file view, picker) arrive: the test is about layout, not first-load latency

const groups = await page.locator("[data-dock-group]").count();
if (groups !== 1) throw new Error(`expected a full-width conversation (1 group), found ${groups}`);
if (ANCHOR)
  await page.evaluate(async (items) => {
    const m = await import("/@fs/home/user/Octo/packages/ui/src/lib/scrollAnchorTrack.ts");
    const sc = document.querySelector("[data-column]")?.closest(".overflow-y-auto");
    if (sc) m.trackScrollAnchor(sc, items);
  }, ITEMS);
await page.evaluate(SAMPLER, ITEMS);
await page.evaluate(() => window.__resetAnchor());
// Scroll the conversation into the middle so the anchor is a real message.
await page.evaluate(() => {
  const s = document.querySelector("[data-column]")?.closest(".overflow-y-auto");
  // The reader's wheel first: the conversation follows its end until the reader scrolls away themselves.
  s?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
  if (s) s.scrollTop = Math.max(0, (s.scrollHeight - s.clientHeight) / 2);
});
await page.waitForTimeout(300);
await page.evaluate(() => window.__resetAnchor());

const plus = page.locator("[data-tab-plus]:visible").last();
await plus.click();
await page.locator('[role=option][data-picker-row="tool:files"]').first().click();
await page.getByRole("tree", { name: "Project files" }).first().waitFor({ timeout: 8000 });
await page.waitForTimeout(600);
const afterTool = await page.evaluate(() => ({ ...window.__shift }));
// Open the first file in the tree (expand folders until a file shows).
for (let i = 0; i < 10; i++) {
  const kind = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="tree"][aria-label="Project files"] [role="treeitem"]')];
    const file = items.find((e) => e.getAttribute("aria-expanded") === null);
    const dir = items.find((e) => e.getAttribute("aria-expanded") === "false");
    const t = file ?? dir;
    if (!t) return null;
    t.setAttribute("data-shift-target", "1");
    return file ? "file" : "dir";
  });
  if (!kind) break;
  await page.locator('[data-shift-target="1"]').first().click();
  await page.evaluate(() => document.querySelectorAll("[data-shift-target]").forEach((e) => e.removeAttribute("data-shift-target")));
  await page.waitForTimeout(kind === "file" ? 1500 : 200);
  if (kind === "file") break;
}
const end = await page.evaluate(() => ({ ...window.__shift, on: false }));
await browser.close();

const fails = [];
if (end.column > 1) fails.push(`the conversation column shifted in ${end.column} frames (at most 1)`);
if (end.sidebar > 0) fails.push(`the sidebar shifted in ${end.sidebar} frames (none allowed)`);
if (end.anchorMove > 2) fails.push(`the conversation's top message moved ${Math.round(end.anchorMove)}px (at most 2)`);
if (errors.length) fails.push(`page errors: ${errors.join(" | ")}`);
console.log(
  `[layout-shift @ ${W}x${H}] files tool: column ${afterTool.column}; whole sequence: column ${end.column}, sidebar ${end.sidebar}, anchor moved ${Math.round(end.anchorMove)}px, ${end.frames} frames`,
);
if (fails.length) for (const l of end.log) console.log(`    ${l}`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
