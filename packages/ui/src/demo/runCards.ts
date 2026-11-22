import type { PlanEntry } from "@octo/agent-client";
import { act, delegate, say, setPlan, sleep, StoppedByUser, turn, type ChildSpec, type Ctx, type ToolSpec } from "./runtime";

/**
 * Demo-only: "run cards demo" (UI decision 101) — every state of a sub-agent's run card in one turn. A first round played in
 * from six minutes ago: finished, failed with a reason, its escalated retry ("Retried on … after …"), stopped, and one with 40+
 * steps and a very long step. Then a live round the orchestrator waits on: running with a plan (step k of n), running without a
 * plan, and one that waits for the person (the approval `withDemoV7` adds for "Migration runner").
 */
export const RUN_CARDS_TRIGGER = /run cards demo/i;

const MIN = 60_000;
const LONG = 10 * MIN;

const read = (path: string, ms = 400): ToolSpec => ({ name: "read_file", input: { path }, result: "…", ms });
const bash = (command: string, result: string, ms: number, error = false): ToolSpec => ({ name: "bash", input: { command }, result, ms, error });
const grep = (pattern: string, path: string, ms = 300): ToolSpec => ({ name: "grep", input: { pattern, path }, result: "3 matches", ms });

const LONG_COMMAND =
  "pnpm --filter @atlas/billing exec vitest run src/billing/__tests__/invoice.retry.test.ts src/billing/__tests__/invoice.rounding.test.ts src/billing/__tests__/invoice.currency.test.ts --reporter=verbose --coverage --coverage.include=src/billing/** --testTimeout=20000";

const plan = (at: number): PlanEntry[] =>
  [
    "Read the retry policy and its tests",
    "List the cases the tests miss",
    "Write tests for the jittered backoff",
    "Write tests for the clock injection",
    "Run the billing suite",
    "Summarise the coverage change",
  ].map((content, i) => ({ content, priority: "medium", status: i < at ? "completed" : i === at ? "in_progress" : "pending" }));

function pastRound(start: number): ChildSpec[] {
  return [
    {
      role: "Doc writer",
      title: "Billing guide: retry rules",
      tier: "balanced",
      startAt: start,
      task: "Update docs/billing.md with the new retry rules (three attempts, jittered backoff).",
      run: async (c, id) => {
        await act(c, id, [read("docs/billing.md", 900)]);
        await act(c, id, [read("src/billing/retry.ts", 700)]);
        await act(c, id, [{ name: "edit", input: { path: "docs/billing.md" }, result: "updated", ms: 1300 }]);
        const r = "**Updated the billing guide** with the three-attempt retry rule and its jittered backoff.";
        await say(c, id, r);
        return r;
      },
    },
    {
      role: "Test fixer",
      title: "Make invoice tests pass",
      tier: "fast",
      startAt: start + 2_000,
      route: { choice: "fast", band: "easy", reason: "Small, well-scoped change. The fast tier is enough." },
      task: "Fix the three failing invoice tests without changing their expectations.",
      run: async (c, id) => {
        await act(c, id, [read("src/billing/__tests__/invoice.test.ts")]);
        await act(c, id, [{ name: "edit", input: { path: "src/billing/invoice.ts" }, result: "updated", ms: 2500 }]);
        await act(c, id, [bash("pnpm test --filter billing", "3 tests failed: invoice.test.ts\n  ✕ rounds half-cents up", 4100, true)]);
        throw new Error("3 tests still fail in invoice.test.ts after the change.");
      },
    },
    {
      role: "Test fixer",
      title: "Make invoice tests pass",
      tier: "deep",
      startAt: start + 14_000,
      route: {
        choice: "deep",
        band: "hard",
        reason: "Retried on the deep tier after the tests failed. The fix touches the retry policy and its clock.",
      },
      task: "Fix the three failing invoice tests without changing their expectations.",
      run: async (c, id) => {
        await act(c, id, [read("src/billing/__tests__/invoice.test.ts"), read("src/billing/retry.ts")]);
        await act(c, id, [{ name: "edit", input: { path: "src/billing/retry.ts" }, result: "injected the clock", ms: 3200 }]);
        await act(c, id, [bash("pnpm test --filter billing", "Tests: 46 passed", 5200)]);
        const r = "All 46 billing tests pass: the retry policy now takes its clock from the caller.";
        await say(c, id, r);
        return r;
      },
    },
    {
      role: "Lint sweeper",
      title: "Fix lint across billing",
      tier: "fast",
      startAt: start + 4_000,
      task: "Run eslint on src/billing and fix what it reports.",
      run: async (c, id) => {
        await act(c, id, [bash("pnpm eslint src/billing", "14 problems (14 errors)", 3300)]);
        await act(c, id, [{ name: "edit", input: { path: "src/billing/client.ts" }, result: "updated", ms: 900 }]);
        throw new StoppedByUser();
      },
    },
    {
      role: "Code explorer",
      title: "Map every caller of the retry policy, including the ones reached through the queue workers and the webhook replays",
      tier: "fast",
      startAt: start + 1_000,
      task: "Find every caller of withRetry and how each one sets its attempts.",
      run: async (c, id) => {
        const files = ["client", "invoice", "refund", "payout", "webhook", "ledger", "queue", "worker", "replay", "currency"];
        for (let i = 0; i < 40; i++) {
          const f = files[i % files.length] ?? "client";
          await act(c, id, [i % 3 === 0 ? grep("withRetry\\(", `src/billing/${f}.ts`) : read(`src/billing/${f}.ts`, 200 + ((i * 37) % 900))]);
        }
        await act(c, id, [bash(LONG_COMMAND, "Tests: 31 passed", 8400)]);
        const r = "**14 callers** of `withRetry`; 9 use the default three attempts, 5 pass their own.";
        await say(c, id, r);
        return r;
      },
    },
  ];
}

function liveRound(): ChildSpec[] {
  return [
    {
      role: "Test writer",
      title: "Cover the jittered backoff",
      tier: "balanced",
      task: "Write the missing tests for the retry policy's jittered backoff and its clock.",
      run: async (c, id) => {
        setPlan(c, id, plan(0));
        await act(c, id, [read("src/billing/retry.ts", 900)]);
        setPlan(c, id, plan(1));
        await act(c, id, [grep("backoff", "src/billing/__tests__")]);
        setPlan(c, id, plan(2));
        await act(c, id, [{ name: "write_file", input: { path: "src/billing/__tests__/retry.jitter.test.ts" }, result: "written", ms: 1900 }]);
        setPlan(c, id, plan(3));
        await act(c, id, [read("src/billing/clock.ts", 1500)]);
        await act(c, id, [{ name: "edit", input: { path: "src/billing/__tests__/retry.clock.test.ts" }, result: "written", ms: LONG }]);
        setPlan(c, id, plan(6));
        return "Added 9 tests.";
      },
    },
    {
      role: "Dependency mapper",
      title: "Which services import billing",
      tier: "fast",
      task: "List every service that imports @atlas/billing and the version it pins.",
      run: async (c, id) => {
        await act(c, id, [bash("pnpm why @atlas/billing --json", "{ … 6 dependents }", 2400)]);
        await act(c, id, [read("services/payments/package.json"), read("services/ledger/package.json")]);
        await act(c, id, [grep('"@atlas/billing"', "services", 1200)]);
        await sleep(c, LONG);
        return "6 services.";
      },
    },
    {
      role: "Migration runner",
      title: "Apply the billing migration",
      tier: "fast",
      task: "Run `pnpm db:migrate` against the local database and report what changed.",
      run: async (c, id) => {
        await act(c, id, [read("migrations/0042_retry_attempts.sql", 600)]);
        // Waits for the approval `withDemoV7` adds once this agent runs, until the turn is stopped or ten minutes pass.
        await sleep(c, LONG);
        return "Migration applied.";
      },
    },
  ];
}

export async function runCardsTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await delegate(c, orch, pastRound(c.t - 6 * MIN), "I'll split this: docs, the failing tests, lint, and a map of the retry policy's callers.");
    await delegate(c, orch, liveRound(), "The tests pass now. Next: tests for the backoff, who depends on billing, and the migration.");
    await say(c, orch, "Done: tests written, dependents listed, migration applied.");
  });
}
