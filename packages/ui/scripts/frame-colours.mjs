#!/usr/bin/env node
/**
 * Frame-colour audit (contract: docs/superpowers/specs/2026-11-10-project-harness-ui.md, decision 81).
 *
 * A card that waits for the person has the neutral border of any card. In the demo states below (an approval, a form, a plan, a
 * queue, a failed turn, the review screens) no visible element may have a border, outline or ring whose colour is the warn, danger or accent token,
 * unless it has keyboard focus or is marked invalid. Exit code 1 when one does.
 *
 *   node packages/ui/scripts/frame-colours.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--selftest]
 */
import { launchBrowser, newContext } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const SELFTEST = argv.includes("--selftest");

/** Runs in the page: the offending elements. */
function scan() {
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgb = (css) => {
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : [r, g, b];
  };
  const token = (name) => {
    const el = document.createElement("span");
    el.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    document.body.append(el);
    const c = rgb(getComputedStyle(el).color);
    el.remove();
    return c;
  };
  const tokens = ["--octo-warn", "--octo-err", "--octo-accent"].map((n) => ({ n, c: token(n) })).filter((t) => t.c);
  const near = (c) => {
    const hit = c && tokens.find((t) => Math.abs(t.c[0] - c[0]) + Math.abs(t.c[1] - c[1]) + Math.abs(t.c[2] - c[2]) < 24);
    return hit?.n ?? null;
  };
  const found = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.matches(":focus, :focus-within, :focus-visible, [aria-invalid='true'], [data-invalid]")) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const where = (kind, n) =>
      found.push({ kind, token: n, el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].slice(0, 3).join(".")}` });
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      if (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none") {
        const n = near(rgb(s[`border${side}Color`]));
        if (n) {
          where("border", n);
          break;
        }
      }
    }
    if (parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== "none") {
      const n = near(rgb(s.outlineColor));
      if (n) where("outline", n);
    }
    // A ring is a spread box-shadow with no blur: `0 0 0 Npx colour`.
    for (const m of s.boxShadow.matchAll(/(rgba?\([^)]*\)|color\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px/g)) {
      const n = near(rgb(m[1]));
      if (n && parseFloat(m[2]) > 0) where("ring", n);
    }
  }
  return found;
}

const browser = await launchBrowser();
let bad = 0;

async function check(label, page) {
  const found = await page.evaluate(scan);
  console.log(`${label.padEnd(28)} ${found.length === 0 ? "ok" : `${found.length} coloured frame(s)`}`);
  for (const f of found) console.log(`  ${f.kind} ${f.token}  ${f.el}`);
  bad += found.length;
}

async function fresh(scheme) {
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=1`);
  await page.waitForTimeout(700);
  return page;
}
const open = async (page, name) => {
  await page.getByText(name, { exact: false }).first().click();
  await page.waitForTimeout(600);
};

if (SELFTEST) {
  const page = await fresh("dark");
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.cssText = "width:50px;height:50px;border:1px solid var(--octo-warn)";
    document.body.append(d);
  });
  const found = await page.evaluate(scan);
  console.log(found.length > 0 ? "frame-colours selftest: ok (a warn border is found)" : "frame-colours selftest: FAILED (a warn border was not found)");
  await browser.close();
  process.exit(found.length > 0 ? 0 : 1);
}

for (const scheme of ["dark", "light"]) {
  const page = await fresh(scheme);
  // The seeded approval, form and queue.
  await open(page, "Atlas API");
  await check(`${scheme}: approval, form, queue`, page);
  // The approvals a message raises (edit with patch, web fetch, command) and the always-allow panel.
  await open(page, "Docs site");
  const box = page.locator("#octo-composer");
  await box.fill("approvals demo please");
  await page.keyboard.press("Enter");
  // Three requests at once are one group (decision 91c); its rows fold the details, so open them.
  await page.waitForSelector("[data-v7-approval-group]", { timeout: 20000 });
  for (const b of await page.locator("[data-v7-approval-group]").getByRole("button", { name: "Details" }).all()) await b.click();
  await page.waitForSelector("[data-network]", { timeout: 20000 });
  await page.waitForTimeout(500);
  await page
    .locator("[data-v7-approval]")
    .last()
    .getByRole("button", { name: /^Always allow/ })
    .click();
  await check(`${scheme}: approvals, rule panel`, page);
  // A failed turn.
  await open(page, "Changelog bot");
  await check(`${scheme}: failed turn`, page);
  await page.context().close();
}
// A plan card (Plan mode, then the scripted turn ends with a plan).
{
  const page = await fresh("dark");
  await open(page, "Release notes");
  const box = page.locator("#octo-composer");
  await box.click();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await box.fill("plan the release checklist");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-plan=pending]", { timeout: 40000 });
  await check("dark: plan card", page);
}
// The review screens: the picker, an open pull request with its file list, and the submit sheet.
for (const scheme of ["dark", "light"]) {
  const page = await fresh(scheme);
  await open(page, "Atlas API");
  await page
    .getByRole("button", { name: /^Review/ })
    .first()
    .click();
  await page.getByText("Retry transient 5xx").first().waitFor({ timeout: 20000 });
  await check(`${scheme}: review picker`, page);
  await page.getByText("Retry transient 5xx").first().click();
  await page.getByRole("button", { name: "Submit review" }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await check(`${scheme}: review open`, page);
  // The button can sit past the edge of the narrow pane at 1440 wide; click it by script.
  await page
    .getByRole("button", { name: "Submit review" })
    .first()
    .evaluate((e) => e.click());
  await page.waitForTimeout(1200);
  await check(`${scheme}: review submit sheet`, page);
  await page.context().close();
}
await browser.close();
console.log(bad === 0 ? "frame-colours: ok" : `frame-colours: ${bad} coloured frame(s)`);
process.exit(bad === 0 ? 0 : 1);
