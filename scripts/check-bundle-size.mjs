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
 *
 * Q4 (2026-11-11): the demo fixtures moved behind `@octo/ui/demo`, loaded with import() only for `?demo=`; the initial
 * chunk measured 195.09 kB (was 211.22 kB after Q3). Budget = measured + 0.6 kB.
 *
 * v6.3 part 1 (2026-11-11): 196.57 kB — agent-client's context / side-question / compaction types and reducer (+0.6 kB),
 * browser-grade tabs, state rings and the team line (+3.9 kB), less the project and settings dialogs moved to lazy
 * chunks (−3.0 kB). Budget raised by 1.1 kB to 196.8.
 * v6.3 part 2: the "+" tab picker, the all-tabs list, the model picker's list, the file view, Agents, Notes, the composer's
 * "+" menu, the comments control, the Markdown preview, sent comments, the agent header, tool details and the table frame
 * moved to lazy chunks (warmed 1.5 s after start): 190.1 kB with this pass's new code in (and the harness's newer
 * agent-client types). Budget lowered from 196.8 to measured + 3 = 193.1.
 *
 * Merge of the harness and UI branches (2026-11-11): 152.89 kB (the entry chunk shrank as more moved to lazy chunks).
 * Budget lowered from 193.1 to measured + 3 = 155.9.
 *
 * Batch 1 (2026-11-12): the top row now carries the tab strips, the status bar, the tab-fit plan, pinned project
 * commands and maximise; with the review and providers code lazy the entry measures 156.23 kB. The rule stays
 * "measured + 3" (the 3 kB had been used up to the last 0.04 kB): budget 159.2. The component-library migration
 * (decision 90) is expected to shrink the entry; lower the budget again when it does.
 *
 * Batch 2 (same day): nine branches at once (notes, memory sessions, usage tables, provider recheck, the new
 * primitives) put the entry at 159.63 kB, 0.43 over. Temporary ceiling 160.0 so the batch can be tested; batch 3
 * carries the task "entry back to 156.5 or less" (lazy primitives that only lazy screens use, agent-client methods
 * out of the entry) and lowers this again. Do not raise it further.
 *
 * Batch 3 (2026-11-12): merged tree with the parity screens measured 157.96 kB; tool lines and delegation cards
 * (`ToolGroup`, `DelegationGroup`: -2.0 kB; warmed with the Markdown chunk right after the first paint) and the
 * language-server session code in agent-client (`openLanguageServer` imports it on first use: -0.5 kB) moved to
 * their own chunks; the turn line and the budget tooltip cost +0.3. Entry 155.78 kB. Budget = measured + 1.0 = 156.8.
 * (Making `FloatingComposer` lazy made it WORSE, +2.7 kB: the bundler hoisted more shared modules into extra preloaded
 * chunks. Measure every move.)
 *
 * Batch 5 + sessions merge (2026-11-12): the merged tree measured 172.99 kB (the same toolchain measures commit ec4bc05 at
 * 157.28). Moved out of the entry: the sessions model (the tab title and "which session loads" stay in `lib/sessions/current`),
 * the error mapping (`lib/errors/plain`: only `words` stays; the failed-turn notice is its own `TurnBanner` chunk, the sidebar's
 * failure tooltip maps through `useReadable` on demand), the provider reasons, the tool vocabulary beyond `toolName`, the image
 * canvas work, the routing line, the pills band, the folder menu, the "unsaved edits" dialogs: 163.59 kB. Still above the old
 * budget because the sidebar rows, the live activity line, the composer's slash and image hooks and the sessions state are real
 * first-paint code now. Budget = measured + 1.0 = 164.6; the target of 158 stays open (next: slash/image hooks behind a first-use
 * import, the agent-client's session methods in a lazy chunk). Do not raise it further.
 *
 * Entry diet (2026-11-13): 163.59 -> 157.91 kB. Cuts, each measured on its own build: half of the HTTP client's methods
 * (notes, review, commands, memory, sessions' writes, secrets, plans, queue edits, uploads, export ...) moved to a lazily
 * imported `rare.ts` behind thin forwarders, warmed after the first paint (-0.97, and -0.54 for the second batch); the tab
 * drag tracking (`dragPress.ts`, first press at the latest, warmed too: -1.2); the tooltip layer (-0.92); exports that only
 * lazy chunks use, split out of modules the entry also imports because the bundler hoists a shared module whole into the
 * preloaded chunk (`modelsMore`, `toolsMore`: -1.05; `slashRows`, `matchMore`, `imagePlan`: -0.73; `orchestratorMore`,
 * `providersMore`: -0.25). Check for the same trap before adding a lazy-only export to a module the entry imports.
 * Budget = measured + 1.0 = 158.9; the 158.0 target is met.
 *
 * Browser tab + Design Mode (2026-11-16): BrowserTab (11.31 kB), demoPage/inspector (11.56 kB), designNotes serializer/parser
 * (1.58 kB), SentDesignNotes (1.25 kB), and DesignNotesControl (inside CommentsControl) all load in lazy chunks (~27 kB gzip
 * kept out of initial JS); first-paint entry carries only `browser:<id>` tab layout/info, `GLYPH.browser`, tab-strip pin/title
 * state, `openBrowser`, staged design-note count subscription, and `rare.ts` forwarders: 158.10 -> 160.01 kB gzip.
 * Budget = measured + 1.0 = 161.0.
 *
 * Performance pass 3 (2026-11-19): the integration tip measured 160.57 kB (0.43 of room); this pass's scroll work put 0.08 into
 * entry modules (the request-in-view store in `state/nav`, the bisection in `chat/turnTracking`). How turns and steps ended
 * (`isInterruption`, `stepState`, `turnHead`, `turnDurationMs`, `turnFailureText`, `spawnStatus`, `compactionSlots`,
 * `turnWarning`, the restart texts) moved from `lib/transcript` (which the entry imports for `buildTurns` and the request
 * summaries) to `lib/turnEnding`, read only by the transcript, tool-line and delegation chunks: 159.85 kB, 1.15 of room.
 * Next candidates, unchanged: `formatSeparator`/`needsSeparator` (`lib/format`; also `v7/changes`, `memory/sessions`),
 * `useLoginHint`, `useCopy`, the scroll spots, `useRequests`/`projectRowLines`. Budget unchanged.
 */
const BUDGET_KB = 161.0;

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
