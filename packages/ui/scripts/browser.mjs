/**
 * The browser every UI script drives: `--browser chromium|webkit` (default chromium). One place loads Playwright, starts the
 * engine and makes contexts, so a script runs the same in both engines. WebKit here is Playwright's own WebKit build (on
 * Linux, not Safari on iOS or macOS); a phone is `PHONE` (390×844, touch, mobile viewport) in either engine.
 *
 *   import { BROWSER, launchBrowser, newContext, PHONE } from "./browser.mjs";
 *   const browser = await launchBrowser();
 *   const ctx = await newContext(browser, { ...PHONE, colorScheme: "dark" });
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const at = argv.indexOf("--browser");
/** The engine named by `--browser` (chromium or webkit). */
export const BROWSER = at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : "chromium";
if (BROWSER !== "chromium" && BROWSER !== "webkit") {
  console.error(`--browser must be chromium or webkit, not ${BROWSER}`);
  process.exit(2);
}

/** The phone layout (lib/phone.ts PHONE_QUERY): a 390×844 touch viewport with a mobile meta viewport. */
export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

export function loadPlaywright() {
  const roots = [import.meta.url, "file:///opt/node-tools/", "file:///usr/local/lib/node_modules_global/"];
  try {
    roots.push(`file://${execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}/`);
  } catch {
    /* no npm */
  }
  for (const r of (process.env.NODE_PATH ?? "").split(":").filter(Boolean)) roots.push(`file://${r.endsWith("/") ? r : `${r}/`}`);
  for (const from of roots) {
    try {
      return createRequire(from)("playwright");
    } catch {
      /* try the next place */
    }
  }
  throw new Error("playwright is not installed");
}

/** Starts the engine named by `--browser`. */
export async function launchBrowser(options = {}) {
  const engine = loadPlaywright()[BROWSER];
  if (!engine) throw new Error(`playwright has no ${BROWSER}`);
  return engine.launch(options);
}

/**
 * `browser.newContext(options)`. In WebKit a phone-wide viewport (≤ 480) is a phone: touch and a mobile viewport, as a real
 * one (`PHONE`), unless the script says otherwise. An engine without `isMobile` gets the same context without it.
 */
export async function newContext(browser, options = {}) {
  if (BROWSER === "webkit" && options.viewport && options.viewport.width <= 480 && options.hasTouch === undefined) {
    options = { ...options, hasTouch: true, isMobile: true };
  }
  try {
    return await browser.newContext(options);
  } catch (e) {
    if (!options.isMobile) throw e;
    const { isMobile: _, ...rest } = options;
    return browser.newContext(rest);
  }
}

/**
 * A WebKit pageerror that only says a warm-up `import()` was cut short (a navigation or a closed context while the module
 * was loading: WebKit reports it as "Importing a module script failed", Chromium says nothing). Not a fault of the page;
 * a module that really fails to load also breaks the screen that needs it, which the scripts see.
 */
export const isAbortedImport = (message) => BROWSER === "webkit" && /Importing a module script failed/.test(String(message));

/** `browser.newPage(options)` through `newContext` (the page owns its context). */
export async function newPage(browser, options = {}) {
  const ctx = await newContext(browser, options);
  const page = await ctx.newPage();
  page.on("close", () => void ctx.close().catch(() => {}));
  return page;
}
