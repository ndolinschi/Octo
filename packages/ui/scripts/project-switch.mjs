#!/usr/bin/env node
/**
 * Decision 98 (flicker.mjs's sibling): changing the project never blinks. For every way a person changes project, the
 * conversation on screen is sampled at every painted frame (the same ResizeObserver probe as flicker.mjs) from just before the
 * click until 1.5 s after it, and each frame is classified: the previous screen, the next conversation, the loading state,
 * or blank. Asserted, for the first switch to a project (cold: read out of sight first) and for a switch back (warm: known):
 *
 *   - no blank frame (no conversation, no composer, no Home and no visible loading state);
 *   - the previous screen stays until the next conversation is painted; the next one's FIRST frame is already complete: the
 *     same scroll position, scroll height, block heights, composer and tab strip as its last frame (nothing fills in, nothing
 *     jumps to the bottom, the transcript is never held invisible);
 *   - no enter animation (`octo-msg-in`) replays in the conversation shown;
 *   - a loading state, if any (a cold read slower than the hold), shows no earlier than ~150 ms after the click and stays at
 *     least ~150 ms, and nothing but the complete conversation follows it.
 *
 * Paths: sidebar-sessions (the flat Sessions list), sidebar-tree ("Projects and sessions"), composer-project (the inline
 * project selector of an empty session), new-session (a tree row's "New session in <project>"), home (a Home row), palette
 * (Ctrl+K), back-forward (the window's Previous / Next page buttons), same-project (two sessions of one project, for
 * comparison: the same rules).
 *
 *   node packages/ui/scripts/project-switch.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--theme dark|light]
 *     [--cpu 4] [--only <path>[,<path>…]] [--shots DIR]
 *
 * `--cpu`: Chromium's CPU throttle. `--shots DIR`: every painted frame of each switch as a PNG named by its time after the
 * click (Chromium's screencast). Prints `project-switch: ok` or the problems; exit 1 on a failure, 2 on a problem driving the page.
 */
import fs from "node:fs";
import { BROWSER, launchBrowser, newContext, isAbortedImport } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "node packages/ui/scripts/project-switch.mjs [--url http://localhost:1420] [--browser chromium|webkit] [--theme dark|light] [--cpu 4] [--only <path>,…] [--shots DIR]",
  );
  process.exit(0);
}
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const THEME = opt("--theme", "dark");
const CPU = Number(opt("--cpu", "1"));
const ONLY = opt("--only", null)?.split(",");
const SHOTS = opt("--shots", null);
/** The hold of `useProjectSwitch` (SWITCH_HOLD_MS) less a frame of slack. */
const HOLD = 130;
const RECORD_MS = 1500;
const TOL = 1;

const fail = (why) => {
  console.error(`project-switch: could not drive the page: ${why}`);
  process.exit(2);
};

/** In the page: classifies every painted frame (see flicker.mjs for why a ResizeObserver probe). */
const RECORD = () => {
  const rec = { frames: [], stop: false, t0: performance.now(), hashAt: null };
  window.__switch = rec;
  addEventListener("hashchange", () => (rec.hashAt ??= performance.now() - rec.t0));
  const shown = (el) => el instanceof HTMLElement && el.offsetParent !== null && Number(getComputedStyle(el).opacity) > 0.02;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  document.body.append(probe);
  const tick = () => {
    if (rec.stop) return;
    probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
    requestAnimationFrame(tick);
  };
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return `${Math.round(b.top)},${Math.round(b.left)},${Math.round(b.width)},${Math.round(b.height)}`;
  };
  new ResizeObserver(() => {
    if (rec.stop) return;
    const main = document.querySelector("main");
    const conv = [...(main?.querySelectorAll("[data-conv]") ?? [])].find(shown);
    const composer = [...(main?.querySelectorAll("textarea#octo-composer") ?? [])].find(shown);
    const skeleton = [...(main?.querySelectorAll("[aria-busy]") ?? [])].some(shown);
    const home = [...(main?.querySelectorAll("[data-home]") ?? [])].some(shown);
    const column = conv?.querySelector("[data-column]");
    const scroller = column?.closest(".overflow-y-auto");
    const anims = conv
      ? document
          .getAnimations()
          .filter((a) => a.playState === "running" && "animationName" in a && a.animationName === "octo-msg-in" && conv.contains(a.effect?.target ?? null))
          .length
      : 0;
    rec.frames.push({
      t: performance.now() - rec.t0,
      title: main?.querySelector("h1[data-page-title]")?.textContent ?? "",
      kind: conv && composer ? "conv" : home ? "home" : skeleton ? "loading" : conv ? "conv-no-composer" : "blank",
      st: scroller ? Math.round(scroller.scrollTop) : null,
      sh: scroller ? scroller.scrollHeight : null,
      blocks: column ? [...column.children].map((e) => Math.round(e.getBoundingClientRect().height)).join(" ") : "",
      // The transcript's turns laid out but held invisible (NEW-4, until the stored endings are in).
      held: conv ? [...conv.querySelectorAll(".invisible")].filter((e) => e.getBoundingClientRect().height > 40).length : 0,
      composer: composer ? r(composer) : "",
      strips: [...document.querySelectorAll("[data-strip]")].filter(shown).map(r).join(" "),
      enter: anims,
    });
  }).observe(probe);
  requestAnimationFrame(tick);
};

const browser = await launchBrowser();
const problems = [];

async function open(view, start) {
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: THEME });
  await ctx.addInitScript(
    ([theme, v]) => {
      try {
        localStorage.setItem("octo.theme", theme);
        localStorage.setItem("octo.sidebarView", v);
      } catch {
        /* storage unavailable */
      }
    },
    [THEME, view],
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) => isAbortedImport(e.message) || problems.push(`page error: ${String(e.stack ?? e).slice(0, 600)}`));
  await page.goto(`${BASE}/?demo=1${start}`, { waitUntil: "domcontentloaded" });
  await page
    .locator("main [data-conv], main [data-home]")
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => fail(`nothing shown at ${start}`));
  // The warmed chunks arrive within ~2 s of start: this is about the switch, not about first-load latency.
  await page.waitForTimeout(2500);
  const cdp = BROWSER === "chromium" ? await ctx.newCDPSession(page) : null;
  if (cdp && CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  return { ctx, page, cdp };
}

/** Records one switch made by `act` and checks its frames. */
async function measure(page, cdp, name, act) {
  await page.evaluate(RECORD);
  const shots = [];
  let onFrame = null;
  if (cdp && SHOTS) {
    onFrame = async (f) => {
      shots.push({ ts: f.metadata.timestamp, data: f.data });
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  }
  await page.waitForTimeout(250);
  await act();
  await page.waitForTimeout(RECORD_MS);
  const rec = await page.evaluate(() => {
    window.__switch.stop = true;
    return { ...window.__switch, epoch: performance.timeOrigin + window.__switch.t0 };
  });
  if (cdp && SHOTS) {
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    const dir = `${SHOTS}/${name}`;
    fs.mkdirSync(dir, { recursive: true });
    const zero = (rec.epoch + (rec.hashAt ?? 0)) / 1000;
    shots.forEach((s, i) => fs.writeFileSync(`${dir}/f${String(i).padStart(3, "0")}_${Math.round((s.ts - zero) * 1000)}.png`, Buffer.from(s.data, "base64")));
  }
  const found = analyse(rec);
  for (const p of found) problems.push(`${name}: ${p}`);
  const kinds = [];
  for (const f of rec.frames.filter((x) => rec.hashAt === null || x.t >= rec.hashAt - 1)) {
    const k = f.kind === "conv" || f.kind === "home" ? `${f.kind}(${f.title.slice(0, 18)})` : f.kind;
    if (kinds[kinds.length - 1]?.k !== k) kinds.push({ k, n: 1 });
    else kinds[kinds.length - 1].n++;
  }
  console.log(`${name}: ${kinds.map((x) => `${x.k}×${x.n}`).join(" → ")}${found.length ? `  [${found.length} problems]` : ""}`);
}

function analyse(rec) {
  const out = [];
  if (rec.hashAt === null) return ["the route never changed"];
  const before = rec.frames.filter((f) => f.t < rec.hashAt);
  const after = rec.frames.filter((f) => f.t >= rec.hashAt);
  const from = before[before.length - 1];
  const last = after[after.length - 1];
  if (!from || !last) return ["no frames recorded"];
  if (last.title === from.title || (last.kind !== "conv" && last.kind !== "home"))
    return [`not shown ${RECORD_MS} ms after the switch (last frame: ${last.kind} "${last.title}")`];
  const ms = (f) => `${Math.round(f.t - rec.hashAt)} ms`;
  let arrived = null;
  let loadingFrom = null;
  for (const f of after) {
    if (f.kind === "blank" || f.kind === "conv-no-composer") {
      out.push(`${f.kind} frame at ${ms(f)}`);
      continue;
    }
    if (f.kind === "loading") {
      if (arrived) out.push(`loading state after the conversation was shown, at ${ms(f)}`);
      loadingFrom ??= f;
      continue;
    }
    if (f.title === from.title && f.kind === from.kind) {
      if (arrived) out.push(`the previous screen came back at ${ms(f)}`);
      else if (loadingFrom) out.push(`the previous screen after the loading state, at ${ms(f)}`);
      continue;
    }
    if (f.title !== last.title) {
      out.push(`a third screen "${f.title}" (${f.kind}) at ${ms(f)}`);
      continue;
    }
    if (!arrived) {
      arrived = f;
      if (loadingFrom && f.t - loadingFrom.t < HOLD) out.push(`loading state shown for only ${Math.round(f.t - loadingFrom.t)} ms (a flash)`);
    }
    // Every frame of the next conversation is already the complete one.
    const diff = [];
    if (f.st !== null && last.st !== null && Math.abs(f.st - last.st) > TOL) diff.push(`scrollTop ${f.st} → ${last.st}`);
    if (f.sh !== null && last.sh !== null && Math.abs(f.sh - last.sh) > TOL) diff.push(`scrollHeight ${f.sh} → ${last.sh}`);
    if (f.blocks !== last.blocks) diff.push(`blocks [${f.blocks.slice(0, 60)}] → [${last.blocks.slice(0, 60)}]`);
    if (f.held !== last.held) diff.push(`${f.held} held-invisible parts → ${last.held}`);
    if (f.composer !== last.composer) diff.push(`composer ${f.composer} → ${last.composer}`);
    if (f.strips !== last.strips) diff.push(`tab strips ${f.strips} → ${last.strips}`);
    if (diff.length) out.push(`incomplete frame at ${ms(f)}: ${diff.join("; ")}`);
    if (f.enter > 0) out.push(`enter animation replays at ${ms(f)} (${f.enter})`);
  }
  if (loadingFrom && loadingFrom.t - rec.hashAt < HOLD) out.push(`loading state shown ${ms(loadingFrom)} after the switch (before the hold ends)`);
  if (last.held > 0) out.push("the transcript is still held invisible at the end");
  // Collapse repeats of one kind of problem (a 60-frame fill-in is one problem).
  const seen = new Map();
  for (const p of out) {
    const key = p.replace(/at \d+ ms.*$/, "").replace(/\d+/g, "#");
    if (!seen.has(key)) seen.set(key, { first: p, n: 0 });
    seen.get(key).n++;
  }
  return [...seen.values()].map((x) => (x.n > 1 ? `${x.first} (and ${x.n - 1} more frames)` : x.first));
}

/** The sidebar's link to a session, else to its project (the tree lists a closed project's row only). */
async function link(page, href) {
  const session = page.locator(`nav a[href="${href}"]`);
  return (await session.count()) ? session.first() : page.locator(`nav a[href="${href.replace(/\/s\/.*$/, "")}"]`).first();
}
const click = (page, href) => link(page, href).then((l) => l.click());

const A = "#/p/prj_000k/s/ses_prj_000k_1"; // Release notes: idle
const B = "#/p/prj_0001/s/ses_prj_0001_1"; // Atlas API: a long conversation with approvals and forms
const B2 = "#/p/prj_0001/s/ses_prj_0001_plan";

const PATHS = {
  "sidebar-sessions": async () => {
    const { ctx, page, cdp } = await open("sessions", A);
    await measure(page, cdp, "sidebar-sessions cold", () => click(page, B));
    await measure(page, cdp, "sidebar-sessions warm", () => click(page, A));
    await ctx.close();
  },
  "sidebar-tree": async () => {
    const { ctx, page, cdp } = await open("tree", A);
    await measure(page, cdp, "sidebar-tree cold", () => click(page, B));
    await measure(page, cdp, "sidebar-tree warm", () => click(page, A));
    await ctx.close();
  },
  "composer-project": async () => {
    // An empty session: its composer carries the project selector.
    const { ctx, page, cdp } = await open("sessions", "#/p/prj_000n/s/ses_prj_000n_1");
    const pick = async (name) => {
      await page.locator("[data-project-selector]:visible").first().click();
      await page.getByRole("option", { name }).first().click();
    };
    await page
      .locator("[data-project-selector]:visible")
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => fail("no project selector in the empty session's composer"));
    await measure(page, cdp, "composer-project cold", () => pick(/Release notes/));
    await ctx.close();
  },
  "new-session": async () => {
    const { ctx, page, cdp } = await open("tree", A);
    const button = page.locator('nav button[aria-label="New session in Atlas API"]').first();
    await button.waitFor({ state: "attached", timeout: 8000 }).catch(() => fail('no "New session in Atlas API" in the tree'));
    await measure(page, cdp, "new-session cold", () => button.click({ force: true }));
    await ctx.close();
  },
  home: async () => {
    const { ctx, page, cdp } = await open("sessions", "#/");
    const row = page.locator('main [data-home] button[data-row][title^="Run the API tests"]').first();
    await row.waitFor({ timeout: 8000 }).catch(() => fail("no Home row for Atlas API's session"));
    await measure(page, cdp, "home cold", () => row.click());
    await ctx.close();
  },
  palette: async () => {
    const { ctx, page, cdp } = await open("sessions", A);
    const go = async (text) => {
      await page.keyboard.press("Control+k");
      const field = page.getByRole("combobox").or(page.locator("[role=dialog] input")).first();
      await field.waitFor({ timeout: 5000 });
      await page.keyboard.type(text);
      await page
        .getByRole("option", { name: new RegExp(`^${text}`) })
        .first()
        .waitFor({ timeout: 5000 });
      await page.keyboard.press("Enter");
    };
    await measure(page, cdp, "palette cold", () => go("Plan the release"));
    await measure(page, cdp, "palette warm", () => go("Draft the release notes"));
    await ctx.close();
  },
  "back-forward": async () => {
    const { ctx, page, cdp } = await open("sessions", A);
    await click(page, B);
    await page.waitForTimeout(2500);
    await measure(page, cdp, "back", () => page.getByRole("button", { name: "Previous page" }).click());
    await measure(page, cdp, "forward", () => page.getByRole("button", { name: "Next page" }).click());
    await ctx.close();
  },
  "same-project": async () => {
    // Both sessions read once before (a session never shown waits for its stored endings; that is not a project switch).
    const { ctx, page, cdp } = await open("sessions", B2);
    await click(page, B);
    await page.waitForTimeout(2500);
    await measure(page, cdp, "same-project", () => click(page, B2));
    await measure(page, cdp, "same-project back", () => click(page, B));
    await ctx.close();
  },
};

for (const [name, run] of Object.entries(PATHS))
  if (!ONLY || ONLY.includes(name)) await run().catch((e) => fail(`${name}: ${String(e.message ?? e).split("\n")[0]}`));
await browser.close();
if (problems.length) {
  console.log(`project-switch (${THEME}, cpu ${CPU}x): FAIL`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log("project-switch: ok");
