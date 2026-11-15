#!/usr/bin/env node
/**
 * Decision 95f: measures every tool tab's frame (header height, insets, gaps, row height, title/action alignment) and
 * screenshots it. `--mode before` finds the parts of an old, hand-built screen by their roles; `--mode after` reads the
 * `Panel` markers (`data-panel-*`). Prints a Markdown table and writes `<out>/measure-<mode>.json`.
 *
 *   node packages/ui/scripts/panel-measure.mjs --url http://localhost:1515 --out DIR [--mode after] [--theme dark|light]
 *        [--width 1440] [--height 900] [--only sessions,notes] [--no-shots]
 *
 * Columns (px, relative to the tab's panel): header = the title/action line (or the first line of the screen), top =
 * header top inset, h-inset = left edge of the first thing in the header, r-inset = right edge of its action, gap h>f /
 * f>row = header bottom to the filter row, filter row bottom to the first row, row = height of the first list row,
 * dy = vertical distance between the centres of the title text and the action text (0 = one baseline).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { launchBrowser, newContext } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const OUT = opt("--out", "/tmp/panel-measure");
const MODE = opt("--mode", "after");
const THEMES = opt("--theme", "dark").split(",");
const W = Number(opt("--width", "1440"));
const H = Number(opt("--height", "900"));
const ONLY = opt("--only", null)?.split(",") ?? null;
const SHOTS = !argv.includes("--no-shots");
const PROJECT = opt("--project", "Atlas API");

const T = 4000;
const settle = (page, ms = 300) => page.waitForTimeout(ms);

async function openProject(page) {
  const href = await page.evaluate((name) => {
    for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]')) {
      if ((a.getAttribute("title") || a.textContent.trim()) === name) return a.getAttribute("href");
    }
    return null;
  }, PROJECT);
  // A narrow window has no sidebar: the demo's Atlas API has a fixed id.
  const target = href ? href.slice(href.indexOf("#")) : "#/p/prj_0001";
  await page.evaluate((h) => {
    window.location.hash = h;
  }, target);
  await page.locator("[data-dock-group]").first().waitFor({ timeout: T });
  await settle(page, 600);
}

async function openTool(page, tool) {
  const plus = page.locator("[data-tab-plus]:visible").last();
  await plus.click({ timeout: T });
  const row = page.locator(`[role=option][data-picker-row="tool:${tool}"]`).first();
  await row.waitFor({ timeout: T });
  await row.click({ timeout: T });
  await settle(page, 900);
}

/** The tabs, each with what to wait for and how to find its parts in the old screens. */
const SCENES = [
  { id: "sessions", tool: "sessions", ready: "[data-sessions] [data-row]" },
  { id: "memory-sessions", tool: "memory", ready: "[data-memory] [data-row]" },
  {
    id: "memory-knowledge",
    tool: "memory",
    ready: "[data-memory]",
    pre: (p) => p.getByRole("tab", { name: "Knowledge" }).first().click({ timeout: T }),
    after: "[data-memory] [data-row]",
  },
  {
    id: "memory-files",
    tool: "memory",
    ready: "[data-memory]",
    pre: (p) => p.getByRole("tab", { name: "Files" }).first().click({ timeout: T }),
    after: "[data-memory] [data-row]",
  },
  { id: "notes", tool: "notes", ready: "[data-notes]" },
  { id: "usage", tool: "usage", ready: "[data-usage]" },
  { id: "agents", tool: "agents", ready: "[data-agents]" },
  { id: "details", tool: "details", ready: "[data-details]" },
  { id: "changes", tool: "changes", ready: "[data-v7-changes]" },
  { id: "files", tool: "files", ready: '[role="tree"]' },
];

/** In the page: the parts of one screen as rects, by marker (after) or by role (before). */
function probe({ mode, id, ready }) {
  const panel = document.querySelector(ready)?.closest('[role="tabpanel"]');
  if (!panel) return { error: "no visible tab panel" };
  const P = panel.getBoundingClientRect();
  const q = (sel, root = panel) => [...root.querySelectorAll(sel)].find((e) => e.offsetParent !== null) ?? null;
  const textRect = (el) => {
    if (!el) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    return b.height ? b : el.getBoundingClientRect();
  };
  const byText = (sel, re, root = panel) => [...root.querySelectorAll(sel)].find((e) => e.offsetParent !== null && re.test(e.textContent.trim())) ?? null;
  let header = null;
  let title = null;
  let action = null;
  let filters = null;
  let row = null;
  if (mode === "after") {
    header = q("[data-panel-header]");
    title = q("[data-panel-title]");
    action = [...panel.querySelectorAll("[data-panel-actions] button")].filter((e) => e.offsetParent !== null).pop() ?? null;
    filters = q("[data-panel-filters]");
    row = q("[data-panel-body] [data-row], [data-panel] [data-row]");
  } else {
    const rowOf = (el) => el?.closest("div") ?? null;
    switch (id) {
      case "sessions":
        action = byText("button", /^New session$/);
        header = rowOf(action);
        filters = q('[role="radiogroup"]');
        row = q("[data-sessions] [data-row]");
        break;
      case "memory-sessions":
      case "memory-knowledge":
      case "memory-files": {
        const search = q('input[type="search"], [role="searchbox"]');
        header = search ? (search.closest("div.shrink-0") ?? search.parentElement) : null;
        filters = id === "memory-knowledge" ? q('[role="radiogroup"]') : null;
        row = q("[data-memory] [data-row]");
        break;
      }
      case "notes": {
        const search = q('input[type="search"], [role="searchbox"]');
        header = search ? (search.closest("div.shrink-0") ?? search.parentElement) : null;
        action = byText("button", /^Add note$/) ?? q('button[aria-label="Add note"]');
        row = q("[data-notes] [data-row]");
        break;
      }
      case "usage":
        header = q('[role="tablist"]')?.parentElement ?? null;
        filters = q("[data-usage] .flex-wrap");
        row = q("[data-usage] [data-row], [data-usage] table tbody tr");
        break;
      case "agents":
        header = q("[data-agents] h2")?.parentElement ?? null;
        title = q("[data-agents] h2");
        row = q("[data-agents] [data-row]");
        break;
      case "details":
        header = q("[data-details] h2")?.parentElement ?? null;
        title = q("[data-details] h2");
        row = q("[data-details] [data-row]");
        break;
      case "changes":
        header = q("[data-v7-changes] nav > *");
        row = q("[data-v7-changes] [data-row], [data-v7-changes] nav button");
        break;
      case "files":
        header = q('[role="tree"]')?.parentElement?.firstElementChild ?? null;
        row = q('[role="treeitem"]');
        break;
    }
  }
  const rel = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top - P.top, bottom: r.bottom - P.top, left: r.left - P.left, right: P.right - r.right, height: r.height };
  };
  const h = rel(header);
  const f = rel(filters);
  const r = rel(row);
  // Left edge of the first visible text inside an element (the optical edge, not the box).
  const textLeft = (el) => {
    if (!el) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      const b = rg.getBoundingClientRect();
      if (b.width > 0) return b.left - P.left;
    }
    return null;
  };
  const tr = textRect(title);
  const ar = textRect(action);
  // The nearest chrome above the first row: the header, the filter row or the view tabs, whichever ends last above it.
  const tabs = q('[role="tablist"]')?.parentElement ?? null;
  const above = [header, filters, tabs].flatMap((e) =>
    e && row && e.getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 0.5 ? [e.getBoundingClientRect().bottom] : [],
  );
  const chromeBottom = above.length ? Math.max(...above) - P.top : null;
  return {
    panel: { w: P.width, h: P.height },
    header: h && { height: h.height, top: h.top, bottom: h.bottom },
    // Text edge of the title; a screen without a title: the left edge of its first control (the box a person sees).
    hInset: header
      ? title
        ? textLeft(title)
        : (() => {
            const c = header.firstElementChild;
            return c ? c.getBoundingClientRect().left - P.left : textLeft(header);
          })()
      : null,
    rInset: action ? rel(action).right : null,
    filter: f && { height: f.height, top: f.top, bottom: f.bottom, left: f.left },
    filterText: filters ? textLeft(filters) : null,
    gapHF: h && f ? f.top - h.bottom : null,
    gapFL: chromeBottom !== null && r ? r.top - chromeBottom : null,
    gapHL: h && r ? r.top - h.bottom : null,
    row: r && { height: r.height, left: r.left, top: r.top },
    rowText: row ? textLeft(row) : null,
    dy: tr && ar ? Math.round((tr.top + tr.height / 2 - (ar.top + ar.height / 2)) * 10) / 10 : null,
  };
}

const fmt = (v) => (v === null || v === undefined ? "–" : typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));

async function main() {
  const browser = await launchBrowser();
  const results = {};
  for (const theme of THEMES) {
    for (const scene of SCENES) {
      if (ONLY && !ONLY.includes(scene.id)) continue;
      // One context per screen: the dock remembers its tabs, and a leftover tab changes where the next one opens.
      const ctx = await newContext(browser, { viewport: { width: W, height: H } });
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem("octo.theme", t);
        } catch {
          /* storage blocked */
        }
      }, theme);
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/?demo=1`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1200);
        await openProject(page);
        await openTool(page, scene.tool);
        await page.locator(scene.ready).first().waitFor({ timeout: T });
        if (scene.pre) {
          await scene.pre(page);
          await settle(page, 500);
          if (scene.after) await page.locator(scene.after).first().waitFor({ timeout: T });
        }
        await settle(page, 500);
        const m = await page.evaluate(probe, { mode: MODE, id: scene.id, ready: scene.after ?? scene.ready });
        results[`${theme}/${scene.id}`] = m;
        if (SHOTS) {
          mkdirSync(OUT, { recursive: true });
          await page.screenshot({ path: `${OUT}/${W}x${H}-${theme}-${scene.id}.png` });
        }
      } catch (e) {
        results[`${theme}/${scene.id}`] = { error: String(e.message ?? e).split("\n")[0] };
      }
      await ctx.close();
    }
  }
  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/measure-${MODE}-${W}x${H}.json`, JSON.stringify(results, null, 2));
  const head = "| tab | header h | top | h-inset | r-inset | gap h>f | gap f>row | gap h>row | filter h | filter text x | row h | row text x | dy |";
  console.log(`${head}\n|${" --- |".repeat(13)}`);
  for (const [k, m] of Object.entries(results)) {
    if (!k.startsWith(`${THEMES[0]}/`)) continue;
    const name = k.split("/")[1];
    if (m.error) {
      console.log(`| ${name} | ${m.error} |`);
      continue;
    }
    console.log(
      `| ${name} | ${fmt(m.header?.height)} | ${fmt(m.header?.top)} | ${fmt(m.hInset)} | ${fmt(m.rInset)} | ${fmt(m.gapHF)} | ${fmt(m.gapFL)} | ${fmt(m.gapHL)} | ${fmt(m.filter?.height)} | ${fmt(m.filterText)} | ${fmt(m.row?.height)} | ${fmt(m.rowText)} | ${fmt(m.dy)} |`,
    );
  }
}

main().catch((e) => {
  console.error(e.stack ?? e);
  process.exit(2);
});
