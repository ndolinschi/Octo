#!/usr/bin/env node
/**
 * Schema forms on the demo (spec 2026-11-15, criteria 10–13): each demo form opens, shows its errors, takes values and
 * collapses to its answered line without the password; Enter / Ctrl+Enter; the first invalid field takes focus with
 * aria-invalid and the count is announced; the service's 400 `error.fields` lands under the field; at 390 px every field's
 * text is 16 px and every control's touch zone is at least 44 px; axe-core finds nothing on an open card.
 *
 *   node packages/ui/scripts/schema-forms.mjs [--url http://localhost:1420] [--browser chromium|webkit]
 *
 * Prints "schema-forms: ok" or the failures (exit 1).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newContext, PHONE } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const axeDir = readdirSync(path.join(ROOT, "node_modules/.pnpm")).find((d) => d.startsWith("axe-core@"));
const AXE = axeDir ? path.join(ROOT, "node_modules/.pnpm", axeDir, "node_modules/axe-core/axe.min.js") : null;
const PASSWORD = "correct-horse-42";

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
};

/** The Atlas API route, read once on a desktop page (the phone layout has no sidebar link to click). */
let atlasHash = "";

async function openAtlas(page, q) {
  await page.goto(`${BASE}/?demo=1&forms=${q}${atlasHash}`);
  await page.waitForTimeout(1200);
  if (atlasHash) return;
  const item = page.locator("a", { hasText: "Atlas API" }).first();
  if (!(await item.isVisible().catch(() => false))) {
    const b = page.getByRole("button", { name: /^(Show|Open) sidebar$|^Menu$/ }).first();
    if (await b.isVisible().catch(() => false)) await b.click();
    await page.waitForTimeout(300);
  }
  await item.click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  atlasHash = new URL(page.url()).hash;
}

const card = (page, title) => page.locator("[data-v7-form]", { hasText: title }).first();
const resolved = (page, title) => page.locator("[data-v7-form][data-resolved]", { hasText: title }).first();

async function axe(page, selector, label) {
  if (!AXE) return check(false, "axe-core not found in node_modules/.pnpm");
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE });
  const found = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel, { resultTypes: ["violations"] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  }, selector);
  check(found.length === 0, `${label}: axe ${found.join(" | ")}`);
}

const browser = await launchBrowser();
const consoleLines = [];
const watch = (page) => {
  page.on("console", (m) => {
    consoleLines.push(m.text());
    if (m.type() === "error") failures.push(`console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => failures.push(`page error: ${e}`));
};

/* ---------- desktop: every form ---------- */
{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 1600 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  watch(page);
  await openAtlas(page, "1");

  // Sign in: errors, focus, aria, announcement, Enter submits, the 400 under its field, then the answered line.
  const signin = card(page, "Sign in to staging");
  await signin.scrollIntoViewIfNeeded();
  await axe(page, `[data-v7-form="${await signin.getAttribute("data-v7-form")}"]`, "sign in (open)");
  const email = signin.getByLabel("Email");
  const password = signin.getByLabel("Password", { exact: true });
  check((await email.getAttribute("aria-required")) === "true", "sign in: email aria-required");
  await email.fill("not-an-email");
  await signin.getByRole("button", { name: "Submit" }).click();
  await page.waitForTimeout(300);
  check((await email.getAttribute("aria-invalid")) === "true", "sign in: email aria-invalid after a failed submit");
  check((await password.getAttribute("aria-invalid")) === "true", "sign in: password aria-invalid");
  check(await email.evaluate((el) => el === document.activeElement), "sign in: the first invalid field takes focus");
  check((await signin.locator("[aria-live]").textContent())?.trim() === "2 fields need attention", "sign in: announces 2 fields need attention");
  const described = (await email.getAttribute("aria-describedby")) ?? "";
  check(
    described && (await page.locator(`#${described.split(" ").at(-1)}`).textContent())?.includes("name@example.com"),
    "sign in: the error describes the field",
  );
  await axe(page, `[data-v7-form="${await signin.getAttribute("data-v7-form")}"]`, "sign in (errors)");
  // The service refuses this address with error.fields.
  await email.fill("taken@example.com");
  await password.fill(PASSWORD);
  await password.press("Enter");
  await page.waitForTimeout(500);
  check((await signin.textContent()).includes("already signed in elsewhere"), "sign in: the 400 error.fields message shows under the field");
  check((await email.getAttribute("aria-invalid")) === "true", "sign in: the refused field is marked invalid");
  // Show / hide, then Enter submits a one-line form.
  await signin.getByRole("button", { name: "Show" }).click();
  check((await password.getAttribute("type")) === "text", "sign in: Show reveals the password");
  await signin.getByRole("button", { name: "Hide" }).click();
  await email.fill("tester@example.com");
  await password.fill(PASSWORD);
  await email.press("Enter");
  await resolved(page, "Sign in to staging").waitFor({ timeout: 4000 });
  const line = await resolved(page, "Sign in to staging").textContent();
  check(line.includes("Answered · Email: tester@example.com · Password: •••"), `sign in: answered line (${line})`);
  check(!(await page.content()).includes(PASSWORD), "sign in: the password is not in the DOM after the answer");
  check(!consoleLines.some((l) => l.includes(PASSWORD)), "sign in: the password is not in the console");

  // Region: the 6-choice Select and the 3-choice segments with a default.
  const region = card(page, "Choose a region");
  await region.scrollIntoViewIfNeeded();
  check((await region.getByRole("combobox").count()) === 1, "region: six choices are a Select");
  check((await region.getByRole("radiogroup").count()) === 1, "region: three choices are segments");
  await region.getByRole("button", { name: "Submit" }).click();
  await page.waitForTimeout(200);
  check((await region.textContent()).includes("Choose one"), "region: Choose one under the empty Select");
  await region.getByRole("combobox").click();
  await page.getByRole("option", { name: "Europe (Ireland)" }).click();
  await region.getByRole("radio", { name: "Production" }).click();
  await region.getByRole("button", { name: "Submit" }).click();
  await resolved(page, "Choose a region").waitFor({ timeout: 4000 });
  check(
    (await resolved(page, "Choose a region").textContent()).includes("Region: Europe (Ireland) · Environment: Production"),
    "region: answered line uses titles",
  );

  // Rollout: Enter in the multi-line field adds a line, Ctrl+Enter submits; the conditional field appears with the canary.
  const rollout = card(page, "Rollout settings");
  await rollout.scrollIntoViewIfNeeded();
  check((await rollout.getByLabel("Canary traffic (%)").count()) === 0, "rollout: the conditional field is hidden at first");
  await rollout.getByText("Use a canary").click();
  check((await rollout.getByLabel("Canary traffic (%)").count()) === 1, "rollout: the conditional field shows with the canary");
  const replicas = rollout.getByLabel("Replicas");
  await replicas.fill("12");
  await replicas.blur();
  await page.waitForTimeout(150);
  check((await rollout.textContent()).includes("Enter a number from 1 to 10"), "rollout: range error on blur");
  await replicas.fill("3");
  check(!(await rollout.textContent()).includes("Enter a number from 1 to 10"), "rollout: the error follows the fixed value");
  await rollout.getByLabel("Deploy window starts").fill("2026-11-20T09:30");
  const notes = rollout.getByLabel("Release notes");
  await notes.fill("First change");
  await notes.press("End");
  await notes.press("Enter");
  await page.waitForTimeout(200);
  check(
    (await page.locator("[data-v7-form][data-resolved]", { hasText: "Rollout settings" }).count()) === 0,
    "rollout: Enter in a multi-line field does not submit",
  );
  check((await notes.inputValue()).includes("\n"), "rollout: Enter adds a line");
  await notes.press("Control+Enter");
  await resolved(page, "Rollout settings").waitFor({ timeout: 4000 });
  const rolled = await resolved(page, "Rollout settings").textContent();
  check(
    rolled.includes("Replicas: 3") && rolled.includes("Deploy window starts: 2026-11-20 09:30") && rolled.includes("Canary traffic (%): 5"),
    `rollout: answered line (${rolled})`,
  );

  // Checks: many-of with a default; at least one; a custom submit label.
  const checks = card(page, "Release checks");
  await checks.scrollIntoViewIfNeeded();
  for (const name of ["Unit tests", "Lint"]) await checks.getByText(name, { exact: true }).click();
  await checks.getByRole("button", { name: "Run checks" }).click();
  await page.waitForTimeout(200);
  check((await checks.textContent()).includes("Choose at least 1"), "checks: Choose at least 1");
  await checks.getByText("End-to-end", { exact: true }).click();
  await checks.getByRole("button", { name: "Run checks" }).click();
  await resolved(page, "Release checks").waitFor({ timeout: 4000 });
  check((await resolved(page, "Release checks").textContent()).includes("Checks: End-to-end"), "checks: answered line");

  // The legacy fields form: skip shows Skipped.
  const legacy = card(page, "Deploy settings");
  await legacy.scrollIntoViewIfNeeded();
  await legacy.getByRole("button", { name: "Skip" }).click();
  await resolved(page, "Deploy settings").waitFor({ timeout: 4000 });
  check((await resolved(page, "Deploy settings").textContent()).includes("Skipped"), "legacy: Skipped");
  await ctx.close();
}

/* ---------- phone: 16 px text, 44 px touch zones ---------- */
{
  const ctx = await newContext(browser, { ...PHONE, colorScheme: "light" });
  const page = await ctx.newPage();
  watch(page);
  await openAtlas(page, "signin,rollout");
  for (const title of ["Sign in to staging", "Rollout settings", "Deploy settings"]) {
    const c = card(page, title);
    await c.scrollIntoViewIfNeeded();
    const bad = await c.evaluate((root) => {
      const out = [];
      for (const el of root.querySelectorAll("input:not([type=checkbox]), textarea, [role=combobox]")) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        const h = el.getBoundingClientRect().height;
        if (fs < 16) out.push(`${el.id || el.tagName} text ${fs}px`);
        if (el.tagName !== "TEXTAREA" && h < 44) out.push(`${el.id || el.tagName} ${h}px tall`);
      }
      // Buttons, segments and checkboxes: the visible box or its touch zone (::after of touch-hit) reaches 44.
      for (const el of root.querySelectorAll("button, [role=radio], label:has(input[type=checkbox])")) {
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, "::after");
        const zone =
          after.content !== "none" && after.position === "absolute"
            ? Math.max(r.height, parseFloat(after.height) || 0, parseFloat(after.minHeight) || 0)
            : r.height;
        if (zone < 44) out.push(`${el.textContent?.trim().slice(0, 20) || el.getAttribute("aria-label")} zone ${zone}px`);
      }
      return out;
    });
    check(bad.length === 0, `phone ${title}: ${bad.join(", ")}`);
  }
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.log(`schema-forms: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("schema-forms: ok");
