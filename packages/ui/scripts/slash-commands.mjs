#!/usr/bin/env node
/**
 * Every Octo slash command, driven in the composer of the demo (`?demo=1`, project "Atlas API"): typed in full + Enter, typed
 * with an argument + Enter, chosen from the "/" menu (arrows + Enter and a click), and its RESULT checked: /new an empty session
 * (and `/new text` a started one), /compact a note, /clear a new session in the URL, /mode the mode chip, /model the picker,
 * /rewind "Restore to this point?", /export a download, /context the report, /memory its tab, /settings the settings dialog,
 * /remember a note, /help the list. Also: Esc closes the menu and keeps the text, a "/" inside a sentence opens nothing, Tab
 * completes, an unknown "/abc" is sent as text, and on a phone (`--phone`) the menu is a sheet a tap runs.
 *
 *   node packages/ui/scripts/slash-commands.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--phone] [--verbose]
 *
 * It reloads the app for every case (about 40 cases, 6 to 15 s each on a busy machine): a full run takes 4 to 6 minutes. That is
 * slow, not stuck; `--verbose` prints each case with its time as it ends.
 *
 * Prints `slash-commands: ok` or each failure. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { launchBrowser, newContext, isAbortedImport, PHONE } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const PHONE_MODE = argv.includes("--phone");
const VERBOSE = argv.includes("--verbose");
const PROJECT_HASH = "#/p/prj_0001/";

const browser = await launchBrowser();
const ctx = await newContext(browser, PHONE_MODE ? { ...PHONE, acceptDownloads: true } : { viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const failures = [];
const fail = (what) => failures.push(what);
page.on("pageerror", (e) => isAbortedImport(e.message) || fail(`page error: ${String(e.stack ?? e).slice(0, 400)}`));

const fresh = async (extraQuery = "") => {
  await page.goto("about:blank");
  await page.goto(`${BASE}/?demo=1${extraQuery}${PROJECT_HASH}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("octo.layout.") || k.startsWith("octo.fileTree.")) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  });
  await page.evaluate((h) => (window.location.hash = h), PROJECT_HASH);
  await composer().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(PHONE_MODE ? 1500 : 1000);
};
const composer = () => page.locator("textarea#octo-composer:visible, textarea#octo-composer-float:visible").first();
const bodyText = () => page.evaluate(() => document.body.innerText);
const menuOpen = () => page.locator("[data-slash-menu]").count();
const waitMenu = async () => page.locator("[data-slash-menu] [role=option]").first().waitFor({ state: "visible", timeout: 5000 });
const dialog = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? "");
const activeTab = () => page.evaluate(() => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((t) => t.textContent.trim()).join("|"));
const mode = () => page.evaluate(() => document.querySelector("[data-composer-row]")?.textContent ?? "");
const hash = () => page.evaluate(() => window.location.hash);

/** `how`: "full" (type it, Enter), "menu" (type "/", arrows to the row, Enter), "click" (type "/", click the row). */
async function invoke(how, name, args = "") {
  const ta = composer();
  await ta.click();
  if (how === "full") {
    await ta.fill(`/${name}${args ? ` ${args}` : ""}`);
    // The menu is a lazy chunk: wait for it when the text still names a command, so Enter is judged the same way every time.
    if (!args) await waitMenu().catch(() => undefined);
    else await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    return;
  }
  await ta.fill("/");
  await waitMenu();
  await page.keyboard.type(name);
  await page.waitForTimeout(200);
  const row = page.locator(`[data-slash-menu] [role=option]`, { hasText: new RegExp(`^/${name}(?![a-z])`) }).first();
  if (!(await row.count())) return fail(`${how} /${name}: no row in the menu`);
  if (how === "click") await row.click();
  else {
    for (let i = 0; i < 12; i++) {
      const on = await row.getAttribute("aria-selected");
      if (on === "true") break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
  }
}

const until = async (what, probe, ms = 4000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await page.waitForTimeout(100);
  }
  fail(what);
  return null;
};

/** Each command: its name, the argument (when it takes one), and what must be true afterwards. */
const COMMANDS = [
  { name: "new", check: async (t) => until(`${t}: no empty session opened (URL)`, async () => /\/s\/[^/]+\/?$/.test(await hash())) },
  {
    name: "new",
    args: "start fresh work",
    check: async (t) => until(`${t}: the text did not reach a new session`, async () => /Started in a new session|start fresh work/.test(await bodyText())),
  },
  {
    name: "compact",
    check: async (t) =>
      until(`${t}: no compact note`, async () => /compacts itself|Compacted|compact/i.test(await bodyText().then((s) => s.replace(/\/compact/g, "")))),
  },
  { name: "clear", check: async (t) => until(`${t}: no new session in the URL`, async () => /\/s\/[^/]+\/?$/.test(await hash())) },
  {
    name: "mode",
    args: "ask",
    check: async (t) =>
      until(`${t}: the mode chip did not turn to Ask`, async () => /^\s*\S*\s*Ask/.test((await mode()).trim()) || (await mode()).includes("Ask")),
  },
  {
    name: "mode",
    args: "",
    check: async (t) => until(`${t}: Enter did not complete the name for its argument`, async () => (await composer().inputValue()) === "/mode "),
  },
  { name: "model", check: async (t) => until(`${t}: no model picker`, async () => /Agents|Models|Search models/.test(await dialog())) },
  { name: "model", args: "sonnet", check: async (t) => until(`${t}: no model picker`, async () => /Agents|Models|Search models/.test(await dialog())) },
  { name: "rewind", check: async (t) => until(`${t}: no "Restore to this point?" dialog`, async () => /Restore to this point/.test(await dialog())) },
  { name: "context", check: async (t) => until(`${t}: no context report`, async () => /used|Context/.test(await dialog())) },
  { name: "memory", query: "&tabs=memory", check: async (t) => until(`${t}: no Memory tab`, async () => /Memory/.test(await activeTab())) },
  { name: "settings", check: async (t) => until(`${t}: no settings`, async () => /Project settings/.test(await dialog())) },
  {
    name: "remember",
    args: "we deploy on friday",
    check: async (t) => until(`${t}: not remembered`, async () => /Remembered: we deploy on friday/.test(await bodyText())),
  },
  { name: "help", check: async (t) => until(`${t}: no list of commands`, async () => /Always available/.test(await bodyText())) },
];

const WAYS = PHONE_MODE ? ["click"] : ["full", "menu", "click"];
for (const c of COMMANDS) {
  for (const how of WAYS) {
    // A command with an argument is typed in full; the menu only completes it (checked below), so "menu"/"click" use its name.
    if (c.args && how !== "full") continue;
    if (c.name === "mode" && c.args === "" && how !== "full") continue;
    const tag = `/${c.name}${c.args ? ` ${c.args}` : ""} (${how})`;
    const t0 = Date.now();
    await fresh(c.query ?? "");
    await invoke(how, c.name, c.args ?? "");
    await c.check(tag);
    if (VERBOSE) console.error(`  ${tag}: ${Date.now() - t0} ms`);
    if (c.name !== "clear" && c.name !== "new") {
      const left = await composer()
        .inputValue()
        .catch(() => "");
      if (left && !(c.args === "" && c.name === "mode")) fail(`${tag}: the text stayed in the box: "${left}"`);
    }
  }
}

// /export: a file is downloaded.
for (const how of WAYS) {
  await fresh();
  const dl = page.waitForEvent("download", { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  await invoke(how, "export");
  if (!(await dl)) fail(`/export (${how}): no download`);
}

// /memory is hidden when the Memory tab feature flag is off by default (`DEFAULT_TAB_FLAGS.memory === false`).
await fresh();
await composer().click();
await composer().fill("/");
await waitMenu();
if ((await page.locator("[data-slash-menu] [role=option]", { hasText: /^\/memory(?![a-z])/ }).count()) !== 0)
  fail("/memory: should be omitted when the Memory tab flag is off by default");

// /review is the harness's (a GitHub repository) and unavailable in the demo: its row stays, dim, with the reason.
await fresh();
await composer().click();
await composer().fill("/review");
await waitMenu();
if (!/Connect a GitHub repository first/.test(await page.locator("[data-slash-menu]").innerText())) fail("/review: the unavailable row does not say why");

// The menu's own behaviours.
await fresh();
await composer().click();
await composer().fill("/mo");
await waitMenu();
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
if ((await menuOpen()) !== 0) fail("Esc did not close the menu");
if ((await composer().inputValue()) !== "/mo") fail(`Esc erased the text: "${await composer().inputValue()}"`);

await fresh();
await composer().click();
await composer().fill("what does a / do in this path");
await page.waitForTimeout(400);
if ((await menuOpen()) !== 0) fail('a "/" inside a sentence opened the menu');

await fresh();
await composer().click();
await composer().fill("/mode");
await waitMenu();
await page.keyboard.press("Tab");
await page.waitForTimeout(200);
if ((await composer().inputValue()) !== "/mode ") fail(`Tab did not complete /mode: "${await composer().inputValue()}"`);

await fresh();
await composer().click();
await composer().fill("/new");
await waitMenu();
await page.keyboard.press("Tab");
await page.waitForTimeout(200);
if ((await composer().inputValue()) !== "/new ") fail(`Tab did not complete /new: "${await composer().inputValue()}"`);

if (!PHONE_MODE) {
  // An unknown command is sent as typed (the agent may know it), with no error.
  await fresh();
  await composer().click();
  await composer().fill("/abc");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await until("/abc: not sent as text", async () =>
    (
      await page
        .locator("[data-turn-id]")
        .last()
        .textContent()
        .catch(() => "")
    ).includes("/abc"),
  );
}

await browser.close();
if (failures.length) {
  for (const f of failures) console.error(`slash-commands: ${f}`);
  process.exit(1);
}
console.log("slash-commands: ok");
