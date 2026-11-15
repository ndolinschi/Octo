#!/usr/bin/env node
/**
 * Spacing audit (contract: docs/superpowers/specs/2026-11-10-project-harness-ui.md, "v6", decisions 1 and 2).
 *
 * Drives the running UI (demo data) with Playwright, walks the visible DOM and reports violations of the spacing
 * system. Exit code 1 when there are violations (or skipped states with --strict), 0 otherwise.
 *
 *   node packages/ui/scripts/spacing-audit.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--only <state>] [--json <path>]
 *                                              [--strict] [--selftest] [--query "demo=1"] [--list] [--help]
 *
 * Rules: scale, row-height, gutter, edges, icon-gap, overlap, inset-balance, dialog-bounds, field-row, key-hint, panel-frame (see RULES below).
 * States that cannot be reached are reported as `skipped` with a reason, never as a crash.
 */
import { writeFileSync } from "node:fs";
import { launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

// ---------------------------------------------------------------------------------------------------------------
// Allow-list. Every entry is printed in the report so exceptions stay visible.
//   rule      rule id (or "*")
//   selector  CSS selector; an element is exempt when `el.matches(selector)` (checked on the offending element)
//   reason    why this is not a defect (Monaco internals and text optical offsets are NOT valid reasons)
// ---------------------------------------------------------------------------------------------------------------
/** @type {{ rule: string; selector: string; reason: string }[]} */
const ALLOW = [
  {
    rule: "scale",
    selector: "[data-strip]",
    reason:
      "the first tab strip of a window whose sidebar is closed starts after the window controls' inset and the three window buttons (decision 67); the width is computed from the host's inset, not authored spacing",
  },
  {
    rule: "gutter",
    selector: "[data-phone] [data-dock-group]",
    reason: "direction 7: on the phone the one-line header (44px, a touch row) sits above the dock; the group starts under it",
  },
  {
    rule: "scale",
    selector: "[data-phone] .pt-bar",
    reason: "direction 7: room for the phone's 44px header line (the bar token, a touch row height, not authored spacing)",
  },
  {
    rule: "scale",
    selector: "[data-phone] .octo-diff-code",
    reason:
      "the hanging indent of a wrapped diff line (styles.css, `--diff-hang`): the line's own indentation in ch (min(--diff-lead, 16ch) + 2ch, set per line by DiffPreview), so a continuation lines up under the code; content geometry, not authored spacing; only on the phone, only where the line wraps",
  },
  {
    rule: "scale",
    selector: ".sr-only",
    reason: "the visually hidden pattern (1px box, -1px margins): never laid out for the eye",
  },
];

const SCALE = [2, 4, 6, 8, 12, 16, 20, 24, 32, 40];
const ROW_HEIGHTS = [24, 28, 32, 36, 40];
/** Direction 7: in the phone layout every touch row is 44px (`--spacing-ctl-lg` there). */
const PHONE_ROW_HEIGHTS = [...ROW_HEIGHTS, 44];
const TOL = 0.5;
const ICON_GAP_MIN = 6;
const RULES = ["scale", "row-height", "gutter", "edges", "icon-gap", "overlap", "inset-balance", "dialog-bounds", "field-row", "key-hint", "panel-frame"];

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const ONLY = opt("--only", null);
const JSON_OUT = opt("--json", null);
const STRICT = flag("--strict");
const SELFTEST = flag("--selftest");
const QUERY = opt("--query", "demo=1");
const HELP = `Spacing audit — drives the running UI (demo data) and reports spacing violations.

Usage: node packages/ui/scripts/spacing-audit.mjs [options]

  --url <base>      dev server to audit (default http://localhost:1420); demo data is required
  --query <q>       query string for the app (default "demo=1")
  --only <state>    audit one state, or several separated by commas (see --list)
  --json <path>     also write the full report as JSON
  --strict          exit 1 when a state is skipped (unreachable), not only on violations
  --selftest        run the in-page rules against a synthetic page first
  --list            print the states and their viewports, then exit
  --help, -h        this text

Exit code: 0 = total 0, 1 = violations (or skips with --strict), 2 = bad arguments.
Rules: ${RULES.join(", ")}.`;
if (flag("--help") || flag("-h")) {
  console.log(HELP);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Playwright resolution: local, then the global node path.
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------------------------
class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why);
};

const WIDE = [
  { width: 1440, height: 900 },
  { width: 1100, height: 800 },
];
const CHAT_VPS = [...WIDE, { width: 960, height: 800 }, { width: 390, height: 800 }];

const T = 4000;
const settle = (page, ms = 250) => page.waitForTimeout(ms);

async function openProject(page, ctx, name) {
  const href = ctx.hrefs[name];
  if (!href) skip(`project "${name}" not found in the sidebar`);
  await page.evaluate(
    (h) => {
      window.location.hash = h;
    },
    href.slice(href.indexOf("#")),
  );
  try {
    await page.locator("[data-dock-group]").first().waitFor({ timeout: T });
  } catch {
    skip(`project "${name}" did not render a dock group`);
  }
  await settle(page, 600);
}

async function waitChat(page) {
  try {
    await page.locator("[data-composer]").first().waitFor({ state: "visible", timeout: T });
  } catch {
    skip("no visible composer (Chat tab not shown)");
  }
  try {
    await page.locator("[data-column]").first().waitFor({ state: "visible", timeout: 2000 });
  } catch {
    /* empty chat is fine */
  }
  await settle(page, 500);
}

/** The tool rows of the strip's "+" picker (v6.3 part 2, decision 24: the tool buttons left the strip). */
const TOOL_ROWS = { "Show agents": "agents", "Show notes": "notes", "Show files": "files", "Show project details": "details", "Show usage": "usage" };

async function clickTool(page, label) {
  if (
    label === "Show files" &&
    (await page
      .getByRole("tree", { name: "Project files" })
      .first()
      .isVisible()
      .catch(() => false))
  )
    return;
  await openTool(page, label);
}

/** Expand folders until a file matching `re` is visible; click it. */
async function openFileMatching(page, re, what) {
  await clickTool(page, "Show files");
  const tree = page.getByRole("tree", { name: "Project files" }).first();
  try {
    await tree.waitFor({ timeout: T });
  } catch {
    skip("file tree not found");
  }
  for (let i = 0; i < 12; i++) {
    const hit = await page.evaluate((src) => {
      const r = new RegExp(src);
      const items = [...document.querySelectorAll('[role="tree"][aria-label="Project files"] [role="treeitem"]')];
      const file = items.find((e) => e.getAttribute("aria-expanded") === null && r.test(e.textContent.trim()));
      if (file) {
        file.setAttribute("data-audit-target", "1");
        return "file";
      }
      const dir = items.find((e) => e.getAttribute("aria-expanded") === "false");
      if (dir) {
        dir.setAttribute("data-audit-target", "1");
        return "dir";
      }
      return null;
    }, re.source);
    if (!hit) skip(`no ${what} found in the file tree`);
    const el = page.locator('[data-audit-target="1"]').first();
    await el.click({ timeout: T });
    await page.evaluate(() => document.querySelectorAll("[data-audit-target]").forEach((e) => e.removeAttribute("data-audit-target")));
    await settle(page, 300);
    if (hit === "file") {
      await settle(page, 700);
      const opened = await page.locator('[role="tab"][data-tab-id^="file:"]').count();
      if (!opened) skip(`clicking the ${what} did not open a File tab`);
      return;
    }
  }
  skip(`${what} not reached by expanding folders`);
}

/** @type {{ id: string; viewports: {width:number;height:number}[]; run(page, ctx): Promise<void>; checks?: string[] }[]} */
/** Opens a tool tab through the last strip's "+" picker (decision 25). */
/** Direction 7: the phone reaches the same tools from the header's "⋯" sheet (`PhoneMoreSheet`), by these labels. */
const PHONE_PANELS = {
  files: "Files",
  changes: "Changes",
  sessions: "Sessions",
  memory: "Memory",
  notes: "Notes",
  usage: "Usage",
  agents: "Agents",
  details: "Details",
  side: "Side question",
  review: "Review",
};

async function openTool(page, label) {
  const plus = page.locator("[data-tab-plus]:visible").last();
  const more = page.locator("[data-phone-header]").getByRole("button", { name: "More" }).first();
  if (!(await plus.count()) && (await more.isVisible().catch(() => false))) {
    // The phone layout (a window under 480px is one, touch or not): the tool opens from the "⋯" sheet, as a person would.
    const name = PHONE_PANELS[TOOL_ROWS[label] ?? label];
    if (!name) skip(`"${label}" has no row on the phone's "⋯" sheet`);
    await more.click({ timeout: T });
    const row = page.locator("[data-phone-more]").getByRole("button", { name, exact: true });
    try {
      await row.waitFor({ timeout: T });
    } catch {
      skip(`"${name}" not on the phone's "⋯" sheet`);
    }
    await row.click({ timeout: T });
    await settle(page, 900);
    return;
  }
  if (!(await plus.count())) skip('no "+" in the tab strip');
  await plus.click({ timeout: T });
  const row = page.locator(`[role=option][data-picker-row="tool:${TOOL_ROWS[label] ?? label}"]`).first();
  try {
    await row.waitFor({ timeout: T });
  } catch {
    skip(`"${label}" not in the "+" picker`);
  }
  await row.click({ timeout: T });
  await settle(page, 900);
}

async function openMemoryTab(page, ctx) {
  await openProject(page, ctx, "Atlas API");
  await openTool(page, "memory");
  try {
    await page.locator("[data-memory]").first().waitFor({ timeout: T });
  } catch {
    skip("Memory tab did not render");
  }
  await settle(page, 500);
}

async function openSessionsTab(page, ctx) {
  await openProject(page, ctx, "Atlas API");
  await openTool(page, "sessions");
  try {
    await page.locator("[data-sessions]").first().waitFor({ timeout: T });
    await page.locator("[data-sessions] [data-row]").first().waitFor({ timeout: T });
  } catch {
    skip("Sessions tab did not render");
  }
  await settle(page, 500);
}

const HOME_VPS = [...WIDE, { width: 390, height: 844 }];

const STATES = [
  {
    id: "home",
    viewports: HOME_VPS,
    async run(page) {
      await page.evaluate(() => {
        window.location.hash = "#/";
      });
      try {
        await page.locator("[data-home]").first().waitFor({ timeout: T });
      } catch {
        skip("Home did not render");
      }
      await settle(page, 1500);
    },
  },
  {
    id: "empty-project",
    viewports: HOME_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Design system tokens");
      await waitChat(page);
      await settle(page, 900);
    },
  },
  {
    id: "usage",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Orbit mobile");
      await openTool(page, "Show usage");
      if (!(await page.locator("[data-usage]").count())) skip("Usage tab did not render");
    },
  },
  {
    // Decision 95f: every tool tab sits in one `Panel` frame. Opens each tab and compares the frame's three numbers.
    id: "panel-frame",
    viewports: [WIDE[0]],
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
    },
    async extra(page) {
      const TABS = ["sessions", "memory", "notes", "usage", "agents", "details", "changes"];
      const rows = [];
      for (const tool of TABS) {
        await openTool(page, tool);
        rows.push(
          (await page.evaluate((name) => {
            const p = [...document.querySelectorAll(`[data-panel="${name}"]`)].find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
            if (!p) return { name, missing: true };
            const P = p.getBoundingClientRect();
            const title = p.querySelector("[data-panel-title]");
            let titleLeft = null;
            if (title) {
              const w = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
              const n = w.nextNode();
              if (n) {
                const r = document.createRange();
                r.selectNodeContents(n);
                titleLeft = r.getBoundingClientRect().left - P.left;
              }
            }
            const head = p.querySelector("[data-panel-header]");
            const body = p.querySelector("[data-panel-body]");
            const scroller =
              body &&
              [...body.querySelectorAll("*")].find(
                (e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.offsetParent !== null && !e.closest("[data-panel-filters]"),
              );
            const cs = scroller && getComputedStyle(scroller);
            return {
              name,
              headerH: head ? head.getBoundingClientRect().height : null,
              titleLeft,
              listInset: scroller && cs ? scroller.getBoundingClientRect().left - P.left + parseFloat(cs.paddingLeft) : null,
              // The gap from what ends the chrome (header, filter row or view tabs) to the first row's slot: the list's own top inset.
              listGap: scroller && cs ? parseFloat(cs.paddingTop) : null,
            };
          }, tool)) ?? { name: tool, missing: true },
        );
      }
      const out = [];
      const mode = (vals) => {
        const c = new Map();
        for (const v of vals) c.set(v, (c.get(v) ?? 0) + 1);
        return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      };
      for (const r of rows)
        if (r.missing)
          out.push({
            rule: "panel-frame",
            selector: `[data-panel="${r.name}"]`,
            text: "",
            prop: "tab is not in a Panel",
            measured: "no [data-panel]",
            expected: "Panel frame",
          });
      const seen = rows.filter((r) => !r.missing);
      for (const [key, label] of [
        ["headerH", "header height"],
        ["titleLeft", "header text inset"],
        ["listInset", "list horizontal inset"],
        ["listGap", "filter-to-list gap"],
      ]) {
        const vals = seen.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
        const want = mode(vals.map((v) => Math.round(v * 2) / 2));
        for (const r of seen) {
          const v = r[key];
          if (v === null || v === undefined) continue;
          if (Math.abs(v - want) > TOL)
            out.push({
              rule: "panel-frame",
              selector: `[data-panel="${r.name}"]`,
              text: "",
              prop: label,
              measured: `${Math.round(v * 10) / 10}px`,
              expected: `${want}px (as the other tabs)`,
            });
        }
      }
      return out;
    },
  },
  {
    id: "details-tab",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await openTool(page, "Show project details");
      await settle(page, 1200);
    },
  },
  {
    id: "integrations",
    viewports: HOME_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await page.keyboard.press("Control+k");
      try {
        await page.getByRole("dialog", { name: "Command palette" }).waitFor({ timeout: T });
      } catch {
        skip("Ctrl+K did not open the command palette");
      }
      await page.keyboard.type("Open integrations");
      await settle(page, 400);
      await page.keyboard.press("Enter");
      await settle(page, 1200);
    },
  },
  {
    id: "chat-idle",
    viewports: CHAT_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await waitChat(page);
    },
  },
  {
    id: "chat-running",
    viewports: CHAT_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Orbit mobile");
      await waitChat(page);
    },
  },
  {
    id: "delegation",
    viewports: CHAT_VPS,
    async run(page, ctx) {
      // Delegation cards live in the Atlas conversation (finished) and the Orbit one (running).
      for (const name of ["Atlas API", "Orbit mobile"]) {
        await openProject(page, ctx, name);
        await waitChat(page);
        const found = await page.evaluate(() => {
          const s = document.querySelector('section[aria-label^="Delegated"], section[aria-label$="in parallel"]');
          if (!s) return false;
          s.scrollIntoView({ block: "center" });
          return true;
        });
        if (found) {
          await settle(page, 400);
          return;
        }
      }
      skip("no delegation card in Atlas API or Orbit mobile");
    },
  },
  {
    id: "agents-tab",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await clickTool(page, "Show agents");
      if (!(await page.getByRole("tabpanel").count())) skip("no tab panel after opening Agents");
    },
  },
  {
    id: "memory-sessions",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openMemoryTab(page, ctx);
      await page.getByRole("tab", { name: "Sessions" }).first().waitFor({ timeout: T });
    },
  },
  {
    id: "memory-exchange",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openMemoryTab(page, ctx);
      await page.locator("[data-memory] [data-row]").first().click({ timeout: T });
      await settle(page, 400);
      const row = page.locator("[data-memory] [data-exchange] [data-row]").first();
      if (!(await row.count())) skip("no exchange row in the demo session");
      await row.click({ timeout: T });
      await settle(page, 400);
    },
  },
  {
    id: "memory-knowledge",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openMemoryTab(page, ctx);
      await page.getByRole("tab", { name: "Knowledge" }).first().click({ timeout: T });
      await settle(page, 400);
      const task = page.getByRole("list", { name: "Tasks" }).locator("[data-row]").first();
      if (!(await task.count())) skip("no task rows in Knowledge");
      await task.click({ timeout: T });
      await settle(page, 400);
    },
  },
  {
    id: "memory-files",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openMemoryTab(page, ctx);
      await page.getByRole("tab", { name: "Files" }).first().click({ timeout: T });
      await settle(page, 400);
      await page.locator("[data-memory] [data-row]").first().click({ timeout: T });
      await settle(page, 400);
    },
  },
  {
    id: "sessions-list",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openSessionsTab(page, ctx);
      await page.locator("[data-sessions] [data-row]").first().click({ timeout: T });
      await settle(page, 400);
      // Narrow: the click opened the detail; Back returns to the list with the row open.
      const backButton = page
        .locator("[data-sessions]")
        .getByRole("button", { name: /^(Back to )?Sessions$/ })
        .first();
      if (await backButton.isVisible().catch(() => false)) await backButton.click({ timeout: T });
      await settle(page, 300);
    },
  },
  {
    id: "sessions-main",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openSessionsTab(page, ctx);
      const second = page.locator('[data-sessions] ul[aria-label="Sessions"] > li').nth(1).locator("[data-row]").first();
      if (!(await second.count())) skip("no second session in the demo");
      await second.click({ timeout: T });
      await settle(page, 700);
    },
  },
  {
    id: "sessions-agent",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openSessionsTab(page, ctx);
      const second = page.locator('[data-sessions] ul[aria-label="Sessions"] > li').nth(1).locator("[data-row]").first();
      await second.click({ timeout: T });
      await settle(page, 300);
      const backButton = page
        .locator("[data-sessions]")
        .getByRole("button", { name: /^(Back to )?Sessions$/ })
        .first();
      if (await backButton.isVisible().catch(() => false)) await backButton.click({ timeout: T });
      const agent = page.locator("[data-sessions] [data-row]", { hasText: "Collect the open pull requests" }).first();
      if (!(await agent.count())) skip("no agent session under the second session");
      await agent.click({ timeout: T });
      await settle(page, 700);
    },
  },
  {
    id: "memory-search",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page, ctx) {
      await openMemoryTab(page, ctx);
      await page.getByRole("searchbox", { name: "Search memory" }).fill("refresh token");
      await settle(page, 1000);
    },
  },
  {
    id: "notes-tab",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await clickTool(page, "Show notes");
    },
  },
  {
    id: "file-view",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await openFileMatching(page, /\.ts$/, ".ts file");
      await page
        .locator(".monaco-editor")
        .first()
        .waitFor({ timeout: T })
        .catch(() => {});
      await settle(page, 600);
    },
  },
  {
    id: "markdown-file",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await openFileMatching(page, /\.(md|markdown)$/i, "Markdown file");
      await settle(page, 600);
    },
  },
  {
    id: "command-palette",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await page.keyboard.press("Control+k");
      try {
        await page.getByRole("dialog", { name: "Command palette" }).waitFor({ timeout: T });
      } catch {
        skip("Ctrl+K did not open the command palette");
      }
      await settle(page, 400);
    },
  },
  // Decision 59: Settings is a page; the Providers section and the connect sheet of an agent.
  {
    id: "settings-page",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      const btn = page.getByRole("button", { name: "Settings", exact: true }).first();
      if (!(await btn.count()) || !(await btn.isVisible())) skip("sidebar Settings button not visible");
      await btn.click({ timeout: T });
      try {
        await page.locator("[data-settings]").waitFor({ timeout: T });
        await page.getByRole("link", { name: "Providers" }).click({ timeout: T });
        await page.locator("#row-provider-copilot").waitFor({ timeout: T });
      } catch {
        skip("settings page did not open");
      }
      await settle(page, 400);
    },
  },
  // Decision 89: Providers is a list and a detail. The owner's live set; three checks beyond the general rules.
  {
    id: "providers",
    viewports: [...WIDE, { width: 390, height: 800 }],
    async run(page) {
      await page.goto(`${BASE}/?demo=1&providers=owner#/settings/providers`, { waitUntil: "domcontentloaded" });
      try {
        await page.locator("#row-provider-claude-code").waitFor({ timeout: T });
      } catch {
        skip("providers page did not open");
      }
      await settle(page, 600);
    },
    async extra(page) {
      return page.evaluate(() => {
        const out = [];
        const rows = [...document.querySelectorAll('[aria-label="Providers"] [data-row]')].filter((r) => r.getBoundingClientRect().height > 0);
        const heights = new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height * 2) / 2));
        if (rows.length && heights.size > 1)
          out.push({
            rule: "row-height",
            selector: "[aria-label=Providers] [data-row]",
            text: "",
            prop: "equal heights",
            measured: [...heights].join(" "),
            expected: "one height",
          });
        for (const r of rows)
          if (r.querySelector("button, a[href]"))
            out.push({
              rule: "row-height",
              selector: `#${r.id || "row"}`,
              text: r.textContent.slice(0, 30),
              prop: "button inside a row",
              measured: "yes",
              expected: "none",
            });
        const list = document.querySelector('[aria-label="Providers"]');
        const detail = document.querySelector("[data-provider-detail]");
        if (list && detail && list.getBoundingClientRect().height > 0 && detail.getBoundingClientRect().height > 0 && window.innerWidth >= 1000) {
          // The list is its own frame (ProviderRows); the detail sits in a ListFrame, so compare frame tops.
          const dt = (detail.parentElement ?? detail).getBoundingClientRect().top;
          const lt = list.getBoundingClientRect().top;
          if (Math.abs(dt - lt) > 0.5)
            out.push({ rule: "edges", selector: "[data-provider-detail]", text: "", prop: "top", measured: `${dt}px`, expected: `${lt}px (the list's top)` });
        }
        for (const f of document.querySelectorAll("[data-field-row]")) {
          const tops = [...f.querySelectorAll("[data-field-control]")].map((c) => Math.round(c.getBoundingClientRect().top));
          if (f.getBoundingClientRect().width > 560 && new Set(tops).size > 1)
            out.push({ rule: "edges", selector: "[data-field-row]", text: "", prop: "control tops", measured: tops.join(" "), expected: "equal" });
        }
        return out;
      });
    },
  },
  {
    id: "providers-open",
    viewports: [WIDE[0]],
    async run(page) {
      await page.goto(`${BASE}/?demo=1&providers=owner#/settings/providers`, { waitUntil: "domcontentloaded" });
      try {
        await page.getByRole("button", { name: /more (agents|providers) can be added/ }).click({ timeout: T });
        await page.locator("#row-provider-api").click({ timeout: T });
      } catch {
        skip("the folded row did not open");
      }
      await settle(page, 400);
    },
  },
  // v6.3 part 2: the new surfaces.
  {
    id: "tab-picker",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await page.locator("[data-tab-plus]:visible").last().click({ timeout: T });
      try {
        await page.getByRole("dialog", { name: "Open a tab" }).waitFor({ timeout: T });
      } catch {
        skip("the + picker did not open");
      }
      await settle(page, 300);
    },
  },
  {
    id: "model-picker",
    viewports: HOME_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await waitChat(page);
      // Phone layout: the model chip is in the composer's "+" sheet.
      const chip = page.locator("[data-composer] [data-model-picker]").first();
      if (await chip.isVisible().catch(() => false)) await chip.click({ timeout: T });
      else {
        await page.getByRole("button", { name: "Attach, mention or run" }).first().click({ timeout: T });
        await settle(page, 600);
        await page.locator("[data-model-picker]:visible").first().click({ timeout: T });
      }
      try {
        await page.getByRole("dialog", { name: /^Choose /i }).waitFor({ timeout: T });
      } catch {
        skip("the model picker did not open");
      }
      await settle(page, 300);
    },
  },
  {
    id: "side-question",
    viewports: HOME_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await waitChat(page);
      await page.keyboard.press("Control+;");
      try {
        await page.locator("[data-side-exchange]").first().waitFor({ timeout: T });
      } catch {
        skip("the side question did not open");
      }
      await settle(page, 400);
    },
  },
  {
    id: "home-filtered",
    viewports: HOME_VPS,
    async run(page) {
      await page.evaluate(() => {
        window.location.hash = "#/";
      });
      try {
        await page.locator("[data-triage=working]").first().waitFor({ timeout: T });
      } catch {
        skip("Home triage did not render");
      }
      await page.locator("[data-triage=working]").first().click({ timeout: T });
      await settle(page, 800);
    },
  },
  {
    id: "acp-orchestrator",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Release notes");
      await waitChat(page);
      await settle(page, 600);
    },
  },
  {
    id: "tool-tables",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Docs site");
      await waitChat(page);
      // The newest reply's work is one "Worked for 4s" line that holds the run's groups ("Called 2 tools"): open both, then the
      // call whose result is a table (a shell or file read shows its text as it is; the demo's tables request uses two other tools).
      const worked = page.getByRole("button", { name: /^Worked for/, expanded: false }).last();
      if (await worked.count()) await worked.click({ timeout: T });
      const group = page.getByRole("button", { name: /Called 2 tools/ }).first();
      try {
        await group.waitFor({ timeout: T });
      } catch {
        skip("no tabular tool call in Docs site");
      }
      await group.click({ timeout: T });
      await page.locator("article button", { hasText: "build_timings" }).first().click({ timeout: T });
      try {
        await page.locator("[data-tool-table] table").first().waitFor({ timeout: T });
      } catch {
        skip("the tool result did not render as a table");
      }
      await settle(page, 400);
    },
  },
  {
    id: "new-project-dialog",
    viewports: [...WIDE, { width: 800, height: 600 }, { width: 640, height: 480 }, { width: 390, height: 700 }],
    async run(page) {
      const open = page.getByRole("button", { name: "Show sidebar" }).first();
      if (await open.isVisible().catch(() => false)) await open.click({ timeout: T });
      else {
        // Phone layout: the navigation opens from the header's first button (the menu).
        const menu = page.locator("[data-phone-header] button").first();
        if (await menu.isVisible().catch(() => false)) await menu.click({ timeout: T });
      }
      // On the phone "New project" is a row of the navigation sheet (the menu), and the sheet takes a moment to open: wait for it
      // (a count taken at once found none under load).
      const btn = page.getByRole("button", { name: "New project", exact: true }).filter({ visible: true }).first();
      try {
        await btn.waitFor({ state: "visible", timeout: T });
      } catch {
        skip("no New project button");
      }
      await btn.click({ timeout: T });
      try {
        await page.getByRole("dialog").first().waitFor({ timeout: T });
      } catch {
        skip("the New project dialog did not open");
      }
      await settle(page, 500);
    },
  },
  {
    id: "project-settings-models",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Docs site");
      await waitChat(page);
      await page.getByRole("button", { name: "Project actions" }).first().click({ timeout: T });
      await page.getByRole("menuitem", { name: "Project settings" }).click({ timeout: T });
      try {
        await page.getByRole("button", { name: /Models and (delegation|agents)/ }).click({ timeout: T });
      } catch {
        skip("project settings did not open");
      }
      await settle(page, 500);
    },
  },
  {
    id: "tab-context-menu",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      const tab = page.getByRole("tab").first();
      if (!(await tab.count())) skip("no tab to open a menu on");
      await tab.click({ button: "right", timeout: T });
      try {
        await page.getByRole("menu").first().waitFor({ timeout: T });
      } catch {
        skip("right click did not open a tab menu");
      }
      await settle(page, 300);
    },
  },
  {
    // Decisions 64, 78: an open pull request on the whole dock (header, meta line, file list, diff).
    id: "review-open",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await page.locator("[data-tab-plus]:visible").last().click({ timeout: T });
      try {
        await page.locator('[role=option][data-picker-row="tool:review"]').first().click({ timeout: T });
        await page.locator("[data-review-tab] [data-row]").first().click({ timeout: T });
        await page
          .getByRole("button", { name: /Submit review/ })
          .first()
          .waitFor({ timeout: T });
      } catch {
        skip("the review did not open");
      }
      await settle(page, 900);
    },
  },
  {
    // Decision 84: the picker's "Local branches" view.
    id: "review-branches",
    viewports: [...WIDE, { width: 390, height: 844 }],
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      try {
        await openTool(page, "review");
        await page.getByRole("tab", { name: "Local branches" }).first().click({ timeout: T });
        await page.locator("[data-review-tab] [data-row]").first().waitFor({ timeout: T });
      } catch {
        skip("the local branches view did not open");
      }
      await settle(page, 500);
    },
  },
  {
    // Decision 84: a dialog with fields side by side (the command form's Name and Folder).
    id: "command-dialog",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await page.getByRole("button", { name: "Settings", exact: true }).first().click({ timeout: T });
      try {
        await page.locator("[data-settings]").waitFor({ timeout: T });
        await page.getByRole("link", { name: "Commands" }).first().click({ timeout: T });
        await page.getByRole("button", { name: "Add", exact: true }).first().click({ timeout: T });
        await page.locator("[data-field-row]").first().waitFor({ timeout: T });
      } catch {
        skip("the command form did not open");
      }
      await settle(page, 400);
    },
  },
  // States built in the week of 2026-11-10 (scenario entries only; the rules are unchanged).
  {
    id: "shortcuts-sheet",
    viewports: HOME_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await page.keyboard.press("Control+k");
      try {
        await page.getByRole("dialog", { name: "Command palette" }).waitFor({ timeout: T });
      } catch {
        skip("Ctrl+K did not open the command palette");
      }
      await page.keyboard.type("Keyboard shortcuts");
      await settle(page, 400);
      await page.keyboard.press("Enter");
      try {
        await page.getByRole("dialog").first().waitFor({ timeout: T });
      } catch {
        skip("the shortcuts sheet did not open");
      }
      await settle(page, 600);
    },
  },
  {
    id: "image-preview",
    viewports: WIDE,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await clickTool(page, "Show files");
      const tree = page.getByRole("tree", { name: "Project files" }).filter({ visible: true }).first();
      // A folder's root row is open from the start (its data-path is the absolute path); only "public" needs opening.
      for (const dir of ["atlas-web/public"]) {
        const row = tree.locator(`[role="treeitem"][data-path="${dir}"]`).first();
        try {
          await row.waitFor({ timeout: T });
        } catch {
          skip(`${dir} not in the file tree`);
        }
        if ((await row.getAttribute("aria-expanded")) === "false") await row.click({ timeout: T });
        await settle(page, 300);
      }
      await tree.locator('[role="treeitem"][data-path="atlas-web/public/logo.png"]').first().click({ timeout: T });
      try {
        await page.locator("[data-image-preview] img").first().waitFor({ timeout: T });
      } catch {
        skip("the image preview did not render");
      }
      await settle(page, 400);
    },
  },
  {
    id: "tool-showcase-expanded",
    viewports: CHAT_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await waitChat(page);
      const turn = page.locator("[data-turn-key]").first();
      if (!(await turn.count())) skip("no turn in Atlas API");
      await turn.scrollIntoViewIfNeeded();
      const rows = turn.locator('[data-activity-row] [aria-expanded="false"]:not([aria-haspopup])');
      for (let i = 0; i < 12 && (await rows.count()); i++) {
        await rows.first().click({ timeout: T });
        await settle(page, 150);
      }
      if (!(await page.locator("[data-tool-body]").count())) skip("no tool call opened");
      await settle(page, 500);
    },
  },
  {
    id: "turn-changes-expanded",
    viewports: CHAT_VPS,
    async run(page, ctx) {
      await openProject(page, ctx, "Atlas API");
      await waitChat(page);
      const line = page.locator("[data-turn-changes]").first();
      if (!(await line.count())) skip("no per-turn changes line");
      await line.scrollIntoViewIfNeeded();
      await line.getByRole("button").nth(1).click({ timeout: T });
      await settle(page, 700);
    },
  },
  {
    id: "project-gone",
    viewports: HOME_VPS,
    async run(page) {
      await page.evaluate(() => {
        window.location.hash = "#/p/prj_gone";
      });
      try {
        await page
          .getByText(/no longer exists/)
          .first()
          .waitFor({ timeout: T });
      } catch {
        skip("the project-gone state did not render");
      }
      await settle(page, 400);
    },
  },
  {
    // v7 components in every state (demo-only page; the route is read at render, so the page reloads on it)
    id: "v7-gallery",
    viewports: [...WIDE, { width: 390, height: 844 }],
    async run(page) {
      await page.evaluate(() => {
        window.location.hash = "#/__v7";
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      try {
        await page.locator("[data-v7-gallery]").first().waitFor({ timeout: T });
      } catch {
        skip("the v7 gallery did not render");
      }
      await settle(page, 2500);
    },
  },
  ...PHONE_STATES(),
];

/**
 * Direction 7: the phone layout, in touch-emulating contexts (`touch: true`: `hasTouch` and `isMobile`) at three phone sizes.
 * Ids start with `phone-`; run them alone with `--only phone-home,phone-nav,...`.
 */
function PHONE_STATES() {
  const vps = [
    { width: 390, height: 844, touch: true },
    { width: 430, height: 932, touch: true },
    { width: 360, height: 640, touch: true },
  ];
  const session = async (page) => {
    await page.getByRole("button", { name: "Menu" }).first().click({ timeout: T });
    await page
      .getByRole("treeitem", { name: /Run the API tests/ })
      .first()
      .click({ timeout: T });
    try {
      await page.locator("[data-composer]").first().waitFor({ state: "visible", timeout: T });
    } catch {
      skip("the session did not open");
    }
    await settle(page, 1200);
  };
  const more = async (page) => {
    await session(page);
    await page.getByRole("button", { name: "More" }).first().click({ timeout: T });
    await settle(page, 500);
  };
  const panel = (name) => async (page) => {
    await more(page);
    await page.locator("[data-phone-more]").getByRole("button", { name, exact: true }).click({ timeout: T });
    await settle(page, 1200);
  };
  return [
    {
      id: "phone-home",
      viewports: vps,
      async run(page) {
        await page.evaluate(() => (window.location.hash = "#/"));
        await page.locator("[data-home]").first().waitFor({ timeout: T });
        await settle(page, 1500);
      },
    },
    {
      id: "phone-nav",
      viewports: vps,
      async run(page) {
        await page.getByRole("button", { name: "Menu" }).first().click({ timeout: T });
        await settle(page, 600);
      },
    },
    { id: "phone-session", viewports: vps, run: session },
    { id: "phone-more", viewports: vps, run: more },
    {
      id: "phone-plus",
      viewports: vps,
      async run(page) {
        await session(page);
        await page.getByRole("button", { name: "Attach, mention or run" }).first().click({ timeout: T });
        await settle(page, 600);
      },
    },
    { id: "phone-files", viewports: vps, run: panel("Files") },
    { id: "phone-changes", viewports: vps, run: panel("Changes") },
    {
      id: "phone-settings",
      viewports: vps,
      async run(page) {
        await page.evaluate(() => (window.location.hash = "#/settings/"));
        await page.locator("[data-settings]").first().waitFor({ timeout: T });
        await settle(page, 800);
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// In-page audit. Runs in the browser; everything it needs comes through `cfg`.
// ---------------------------------------------------------------------------------------------------------------
function auditInPage(cfg) {
  const { SCALE, ROW_HEIGHTS, TOL, ICON_GAP_MIN, allow, rules, scrollerOffsets } = cfg;
  const out = [];
  const near = (v, list) => list.some((s) => Math.abs(v - s) <= TOL);
  const r1 = (n) => Math.round(n * 100) / 100;

  // ---- helpers
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) return false; // sr-only / clipped-away helpers
    return r.width > 0 || r.height > 0;
  };
  const skipSubtree = (el) => el.closest(".monaco-editor, svg, [data-audit-ignore], vite-error-overlay") !== null || el instanceof SVGElement;
  const text = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32);
  const seg = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}|:/.test(el.id)) s += `#${el.id}`;
    const role = el.getAttribute("role");
    if (role) s += `[role=${role}]`;
    for (const a of el.getAttributeNames()) {
      if (
        a.startsWith("data-") &&
        !["data-state", "data-tab-id", "data-label", "data-dragging", "data-turn-id", "data-dock-group"].includes(a) &&
        !/^data-(radix|react)/.test(a)
      ) {
        s += `[${a}]`;
        break;
      }
    }
    const cls = [...el.classList].filter((c) => !c.includes(":") && !c.includes("[") && c.length < 24).slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    return s;
  };
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) parts.unshift(seg(n));
    return parts.join(" > ");
  };
  const allowed = (rule, el) => allow.some((a) => (a.rule === "*" || a.rule === rule) && el.matches(a.selector));
  const suppressed = {};
  const report = (rule, el, prop, measured, expected) => {
    if (allowed(rule, el)) {
      suppressed[rule] = (suppressed[rule] ?? 0) + 1;
      return;
    }
    out.push({ rule, selector: path(el), text: text(el), prop, measured, expected });
  };

  const root = document.body;
  const all = [...root.querySelectorAll("*")].filter((el) => {
    if (["SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD", "NOSCRIPT"].includes(el.tagName)) return false;
    if (skipSubtree(el)) return false;
    return visible(el);
  });

  // ---- row sets
  const SIDEBAR_ROW =
    'nav[aria-label="Projects"] li > a, nav[aria-label="Projects"] li > button, nav[aria-label="Projects"] li > div > a, nav[aria-label="Projects"] li > div > button';
  const DELEGATION_ROW = 'section[aria-label^="Delegated"] a[aria-label^="Open "], section[aria-label$="in parallel"] a[aria-label^="Open "]';
  const ROW_SEL = ['[role="tab"]', '[role="treeitem"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="option"]', "[data-row]", SIDEBAR_ROW].join(",");
  const isRow = (el) => el.matches(ROW_SEL);
  const isDelegationRow = (el) => el.matches(DELEGATION_ROW);

  // ---- 1. scale
  if (rules.includes("scale")) {
    const pxOf = (el, cs, prop) => {
      let v;
      try {
        v = el.computedStyleMap().get(prop);
      } catch {
        v = null;
      }
      if (v == null) {
        const s = cs.getPropertyValue(prop);
        return /px$/.test(s) ? parseFloat(s) : null;
      }
      if (v instanceof CSSKeywordValue) return null; // auto / normal
      if (v instanceof CSSUnitValue) return v.unit === "px" ? v.value : v.unit === "number" && v.value === 0 ? 0 : null;
      if (typeof CSSMathValue !== "undefined" && v instanceof CSSMathValue) {
        if (String(v).includes("%")) return null;
        const s = cs.getPropertyValue(prop);
        return /px$/.test(s) ? parseFloat(s) : null;
      }
      return null;
    };
    const SIDES = ["top", "right", "bottom", "left"];
    for (const el of all) {
      const cs = getComputedStyle(el);
      const check = (prop, v) => {
        if (v === null || Number.isNaN(v)) return;
        const a = Math.abs(v);
        if (a < 0.01) return;
        if (near(a, SCALE)) return;
        report("scale", el, prop, `${r1(v)}px`, SCALE.join(" "));
      };
      for (const s of SIDES) check(`padding-${s}`, pxOf(el, cs, `padding-${s}`));
      for (const s of SIDES) check(`margin-${s}`, pxOf(el, cs, `margin-${s}`));
      check("row-gap", pxOf(el, cs, "row-gap"));
      check("column-gap", pxOf(el, cs, "column-gap"));
      if (/^(absolute|fixed|sticky)$/.test(cs.position)) {
        const centred =
          (cs.translate && cs.translate !== "none") || (cs.transform && cs.transform !== "none" && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(cs.transform));
        if (!centred) {
          for (const s of SIDES) {
            if (el.style.getPropertyValue(s)) continue; // JS-positioned (popover coordinates), not authored spacing
            check(s, pxOf(el, cs, s));
          }
        }
      }
    }
  }

  // ---- 2. row-height
  if (rules.includes("row-height")) {
    for (const el of all) {
      if (!isRow(el) && !isDelegationRow(el)) continue;
      const h = el.getBoundingClientRect().height;
      if (!near(h, ROW_HEIGHTS)) report("row-height", el, "height", `${r1(h)}px`, ROW_HEIGHTS.join(" "));
    }
  }

  // ---- 3. gutter
  const measures = {};
  if (rules.includes("gutter")) {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const groups = [...document.querySelectorAll("[data-dock-group]")].filter(visible).map((g) => ({ el: g, r: g.getBoundingClientRect() }));
    if (groups.length) {
      const sidebar = document.querySelector('nav[aria-label="Projects"]');
      const sbr = sidebar && visible(sidebar) ? sidebar.getBoundingClientRect() : null;
      const named = [];
      const bar = [...document.querySelectorAll("[data-title-bar]")].find(visible);
      // Decisions 67 and 73: a group's card starts directly under the top row (its tab strip) and ends directly above the status
      // bar, so top and bottom are 0 by design; the right side and the gaps between panels carry the 8px gutter.
      const card = (g) => g.el.querySelector("[data-dock-body]")?.parentElement ?? g.el;
      const cards = groups.map((g) => ({ el: g.el, r: card(g).getBoundingClientRect() }));
      const status = [...document.querySelectorAll("[data-status-bar]")].find(visible);
      const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
      const floor = status ? status.getBoundingClientRect().top : vh;
      named.push(["top", Math.min(...cards.map((g) => g.r.top)) - barBottom, cards.reduce((a, b) => (b.r.top < a.r.top ? b : a)).el]);
      named.push(["bottom", floor - Math.max(...cards.map((g) => g.r.bottom)), cards.reduce((a, b) => (b.r.bottom > a.r.bottom ? b : a)).el]);
      named.push(["right", vw - Math.max(...groups.map((g) => g.r.right)), groups.reduce((a, b) => (b.r.right > a.r.right ? b : a)).el]);
      const sorted = [...groups].sort((a, b) => a.r.left - b.r.left);
      if (sbr && sbr.right <= sorted[0].r.left + 1) named.push(["sidebar-to-panel", sorted[0].r.left - sbr.right, sorted[0].el]);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].r.left - sorted[i - 1].r.right;
        if (gap > -1) named.push([`between-groups-${i}`, gap, sorted[i].el]);
      }
      measures.gutter = Object.fromEntries(named.map(([k, v]) => [k, r1(v)]));
      // Top and bottom are 0 by design (the strip and the status bar are the neighbours); every other gap is one gutter value.
      // Full-bleed below 640px (max-sm): no gutter on phones.
      const ref = vw < 640 ? 0 : Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--spacing-gutter")) || 8;
      for (const [name, v, el] of named) {
        const want = name === "top" || name === "bottom" ? 0 : ref;
        if (Math.abs(v - want) > TOL) report("gutter", el, name, `${r1(v)}px`, `${r1(want)}px`);
      }
    }
  }

  // ---- 4. edges (chat view only)
  if (rules.includes("edges")) {
    const header = [...document.querySelectorAll("[data-chat-header]")].find(visible);
    if (header) {
      // The conversation root: closest ancestor that also holds [data-column].
      let conv = header.parentElement;
      while (conv && !conv.querySelector("[data-column]")) conv = conv.parentElement;
      conv ??= header.parentElement;
      const pick = (sel, scope = conv) => [...scope.querySelectorAll(sel)].find(visible) ?? null;
      const items = [
        ["chat header content", pick("[data-chat-header] [data-column-edge]") ?? header],
        ["transcript column", pick("[data-column]")],
        ["user prompt box", pick("[data-prompt]")],
        ["composer", pick("[data-composer]") ?? [...conv.querySelectorAll("[data-column-edge]")].filter(visible).pop() ?? null],
      ].filter(([, e]) => e);
      const rects = items.map(([n, e]) => [n, e, e.getBoundingClientRect()]);
      measures.edges = Object.fromEntries(rects.map(([n, , r]) => [n, `${r1(r.left)}..${r1(r.right)}`]));
      const ref = rects[0];
      for (const [n, e, r] of rects.slice(1)) {
        const dl = r.left - ref[2].left;
        const dr = r.right - ref[2].right;
        if (Math.abs(dl) > TOL || Math.abs(dr) > TOL)
          report(
            "edges",
            e,
            `${n} vs ${ref[0]}`,
            `left ${r1(r.left)} right ${r1(r.right)} (d ${r1(dl)} / ${r1(dr)})`,
            `left ${r1(ref[2].left)} right ${r1(ref[2].right)} (±${TOL})`,
          );
      }
    }
  }

  // ---- 5. icon-gap
  if (rules.includes("icon-gap")) {
    for (const el of all) {
      if (!isRow(el) && !isDelegationRow(el)) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let icon = null;
      let iconRect = null;
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const e = n;
          if (!visible(e)) continue;
          const r = e.getBoundingClientRect();
          const small = r.width <= 16 && r.height <= 16;
          const glyph = e instanceof SVGSVGElement || (small && !(e.textContent ?? "").trim() && e !== el);
          if (!icon && glyph && r.width > 0) {
            icon = e;
            iconRect = r;
          }
        } else if (n.textContent.trim()) {
          const pe = n.parentElement;
          if (!pe || !visible(pe) || pe.closest("svg")) continue;
          if (!icon) break; // text comes first: no leading icon
          if (icon.contains(n)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const tr = [...range.getClientRects()].find((r) => r.width > 0);
          if (!tr) continue;
          if (tr.left < iconRect.right - TOL) continue; // wrapped / not to the right
          const verticallyAligned = tr.top < iconRect.bottom && tr.bottom > iconRect.top;
          if (!verticallyAligned) continue;
          const gap = tr.left - iconRect.right;
          if (gap < ICON_GAP_MIN - TOL) report("icon-gap", el, "icon->text gap", `${r1(gap)}px`, `>= ${ICON_GAP_MIN}px`);
          break;
        }
      }
    }
  }

  // ---- 6. overlap
  if (rules.includes("overlap")) {
    const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const clip = (r, c) => {
      const left = Math.max(r.left, c.left);
      const right = Math.min(r.right, c.right);
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, c.bottom);
      return right > left && bottom > top ? { left, right, top, bottom } : null;
    };
    const textRects = (scope, within) => {
      const res = [];
      const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (!n.textContent.trim()) continue;
        const pe = n.parentElement;
        if (!pe || !visible(pe) || pe.closest("svg, script, style")) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          const c = within ? clip(r, within) : r.width > 0 && r.height > 0 ? r : null;
          if (c) res.push({ rect: c, node: pe, snippet: n.textContent.trim().slice(0, 28) });
        }
      }
      return res;
    };
    const header = [...document.querySelectorAll("[data-chat-header]")].find(visible);
    const column = [...document.querySelectorAll("[data-column]")].find(visible);
    const scroller = column ? column.closest(".overflow-y-auto, [class*='overflow-y']") : null;
    measures.overlap = {};
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const texts = textRects(scroller, sr);
      if (header) {
        const hr = header.getBoundingClientRect();
        measures.overlap.header = `${r1(hr.top)}..${r1(hr.bottom)}`;
        measures.overlap.scrollerTop = r1(sr.top);
        const first = texts.map((t) => t.rect.top).sort((a, b) => a - b)[0];
        if (first !== undefined) measures.overlap.firstTextTop = r1(first);
        for (const t of texts) {
          if (hit(hr, t.rect))
            report(
              "overlap",
              t.node,
              "chat header vs transcript text",
              `text "${t.snippet}" ${r1(t.rect.top)}..${r1(t.rect.bottom)}`,
              `no intersection with header ${r1(hr.top)}..${r1(hr.bottom)}`,
            );
        }
        // The header must also sit above the scroll area.
        if (hr.bottom > sr.top + TOL)
          report(
            "overlap",
            header,
            "chat header vs transcript area",
            `header bottom ${r1(hr.bottom)} > transcript top ${r1(sr.top)}`,
            "header ends where the transcript starts",
          );
      }
      const jump = [...document.querySelectorAll('button[aria-label="Jump to latest"]')].find(visible);
      if (jump) {
        const jr = jump.getBoundingClientRect();
        measures.overlap.jump = "present";
        for (const t of texts) {
          if (jump.contains(t.node)) continue;
          if (hit(jr, t.rect))
            report(
              "overlap",
              t.node,
              "Jump to latest vs transcript text",
              `text "${t.snippet}" ${r1(t.rect.left)},${r1(t.rect.top)}`,
              `no intersection with button ${r1(jr.left)},${r1(jr.top)} ${r1(jr.width)}x${r1(jr.height)}`,
            );
        }
      } else measures.overlap.jump = "absent";
    }
    const floating = [...document.querySelectorAll('[data-floating-composer], [aria-label="Floating composer"]')].find(visible);
    if (floating) {
      const fr = floating.getBoundingClientRect();
      for (const vl of document.querySelectorAll(".monaco-editor .view-lines")) {
        if (!visible(vl)) continue;
        for (const t of textRects(vl, null)) {
          if (floating.contains(t.node)) continue;
          if (hit(fr, t.rect)) report("overlap", floating, "floating composer vs editor text", `text "${t.snippet}"`, "no intersection");
        }
      }
      measures.overlap.floating = "present";
    }
  }

  // ---- 7. inset-balance
  if (rules.includes("inset-balance")) {
    for (const el of all) {
      if (!(isRow(el) || isDelegationRow(el) || el.tagName === "BUTTON")) continue;
      const cs = getComputedStyle(el);
      const pl = parseFloat(cs.paddingLeft);
      const pr = parseFloat(cs.paddingRight);
      if (!(pl > 0 || pr > 0)) continue;
      const transparent = (c) => !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
      const hasBg = !transparent(cs.backgroundColor) || cs.backgroundImage !== "none";
      const hasBorder = ["Top", "Right", "Bottom", "Left"].some(
        (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none" && !transparent(cs[`border${s}Color`]),
      );
      if (!hasBg && !hasBorder) continue;
      const diff = Math.abs(pl - pr);
      const hasIcon =
        [...el.querySelectorAll("svg, [data-meta]")].some(visible) ||
        [...el.children].some(
          (c) => visible(c) && c.getBoundingClientRect().width <= 16 && c.getBoundingClientRect().height <= 16 && !(c.textContent ?? "").trim(),
        );
      const allowedDiff = hasIcon ? 4 : TOL;
      if (diff > allowedDiff + 1e-6)
        report("inset-balance", el, "padding-left vs padding-right", `${r1(pl)} / ${r1(pr)}`, hasIcon ? "equal, or differ by <= 4 with an icon slot" : "equal");
    }
  }

  // ---- 8. dialog-bounds (decision 51): nothing inside a dialog's body reaches past the body's padding box, so a field
  // can never run over the dialog's edge. Content that scrolls on its own (an overflow-x container) is exempt.
  if (rules.includes("dialog-bounds")) {
    const scrollsX = (el, stop) => {
      for (let n = el.parentElement; n && n !== stop; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
      }
      return false;
    };
    for (const body of document.querySelectorAll("[data-dialog-body]")) {
      if (!visible(body)) continue;
      const br = body.getBoundingClientRect();
      const bcs = getComputedStyle(body);
      const left = br.left + parseFloat(bcs.paddingLeft);
      const right = br.right - parseFloat(bcs.paddingRight);
      measures.dialogBounds = { ...(measures.dialogBounds ?? {}), content: `${r1(left)}..${r1(right)}` };
      for (const el of all) {
        if (!body.contains(el) || el === body || scrollsX(el, body)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        // A ghost button with a negative margin bleeds its hover surface into the padding on purpose (text stays aligned).
        const ecs = getComputedStyle(el);
        const bleedL = parseFloat(ecs.marginLeft) < 0;
        const bleedR = parseFloat(ecs.marginRight) < 0;
        if (r.right > right + TOL && !bleedR) report("dialog-bounds", el, "right edge past the dialog's padding", `${r1(r.right)}px`, `<= ${r1(right)}px`);
        else if (r.left < left - TOL && !bleedL) report("dialog-bounds", el, "left edge before the dialog's padding", `${r1(r.left)}px`, `>= ${r1(left)}px`);
      }
    }
  }

  // ---- 9. field-row (decision 84): the controls of one FieldRow share a top (and a height), whatever labels and hints are around them.
  if (rules.includes("field-row")) {
    for (const row of document.querySelectorAll("[data-field-row]")) {
      if (!visible(row)) continue;
      const controls = [...row.querySelectorAll("[data-field-control]")].filter(visible);
      const first = controls[0];
      if (!first) continue;
      const top = first.getBoundingClientRect().top;
      const height = first.getBoundingClientRect().height;
      // Stacked below `sm` the controls are on different lines on purpose: only a row that is still a row is compared.
      const sameLine = controls.every((c) => Math.abs(c.getBoundingClientRect().top - top) < height);
      if (!sameLine) continue;
      for (const c of controls.slice(1)) {
        const r = c.getBoundingClientRect();
        if (Math.abs(r.top - top) > TOL) report("field-row", c, "top of a control in a field row", `${r1(r.top)}px`, `${r1(top)}px`);
        if (Math.abs(r.height - height) > TOL) report("field-row", c, "height of a control in a field row", `${r1(r.height)}px`, `${r1(height)}px`);
      }
    }
  }

  // ---- 10. key-hint (decision 92): a keyboard shortcut is never a boxed letter inside a control. It goes into the control's tooltip
  // ("Allow once (A)"); a menu item shows it right-aligned and dim (the `Menu` shortcut column).
  if (rules.includes("key-hint")) {
    for (const k of document.querySelectorAll("[data-key-hint], kbd.octo-keyhint, kbd.octo-v7-kbd")) {
      if (!visible(k)) continue;
      const host = k.closest("button, label");
      if (host) report("key-hint", k, "boxed key hint inside a button or label", `inside <${host.tagName.toLowerCase()}>`, "none (use the tooltip)");
    }
  }

  return { violations: out, suppressed, measures, scanned: all.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test fixtures, injected into the live page.
// ---------------------------------------------------------------------------------------------------------------
function injectBad() {
  const host = document.createElement("div");
  host.id = "audit-selftest";
  host.style.cssText = "position:fixed;left:40px;bottom:140px;z-index:99999;background:#222;color:#fff;font:14px sans-serif;padding:7px;";
  host.innerHTML = `
    <div>padding 7px host</div>
    <div role="menuitem" style="height:30px;display:flex;align-items:center">30px menuitem</div>
    <div role="menuitem" style="height:28px;display:flex;align-items:center;gap:2px">
      <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6"/></svg><span>icon gap 2px</span></div>
    <button style="background:#444;color:#fff;border:0;padding:4px 16px 4px 4px;height:28px">unbalanced inset</button>
    <div style="display:flex;gap:10px;margin-left:5px"><span>gap</span><span>10px</span></div>`;
  document.body.appendChild(host);
  const dlg = document.querySelector("[data-dialog-body] form, [data-dialog-body]");
  if (dlg) {
    const wide = document.createElement("div");
    wide.style.cssText = "width:2000px;height:8px;position:relative";
    dlg.appendChild(wide);
  }
  const p = document.querySelector("[data-prompt]");
  if (p) {
    p.style.position = "relative";
    p.style.left = "3px";
  }
  const jump = document.querySelector('button[aria-label="Jump to latest"]');
  if (jump) {
    const r = jump.getBoundingClientRect();
    const t = document.createElement("span");
    t.textContent = "text under jump";
    t.style.cssText = `position:fixed;left:${r.left + 2}px;top:${r.top + 8}px;font:12px sans-serif;color:#fff;z-index:1`;
    const sc = document.querySelector("[data-column]")?.closest(".overflow-y-auto");
    (sc ?? document.body).appendChild(t);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------------
async function main() {
  if (flag("--list")) {
    for (const st of STATES) console.log(`${st.id.padEnd(18)} ${st.viewports.map((v) => `${v.width}x${v.height}`).join(" ")}`);
    return;
  }
  const browser = await launchBrowser();
  const report = { base: BASE, strict: STRICT, selftest: SELFTEST, allowList: ALLOW, results: [], totals: {}, skipped: [] };
  const rulesFor = (state, vp) => {
    const chatish = ["chat-idle", "chat-running", "delegation"].includes(state.id);
    return RULES.filter((r) => (r === "edges" ? chatish : true));
  };

  let hrefs = {};
  async function probe() {
    const ctx = await newContext(browser, { viewport: WIDE[0] });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("octo.theme", "dark");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?${QUERY}`, { waitUntil: "domcontentloaded" });
    try {
      await page.locator('nav[aria-label="Projects"] a').first().waitFor({ timeout: 8000 });
    } catch {
      await ctx.close();
      throw new Error(`UI not reachable or no sidebar projects at ${BASE}/?${QUERY}`);
    }
    hrefs = await page.evaluate(() => {
      const m = {};
      for (const a of document.querySelectorAll('nav[aria-label="Projects"] a[href^="#/p/"]')) {
        const label = a.getAttribute("title") || a.textContent.trim();
        if (!(label in m)) m[label] = a.getAttribute("href");
      }
      return m;
    });
    await ctx.close();
  }
  await probe();

  const only = ONLY ? new Set(ONLY.split(",")) : null;
  const states = STATES.filter((s) => !only || only.has(s.id));
  if (!states.length) {
    console.error(`No state "${ONLY}". Known: ${STATES.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }

  for (const state of states) {
    for (const vp of state.viewports) {
      const entry = {
        state: state.id,
        viewport: `${vp.width}x${vp.height}`,
        status: "ok",
        reason: null,
        counts: {},
        violations: [],
        suppressed: {},
        measures: {},
        scanned: 0,
      };
      const ctx = await newContext(browser, { viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch === true, isMobile: vp.touch === true });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("octo.theme", "dark");
        } catch {}
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => isAbortedImport(e.message) || errors.push(String(e).slice(0, 160)));
      try {
        await page.goto(`${BASE}/?${QUERY}`, { waitUntil: "domcontentloaded" });
        await page.locator("[data-dock-group], nav[aria-label='Projects']").first().waitFor({ timeout: 8000 });
        await settle(page, 400);
        await state.run(page, { hrefs });

        const rules = rulesFor(state, vp);
        const merged = { violations: [], suppressed: {}, measures: {}, scanned: 0 };
        // Overlap needs scrolled transcripts: audit once per scroll position, other rules only once.
        const passes = [];
        const hasScroller = await page.evaluate(() => !!document.querySelector("[data-column]"));
        passes.push({ rules: rules.filter((r) => r !== "overlap"), scroll: null });
        if (rules.includes("overlap")) {
          if (hasScroller) {
            passes.push({ rules: ["overlap"], scroll: 200 });
            passes.push({ rules: ["overlap"], scroll: 0 });
          } else passes.push({ rules: ["overlap"], scroll: null });
        }
        for (const pass of passes) {
          if (pass.scroll !== null) {
            await page.evaluate((top) => {
              const sc = document.querySelector("[data-column]")?.closest(".overflow-y-auto");
              if (sc) sc.scrollTop = top;
            }, pass.scroll);
            await settle(page, 350);
          }
          if (SELFTEST && pass === passes[0]) await page.evaluate(injectBad);
          if (SELFTEST && pass.rules.includes("overlap")) {
            // the jump-button fixture is placed once the button exists
            await page.evaluate(() => {
              if (document.querySelector("[data-selftest-jump]")) return;
              const jump = document.querySelector('button[aria-label="Jump to latest"]');
              if (!jump) return;
              const r = jump.getBoundingClientRect();
              const t = document.createElement("span");
              t.setAttribute("data-selftest-jump", "1");
              t.textContent = "text under jump";
              t.style.cssText = `position:fixed;left:${r.left + 2}px;top:${r.top + 8}px;font:12px sans-serif;color:#fff;z-index:1`;
              (document.querySelector("[data-column]")?.closest(".overflow-y-auto") ?? document.body).appendChild(t);
            });
          }
          // A window under 480px is the phone layout whether or not it is a touch context (`lib/phone.ts`).
          const rows = vp.touch || vp.width < 480 ? PHONE_ROW_HEIGHTS : ROW_HEIGHTS;
          const res = await page.evaluate(auditInPage, { SCALE, ROW_HEIGHTS: rows, TOL, ICON_GAP_MIN, allow: ALLOW, rules: pass.rules });
          merged.violations.push(...res.violations);
          for (const [k, v] of Object.entries(res.suppressed)) merged.suppressed[k] = (merged.suppressed[k] ?? 0) + v;
          Object.assign(merged.measures, res.measures);
          merged.scanned = Math.max(merged.scanned, res.scanned);
        }
        if (state.extra) merged.violations.push(...(await state.extra(page)));

        // dedupe: same rule + selector + prop + measured value
        const byKey = new Map();
        for (const v of merged.violations) {
          const key = [v.rule, v.selector, v.prop, v.measured.replace(/text ".*?" /, "")].join("|");
          const e = byKey.get(key);
          if (e) e.count++;
          else byKey.set(key, { ...v, count: 1 });
        }
        entry.violations = [...byKey.values()].map((v) => ({ ...v, state: state.id, viewport: entry.viewport }));
        entry.suppressed = merged.suppressed;
        entry.measures = merged.measures;
        entry.scanned = merged.scanned;
        for (const r of RULES) entry.counts[r] = entry.violations.filter((v) => v.rule === r).reduce((a, v) => a + v.count, 0);
        if (errors.length) entry.pageErrors = errors.slice(0, 5);
      } catch (e) {
        if (e instanceof Skip) {
          entry.status = "skipped";
          entry.reason = e.message;
        } else {
          entry.status = "skipped";
          entry.reason = `error: ${String(e.message ?? e)
            .split("\n")[0]
            .slice(0, 200)}`;
        }
      }
      await ctx.close();
      report.results.push(entry);
      printEntry(entry);
    }
  }
  await browser.close();

  const all = report.results.flatMap((r) => r.violations);
  for (const r of RULES) report.totals[r] = all.filter((v) => v.rule === r).reduce((a, v) => a + v.count, 0);
  report.totals.all = Object.values(report.totals).reduce((a, b) => a + b, 0);
  report.skipped = report.results.filter((r) => r.status === "skipped").map((r) => ({ state: r.state, viewport: r.viewport, reason: r.reason }));
  report.violations = all;

  console.log("\n== Allow-list ==");
  if (!ALLOW.length) console.log("  (empty)");
  for (const a of ALLOW) console.log(`  [${a.rule}] ${a.selector} — ${a.reason}`);
  const sup = {};
  for (const r of report.results) for (const [k, v] of Object.entries(r.suppressed)) sup[k] = (sup[k] ?? 0) + v;
  if (Object.keys(sup).length) console.log("  suppressed by allow-list:", JSON.stringify(sup));

  if (report.skipped.length) {
    console.log("\n== Skipped ==");
    for (const s of report.skipped) console.log(`  ${s.state} @ ${s.viewport}: ${s.reason}`);
  }
  console.log("\n== Totals ==");
  console.log("  " + RULES.map((r) => `${r}=${report.totals[r]}`).join("  ") + `  | total=${report.totals.all}  skipped=${report.skipped.length}`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`  report written to ${JSON_OUT}`);
  }
  const fail = report.totals.all > 0 || (STRICT && report.skipped.length > 0);
  process.exit(fail ? 1 : 0);
}

function printEntry(e) {
  const head = `[${e.state} @ ${e.viewport}]`;
  if (e.status === "skipped") {
    console.log(`${head} SKIPPED: ${e.reason}`);
    return;
  }
  const total = Object.values(e.counts).reduce((a, b) => a + b, 0);
  console.log(`${head} ${RULES.map((r) => `${r}=${e.counts[r]}`).join(" ")} | total=${total} (scanned ${e.scanned} elements)`);
  if (e.measures.gutter) console.log(`    gutter px: ${JSON.stringify(e.measures.gutter)}`);
  if (e.measures.edges) console.log(`    edges x:   ${JSON.stringify(e.measures.edges)}`);
  if (e.measures.overlap && Object.keys(e.measures.overlap).length) console.log(`    overlap:   ${JSON.stringify(e.measures.overlap)}`);
  const show = e.violations.slice(0, flag("--verbose") ? 1e9 : 6);
  for (const v of show) {
    const sel = flag("--verbose") ? v.selector : v.selector.split(" > ").slice(-2).join(" > ");
    console.log(`    - ${v.rule}${v.count > 1 ? ` x${v.count}` : ""} ${sel}${v.text ? ` "${v.text}"` : ""} ${v.prop}: ${v.measured} (expected ${v.expected})`);
  }
  if (e.violations.length > show.length) console.log(`    … ${e.violations.length - show.length} more distinct violations (use --verbose or --json)`);
  if (e.pageErrors) console.log(`    page errors: ${e.pageErrors.join(" | ")}`);
}

main().catch((e) => {
  console.error(e.stack ?? e);
  process.exit(2);
});
