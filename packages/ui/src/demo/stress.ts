import { act, say, sleep, turn, type Ctx } from "./runtime";

/**
 * Stress content for visual checks: a 200-message conversation with a very long prompt, files with
 * long names (seeded in `seedFiles.ts`), and many projects with short, typical and very long names.
 */

const STEPS = [
  "verify retries back off with jitter on 429 responses",
  "re-run the settlement job twice and diff the totals",
  "confirm cursor pagination never skips inserted rows",
  "test the session refresh with two tabs at once",
  "find code that reads the clock instead of the injected one",
  "time the API container's cold start, note the slowest import",
];

/** ≈4,000 characters over 60 lines, plus one 400-character unbroken token. */
export function longPrompt(): string {
  const lines: string[] = ["Before we ship the release, run through this checklist and report back per step:"];
  for (let i = 1; i <= 58; i++) lines.push(`Step ${i}: ${STEPS[i % STEPS.length]}.`);
  lines.push(`Trace id: ${"a1b2c3d4e5".repeat(40)}`);
  return lines.join("\n");
}

/** A long reply to the long prompt, so its turn outlasts the pinned copy while scrolling. */
function longAnswer(): string {
  const rows = Array.from({ length: 58 }, (_, i) => {
    const n = i + 1;
    const status = n === 14 || n === 41 ? "Needs follow-up" : "OK";
    return `| ${n} | ${STEPS[n % STEPS.length]} | ${status} |`;
  });
  return [
    "Went through all 58 steps. Two need follow-up: step 14 (cursor pagination) and step 41 (clock reads); everything else checks out.",
    "",
    "| Step | Check | Result |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

const QUESTIONS = [
  "Where is the rate limiter configured?",
  "Why did the nightly build take 14 minutes?",
  "Summarise yesterday's incident in two lines.",
  "Which endpoints still lack request validation?",
  "Is the feature flag for exports still used?",
];

export async function stressHistory(ctx: Ctx): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const prompt = i === 60 ? longPrompt() : `${QUESTIONS[i % QUESTIONS.length]} (${i + 1})`;
    await turn(ctx, prompt, async (c, orch) => {
      if (i % 10 === 4) await act(c, orch, [{ name: "read_file", input: { path: "src/config.ts" }, result: "export const config = { … }", ms: 300 }]);
      await say(c, orch, i === 60 ? longAnswer() : `Answer ${i + 1}: the short version is in \`src/config.ts\`; nothing else needs to change.`);
    });
    await sleep(ctx, 11 * 60_000);
  }
}

/** A project whose history is `count` one-line requests (0 leaves it empty). */
export function requestsHistory(count: number) {
  return async (ctx: Ctx): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await turn(ctx, `${QUESTIONS[i % QUESTIONS.length]} (${i + 1})`, (c, orch) => say(c, orch, "Done."));
      await sleep(ctx, 17 * 60_000);
    }
  };
}

const NAMES = [
  "Infra",
  "Billing service",
  "Mobile onboarding redesign",
  "Quarterly compliance evidence collection across the payments platform, the data warehouse and every customer-facing service in the EU region",
  "Search",
  "Customer support macros",
  "Data warehouse migration to the new columnar store",
  "Notifications",
  "Partner API v3 with webhooks, idempotency keys, per-tenant rate limits and a sandbox environment that mirrors production data shapes",
  "Docs",
];

/** 30 project names cycling through one-word, typical and 120+ character names. */
export function manyProjectNames(): string[] {
  return Array.from({ length: 30 }, (_, i) => (i < NAMES.length ? NAMES[i] : `${NAMES[i % NAMES.length]} ${Math.floor(i / NAMES.length) + 1}`));
}
