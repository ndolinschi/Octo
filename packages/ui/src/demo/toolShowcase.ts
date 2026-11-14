import { act, say, turn, type Ctx } from "./runtime";
import { writeDemoFile } from "./store";

/**
 * retest3 G1/G2: one turn with every kind of tool call the transcript renders — a command with long output, a failed
 * command, a read, a built-in edit and an ACP edit with real diffs, a stopped command, a declined call and unknown
 * tools — so each body can be seen (Atlas API, its first request). The edits' changes are recorded in `v7.ts`.
 */
export const SHOWCASE_PROMPT = "Run the API tests and lint, then raise the HTTP retry limit to 5 and log each retry.";

export const RETRY_BEFORE = `import { setTimeout as sleep } from "node:timers/promises";

export type RetryOptions = {
  /** Attempts after the first one. */
  retries: number;
  /** First delay in milliseconds; doubles each attempt. */
  baseMs: number;
};

export const DEFAULT_RETRY: RetryOptions = { retries: 2, baseMs: 200 };

/** Runs \`fn\` until it succeeds or the attempts run out; only network errors and 5xx answers are retried. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = DEFAULT_RETRY): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!retryable(e) || attempt >= opts.retries) throw e;
      await sleep(opts.baseMs * 2 ** attempt);
      attempt++;
    }
  }
}

function retryable(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const status = (e as { status?: number }).status;
  return typeof status === "number" && status >= 500;
}
`;

const OLD_EDIT = `export const DEFAULT_RETRY: RetryOptions = { retries: 2, baseMs: 200 };`;
const NEW_EDIT = `export const DEFAULT_RETRY: RetryOptions = { retries: 5, baseMs: 200 };`;
const OLD_LOOP = `      if (!retryable(e) || attempt >= opts.retries) throw e;
      await sleep(opts.baseMs * 2 ** attempt);`;
const NEW_LOOP = `      if (!retryable(e) || attempt >= opts.retries) throw e;
      const delay = opts.baseMs * 2 ** attempt;
      log.warn({ attempt: attempt + 1, of: opts.retries, delay }, "retrying request");
      await sleep(delay);`;
export const RETRY_AFTER = RETRY_BEFORE.replace(OLD_EDIT, NEW_EDIT)
  .replace(OLD_LOOP, NEW_LOOP)
  .replace(
    `import { setTimeout as sleep } from "node:timers/promises";`,
    `import { setTimeout as sleep } from "node:timers/promises";\nimport { log } from "../log";`,
  );

export const CLIENT_BEFORE = `import { withRetry } from "./retry";

export async function getJson<T>(url: string): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
    return (await res.json()) as T;
  });
}
`;
export const CLIENT_AFTER = CLIENT_BEFORE.replace(
  "    const res = await fetch(url);",
  "    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });",
);

const SUITES = [
  "auth/login",
  "auth/refresh",
  "auth/tokens",
  "http/middleware/auth",
  "http/cookies",
  "http/cors",
  "http/retry",
  "http/client",
  "db/index",
  "billing/invoices",
  "billing/plans",
  "billing/webhooks",
  "accounts/members",
  "accounts/invites",
];
const TEST_OUTPUT = [
  "> atlas-api@0.14.2 test /Users/maya/code/atlas-api",
  "> vitest run --reporter=verbose",
  "",
  " RUN  v3.2.4 /Users/maya/code/atlas-api",
  "",
  ...SUITES.flatMap((s, i) => [
    ` ✓ test/${s}.test.ts (${3 + (i % 5)} tests) ${40 + i * 13}ms`,
    `   ✓ ${s.split("/")[1]} › handles the happy path`,
    `   ✓ ${s.split("/")[1]} › rejects bad input`,
    `   ✓ ${s.split("/")[1]} › keeps state between calls`,
  ]),
  "",
  " Test Files  14 passed (14)",
  "      Tests  58 passed (58)",
  "   Start at  11:36:02",
  "   Duration  4.18s (transform 612ms, setup 0ms, collect 1.94s, tests 1.32s)",
].join("\n");

const LINT_OUTPUT = [
  "> atlas-api@0.14.2 lint /Users/maya/code/atlas-api",
  "> eslint . --max-warnings 0",
  "",
  "/Users/maya/code/atlas-api/src/http/retry.ts",
  "  27:23  error  Unsafe member access .status on an `any` value  @typescript-eslint/no-unsafe-member-access",
  "",
  "/Users/maya/code/atlas-api/src/billing/plans.ts",
  "  4:10  warning  'Plan' is defined but never used  @typescript-eslint/no-unused-vars",
  "",
  "✖ 2 problems (1 error, 1 warning)",
  "",
  " ELIFECYCLE  Command failed with exit code 1.",
].join("\n");

/** What Claude Code answers for a call a person declined or stopped (the text the report's P03 showed as a red error). */
const AGENT_REFUSAL =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export async function toolShowcaseTurn(ctx: Ctx): Promise<void> {
  const root = "/Users/maya/code/atlas-api";
  writeDemoFile(ctx.rec, "atlas-api", "src/http/retry.ts", RETRY_BEFORE, "user", ctx.t);
  writeDemoFile(ctx.rec, "atlas-api", "src/http/client.ts", CLIENT_BEFORE, "user", ctx.t);
  await turn(ctx, SHOWCASE_PROMPT, async (c, orch) => {
    await act(c, orch, [{ name: "bash", input: { folder: "atlas-api", command: "pnpm test -- --reporter=verbose" }, result: TEST_OUTPUT, ms: 4200 }]);
    await act(c, orch, [{ name: "bash", input: { folder: "atlas-api", command: "pnpm lint" }, result: LINT_OUTPUT, error: true, ms: 2600 }]);
    await act(c, orch, [
      {
        name: "read_file",
        input: { folder: "atlas-api", path: "src/http/retry.ts", offset: 1, limit: 40 },
        result: RETRY_BEFORE,
        ms: 300,
      },
      {
        name: "search_issues",
        input: { query: "retry limit", team: "API", state: "open", limit: 5 },
        result: JSON.stringify(
          [
            { id: "API-412", title: "Raise the retry limit for flaky upstreams", state: "open" },
            { id: "API-398", title: "Log each retry with its delay", state: "open" },
          ],
          null,
          2,
        ),
        ms: 700,
      },
    ]);
    await act(c, orch, [
      {
        name: "edit",
        input: { folder: "atlas-api", path: "src/http/retry.ts", old_string: OLD_EDIT, new_string: NEW_EDIT },
        result: "edited src/http/retry.ts",
        ms: 300,
      },
      {
        name: "edit",
        input: { folder: "atlas-api", path: "src/http/retry.ts", old_string: OLD_LOOP, new_string: NEW_LOOP },
        result: "edited src/http/retry.ts",
        ms: 300,
      },
    ]);
    writeDemoFile(c.rec, "atlas-api", "src/http/retry.ts", RETRY_AFTER, "agent", c.t);
    await act(c, orch, [
      {
        name: "edit",
        input: {
          title: "Edit src/http/client.ts",
          raw_input: {
            file_path: `${root}/src/http/client.ts`,
            old_string: "    const res = await fetch(url);",
            new_string: "    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });",
          },
          locations: [{ path: `${root}/src/http/client.ts`, line: 5 }],
        },
        result: `diff ${root}/src/http/client.ts\n-    const res = await fetch(url);\n+    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });`,
        ms: 400,
      },
      {
        name: "search",
        input: { title: "Search for withRetry in src", raw_input: { pattern: "withRetry", path: `${root}/src` } },
        result: "src/http/client.ts:4\nsrc/http/retry.ts:14\nsrc/billing/webhooks.ts:31",
        ms: 300,
      },
    ]);
    writeDemoFile(c.rec, "atlas-api", "src/http/client.ts", CLIENT_AFTER, "agent", c.t);
    await act(c, orch, [
      {
        name: "bash",
        input: { folder: "atlas-api", command: "pnpm test:e2e --watch" },
        result: "interrupted: the tool call did not complete.",
        error: true,
        ms: 9000,
      },
      {
        name: "execute",
        input: { title: "git push origin retry-limit", raw_input: { command: "git push origin retry-limit" } },
        result: AGENT_REFUSAL,
        error: true,
        ms: 400,
      },
    ]);
    await say(
      c,
      orch,
      "Raised the default retry limit to **5** and every retry now logs its attempt and delay (`src/http/retry.ts`); requests also time out after 10 s (`src/http/client.ts`). The tests pass; lint still reports one error in `retry.ts` (an unsafe `.status` access) that I left for you to decide on. I did not push.",
    );
  });
}
