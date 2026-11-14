// The phone flow (spec 2026-11-14-remote-access-mobile-design.md, criterion 27), run by phone-flow.sh which starts the
// harness. Environment: BRIDGE (the computer's bridge), PHONE (the tunnel listener), LOCAL_TOKEN, PROJECT_DIR.
// Steps: pairing page from a QR link → Pair → waiting → "Allow" on the computer → the app → open the project → send a
// message → the answer streams → an approval card → Allow → revoke on the computer → back to pairing with the notice.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = opt("--out", "/tmp/octo-phone-flow");
const THEME = opt("--theme", "dark");
const { BRIDGE, PHONE, LOCAL_TOKEN, PROJECT_DIR } = process.env;

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
      /* next */
    }
  }
  throw new Error("playwright is not installed");
}

async function computer(method, path, body) {
  const res = await fetch(BRIDGE + path, {
    method,
    headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function until(what, f, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

const log = (s) => console.log(`phone-flow: ${s}`);
const consoleErrors = [];

await computer("POST", "/v1/remote/enable", { acknowledge: true });
await until("remote access on", async () => (await computer("GET", "/v1/remote")).state === "on");
const project = await computer("POST", "/v1/projects", { name: "Atlas", folders: [{ path: PROJECT_DIR }], access: "supervised" });
const st = await computer("POST", "/v1/remote/pairing");
const code = st.pairing.code.replace("-", "");
log(`on at ${st.url} (listener ${st.listen}), code ${st.pairing.code}`);

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
await ctx.addInitScript((theme) => {
  try {
    localStorage.setItem("octo.theme", theme);
  } catch {
    /* storage unavailable */
  }
}, THEME);
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${THEME}-${name}.png` });
  log(`screenshot ${THEME}-${name}.png`);
};

try {
  await page.goto(`${PHONE}/#pair=${code}`);
  await page.getByLabel("Pairing code").waitFor();
  const filled = await page.getByLabel("Pairing code").inputValue();
  if (filled !== st.pairing.code) throw new Error(`code from the QR link: ${filled}`);
  if (page.url().includes("pair=")) throw new Error("the code stayed in the address bar");
  await shot("1-pairing");
  await page.getByRole("button", { name: "Pair" }).click();
  await page.getByText("Waiting for your computer").waitFor();
  await shot("2-waiting");

  const pending = await until("a pending device", async () => (await computer("GET", "/v1/remote")).devices.find((d) => d.status === "pending"));
  if (pending.name !== "iPhone") throw new Error(`device name ${pending.name}`);
  await computer("POST", `/v1/remote/devices/${pending.id}/confirm`);
  log("allowed on the computer");

  await page.getByText("Atlas").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await shot("3-home");
  await page.getByText("Atlas").first().click();
  const composer = page.locator("textarea").first();
  await composer.waitFor({ timeout: 20000 });
  await shot("4-project");

  await composer.fill("Say hello [essay]");
  await composer.press("Enter");
  await until("a streamed answer", async () => (await computer("GET", `/v1/projects/${project.id}`)).status === "running", 10000).catch(() => null);
  await page.waitForTimeout(700);
  await shot("5-streaming");
  await until("the turn to end", async () => (await computer("GET", `/v1/projects/${project.id}`)).status === "idle", 60000);
  await page.waitForTimeout(800);
  await shot("6-answer");

  await composer.fill("Go [bash:echo hi > made.txt]");
  await composer.press("Enter");
  const allow = page.getByRole("button", { name: /^Allow/ }).first();
  await allow.waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await shot("7-approval");
  await allow.click();
  await until("the approved command ran", async () => {
    try {
      execSync(`test -f "${PROJECT_DIR}/made.txt"`);
      return true;
    } catch {
      return false;
    }
  }, 30000);
  // Further approvals of the same turn (the mock's sub-agent may ask more than once).
  await until("the turn to end", async () => {
    const b = page.getByRole("button", { name: /^Allow/ }).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => undefined);
    return (await computer("GET", `/v1/projects/${project.id}`)).status === "idle";
  }, 60000);
  await page.waitForTimeout(800);
  await shot("8-approved");

  const dev = (await computer("GET", "/v1/remote")).devices[0];
  await computer("DELETE", `/v1/remote/devices/${dev.id}`);
  log("revoked on the computer");
  await page.getByText("This phone was disconnected on your computer.").waitFor({ timeout: 40000 });
  await shot("9-revoked");
  const stored = await page.evaluate(() => localStorage.getItem("octo.remote.device"));
  if (stored) throw new Error("the token is still stored after the revoke");
  const csp = consoleErrors.filter((e) => /Content Security Policy|Refused to/.test(e));
  if (csp.length) throw new Error(`CSP violations: ${csp.join(" | ")}`);
  log(`console errors (other than expected 401s): ${consoleErrors.filter((e) => !/401|Unauthorized/.test(e)).length}`);
  for (const e of consoleErrors) log(`  console: ${e.slice(0, 200)}`);
  log("passed");
} catch (e) {
  await shot("fail").catch(() => undefined);
  for (const c of consoleErrors) log(`  console: ${c.slice(0, 300)}`);
  console.error(`phone-flow: FAILED: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
