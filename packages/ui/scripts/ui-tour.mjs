#!/usr/bin/env node
/**
 * UI tour: a complete screenshot set of the UI for a design review. Drives `?demo=1` (and the demo knobs in
 * packages/ui/AGENTS.md) and saves `<group>/<nn>-<state>-<theme>-<WxH>.png`. It judges nothing: it captures each state, and a
 * state that cannot be reached is listed in MISSING.txt instead of saving a wrong screen.
 *
 *   node packages/ui/scripts/ui-tour.mjs --url http://localhost:1485 --out /tmp/tour [--only chat] [--theme dark] [--small] [--sizes phone]
 *
 * `--only` takes a group (or several, comma separated) or `group/nn`; `--theme` limits the themes; `--small` keeps 1440x900 only.
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GROUPS } from "./ui-tour-states.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = opt("--url", "http://localhost:1420").replace(/\/$/, "");
const OUT = path.resolve(opt("--out", "tour"));
const ONLY = opt("--only", "").split(",").filter(Boolean);
const THEMES = opt("--theme", "dark,light").split(",");
const SMALL = argv.includes("--small");
// `--sizes phone` (or `full,phone`): only those sizes of the states that run at four sizes; a state that runs at one size runs only when `full` is listed.
const ONLY_SIZES = opt("--sizes", "").split(",").filter(Boolean);
const SIZES = { full: [1440, 900], wide: [1100, 700], narrow: [830, 560], phone: [390, 700] };

function loadPlaywright() {
  const tries = [
    () => createRequire(import.meta.url)("playwright"),
    () => createRequire(`${execSync("npm root -g", { encoding: "utf8" }).trim()}/`)("playwright"),
  ];
  for (const t of tries) {
    try {
      return t();
    } catch {
      // Try the next place Playwright may be installed.
    }
  }
  console.error("ui-tour: Playwright is not installed (npm i -g playwright).");
  process.exit(2);
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
fs.mkdirSync(OUT, { recursive: true });
const missing = [];
const index = [];
let shots = 0;

const wanted = (group, nn) => ONLY.length === 0 || ONLY.some((o) => o === group || o === `${group}/${nn}`);

/** Fonts, lazy chunks and the app's own busy markers: nothing may still be loading when the picture is taken. */
async function settle(page, busyOk = false) {
  await page.evaluate(() => document.fonts.ready);
  for (let i = 0; i < (busyOk ? 0 : 40); i++) {
    const busy = await page.evaluate(() =>
      [...document.querySelectorAll("[aria-busy='true'], [data-skeleton], .skeleton, [role='progressbar']")].some((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
    );
    if (!busy) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(350);
}

for (const [group, states] of Object.entries(GROUPS)) {
  fs.mkdirSync(path.join(OUT, group), { recursive: true });
  for (let k = 0; k < states.length; k++) {
    const st = states[k];
    const nn = String(k + 1).padStart(2, "0");
    if (!wanted(group, nn)) continue;
    const all = st.sizes === "all" && !SMALL ? ["full", "wide", "narrow", "phone"] : ["full"];
    const sizes = ONLY_SIZES.length ? all.filter((z) => ONLY_SIZES.includes(z)) : all;
    for (const theme of THEMES) {
      for (const sz of sizes) {
        const [width, height] = SIZES[sz];
        const file = `${nn}-${st.name}-${theme}-${width}x${height}.png`;
        const rel = `${group}/${file}`;
        const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          const env = { base: BASE, theme, width, height, clip: null };
          await st.run(page, env);
          await settle(page, st.busy === true);
          await page.screenshot({ path: path.join(OUT, rel), ...(env.clip ? { clip: env.clip, ...(env.fullPage ? { fullPage: true } : {}) } : {}) });
          shots++;
          index.push({ group, rel, text: st.text, errors });
          console.log(`ok   ${rel}${errors.length ? `  (page errors: ${errors.length})` : ""}`);
        } catch (e) {
          const why = String(e && e.message ? e.message : e)
            .split("\n")[0]
            .slice(0, 200);
          missing.push(`${rel}: ${why}`);
          console.log(`MISS ${rel}: ${why}`);
          // What the page showed when the state could not be reached, for finding out why (not part of the set).
          fs.mkdirSync(path.join(OUT, "_debug", group), { recursive: true });
          await page.screenshot({ path: path.join(OUT, "_debug", rel) }).catch(() => undefined);
        }
        await ctx.close();
      }
    }
  }
}
await browser.close();

const prev = (name) => {
  try {
    return fs.readFileSync(path.join(OUT, name), "utf8");
  } catch {
    return "";
  }
};
if (ONLY.length === 0) {
  fs.writeFileSync(path.join(OUT, "MISSING.txt"), missing.length ? `${missing.join("\n")}\n` : "Nothing is missing.\n");
} else {
  // A partial run appends to what earlier runs recorded for other groups.
  const keep = prev("MISSING.txt")
    .split("\n")
    .filter((l) => l && l !== "Nothing is missing." && !ONLY.some((o) => l.startsWith(`${o}/`)));
  const all = [...keep, ...missing];
  fs.writeFileSync(path.join(OUT, "MISSING.txt"), all.length ? `${all.join("\n")}\n` : "Nothing is missing.\n");
}

// INDEX.md is rebuilt from the files on disk, with the descriptions of the states of this run's definitions.
const descr = new Map();
for (const [group, states] of Object.entries(GROUPS)) {
  states.forEach((st, k) => descr.set(`${group}/${String(k + 1).padStart(2, "0")}-${st.name}`, st.text));
}
const lines = [
  "# UI tour",
  "",
  "Every file is `<group>/<nn>-<state>-<theme>-<WxH>.png`; a state marked `*` in the brief exists at 1440x900, 1100x700, 830x560 and 390x700.",
  "",
];
for (const group of Object.keys(GROUPS)) {
  const dir = path.join(OUT, group);
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".png"))
        .sort()
    : [];
  lines.push(`## ${group}`, "");
  for (const f of files) {
    const key = `${group}/${f.replace(/-(dark|light)-\d+x\d+\.png$/, "")}`;
    lines.push(`- \`${group}/${f}\` — ${descr.get(key) ?? ""}`);
  }
  lines.push("");
}
fs.writeFileSync(path.join(OUT, "INDEX.md"), lines.join("\n"));
console.log(`ui-tour: ${shots} screenshots, ${missing.length} missing (${path.join(OUT, "MISSING.txt")})`);
