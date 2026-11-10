#!/usr/bin/env node
// Fails when the desktop app's initial JavaScript (gzip) exceeds the budget.
// "Initial" = the entry chunk named in dist/index.html plus its static `modulepreload` chunks;
// lazily imported chunks (Monaco, the highlighter, demo fixtures) are not counted.
// Usage: node scripts/check-bundle-size.mjs [distDir]   (default apps/desktop/dist)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Measured with this script on 2026-11-10, before the Q1 tooling pass: 208.77 kB (node zlib default level;
 * Vite's own reporter prints 202.88 kB for the entry chunk alone because it compresses differently).
 * Budget = measured + 3 kB. Raise it only with a reason in the commit message.
 */
const BUDGET_KB = 211.8;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "apps/desktop/dist"));
const html = readFileSync(path.join(dist, "index.html"), "utf8");

const files = new Set();
for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
  const isEntry = /<script\b[^>]*type="module"/.test(tag);
  const isPreload = /rel="modulepreload"/.test(tag);
  if (!isEntry && !isPreload) continue;
  const src = /(?:src|href)="([^"]+\.js)"/.exec(tag)?.[1];
  if (src !== undefined) files.add(src.replace(/^\.?\//, ""));
}
if (files.size === 0) {
  console.error(`No initial script found in ${path.join(dist, "index.html")}. Run the desktop build first.`);
  process.exit(2);
}

let total = 0;
for (const file of files) {
  const gz = gzipSync(readFileSync(path.join(dist, file))).length;
  total += gz;
  console.log(`  ${file}  ${(gz / 1000).toFixed(2)} kB gzip`);
}
const kb = total / 1000;
console.log(`initial JS: ${kb.toFixed(2)} kB gzip (budget ${BUDGET_KB.toFixed(2)} kB)`);
if (kb > BUDGET_KB) {
  console.error(`Over budget by ${(kb - BUDGET_KB).toFixed(2)} kB. Lazy-load the new code or raise the budget with a reason.`);
  process.exit(1);
}
