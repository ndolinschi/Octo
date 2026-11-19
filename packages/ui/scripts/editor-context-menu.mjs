#!/usr/bin/env node
/**
 * The editor's context menu stays open (WebKit with a macOS user agent: a right click in Monaco hops the focus of its input
 * textarea, which fires a `scroll` on the opener, and the menu closed itself ~280 ms after opening; primitives/Menu.tsx).
 * Opens src/auth/refresh.ts of Atlas API, then right-clicks in the text: one menu must be open 800 ms later. Shift+F10 and
 * (with `--ua-macos`) Ctrl+click are reported, not checked: neither opens the menu in Chromium either (2026-11-15), and a
 * real macOS Safari turns Ctrl+click into a `contextmenu` event that Playwright's Linux WebKit does not.
 *
 *   node packages/ui/scripts/editor-context-menu.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--ua-macos]
 *
 * `--ua-macos` presents Safari on macOS (Monaco and the app take macOS paths by the user agent). Prints
 * `editor-context-menu: ok` or each failed check. Exit code 1 on a failure, 2 on a problem driving the page.
 */
import { BROWSER, launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const MAC = argv.includes("--ua-macos");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const fail = (why) => {
  console.error(`editor-context-menu: could not drive the page: ${why}`);
  process.exit(2);
};

const browser = await launchBrowser().catch((e) => fail(`${BROWSER} did not start: ${String(e).split("\n")[0]}`));
const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, ...(MAC ? { userAgent: UA } : {}) });
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
page.on("pageerror", (e) => isAbortedImport(e.message) || errors.push(String(e.message).slice(0, 200)));
await page.goto(`${BASE}/?demo=1#/p/prj_0001`).catch((e) => fail(String(e).split("\n")[0]));
await page.waitForTimeout(2000);
await page.keyboard.press("Control+k");
const box = page.getByRole("combobox", { name: /^Search (tabs|or run an action)/ }).first();
await box.waitFor({ timeout: 8000 }).catch(() => fail("Ctrl+K did not open the palette"));
await box.fill("Show files");
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
const tree = page.getByRole("tree", { name: /files/i }).filter({ visible: true }).first();
await tree.waitFor({ timeout: 8000 }).catch(() => fail("no file tree"));
for (const dp of ["atlas-api/src", "atlas-api/src/auth"]) {
  const row = tree.locator(`[role="treeitem"][data-path="${dp}"]`).first();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.click();
    await page.waitForTimeout(400);
  }
}
await tree.locator('[role="treeitem"][data-path="atlas-api/src/auth/refresh.ts"]').first().click();
await page
  .locator(".monaco-editor .view-line")
  .first()
  .waitFor({ timeout: 20000 })
  .catch(() => fail("the editor did not open"));
await page.waitForTimeout(1500);
const lines = await page.locator(".monaco-editor .view-lines").first().boundingBox();
if (!lines) fail("no editor text");
const menus = () => page.evaluate(() => [...document.querySelectorAll("[role=menu]")].filter((m) => m.getBoundingClientRect().height > 0).length);
const problems = [];
const at = { x: lines.x + 100, y: lines.y + 30 };

await page.mouse.click(at.x, at.y, { button: "right" });
await page.waitForTimeout(800);
const right = await menus();
if (right !== 1) problems.push(`right click: ${right} menus open 800 ms later (want 1)`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

await page.mouse.click(at.x, at.y);
await page.keyboard.press("Shift+F10");
await page.waitForTimeout(800);
const key = await menus();
const notes = [`Shift+F10: ${key} menu(s)`];
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

if (MAC) {
  await page.mouse.click(at.x, at.y, { modifiers: ["Control"] });
  await page.waitForTimeout(800);
  const ctrl = await menus();
  notes.push(`Ctrl+click: ${ctrl} menu(s)`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

// G4: "Add to chat" puts the caret's line (here: line 2) into the conversation's composer as a mention, and the caret goes there.
const composerText = () => page.evaluate(() => /** @type {HTMLTextAreaElement | null} */ (document.getElementById("octo-composer"))?.value ?? null);
const addToChat = async () => {
  const item = page.getByRole("menuitem", { name: "Add to chat" }).filter({ visible: true }).first();
  if (!(await item.count())) return false;
  await item.click();
  await page.waitForTimeout(800);
  return true;
};
await page.mouse.click(at.x, at.y);
await page.mouse.click(at.x, at.y, { button: "right" });
await page.waitForTimeout(800);
if (!(await addToChat())) problems.push('editor menu: no "Add to chat"');
else {
  const text = await composerText();
  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  if (!text || !/@src\/auth\/refresh\.ts:2 $/.test(text)) problems.push(`editor "Add to chat": composer holds ${JSON.stringify(text)} (want "@src/auth/refresh.ts:2 ")`);
  if (focused !== "octo-composer") problems.push(`editor "Add to chat": focus on #${focused}, not the composer`);
}
// The same for a file in the tree's own menu (the file, no range).
const fileRow = page.locator('[role="tree"] [role="treeitem"][data-path="atlas-api/src/auth/tokens.ts"]').filter({ visible: true }).first();
if (await fileRow.count()) {
  await fileRow.click({ button: "right" });
  await page.waitForTimeout(800);
  if (!(await addToChat())) problems.push('file tree menu: no "Add to chat"');
  else {
    const text = await composerText();
    if (!text || !/@src\/auth\/tokens\.ts $/.test(text)) problems.push(`tree "Add to chat": composer holds ${JSON.stringify(text)}`);
  }
} else notes.push("tree menu: the tree was not on screen after the composer took focus");

await browser.close();
problems.push(...errors.map((e) => `page error: ${e}`));
const tag = `${BROWSER}${MAC ? ", macOS user agent" : ""}`;
if (problems.length) {
  console.error(`editor-context-menu (${tag}): FAIL\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`editor-context-menu: ok (${tag}; not checked: ${notes.join(", ")})`);
