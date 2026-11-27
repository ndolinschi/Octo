import { emit } from "./store";
import { act, delegate, say, sleep, turn, type Ctx } from "./runtime";

/** Demo-only: a turn that shows live activity — thinks 2 s, publishes a plan, runs three tools 700 ms apart, streams text. */
export const LIVE_TRIGGER = /live activity/i;

const PLAN = ["Read the entry point", "Search for the budget rule", "Run the tests"];

/** Demo-only: a prompt containing "fail turn" ends in an error with a hint (the harness sends the hint apart). */
export const FAIL_TRIGGER = /fail turn/i;

export async function failTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await act(c, orch, [{ name: "read_file", input: { path: "src/index.ts" }, result: "export {};", ms: 700 }]);
    throw Object.assign(new Error("upstream returned 401: invalid API key"), { hint: "Check the key in Settings, then send the request again." });
  });
}

/**
 * Demo-only (`?limit=<provider id>`): every turn on that account ends at once with the plan-limit failure, which offers
 * "Use another account" and "Choose another model" beside Retry.
 */
export async function limitTurn(ctx: Ctx, prompt: string, label: string): Promise<void> {
  await turn(ctx, prompt, async () => {
    throw Object.assign(new Error(`${label} has reached its usage limit.`), {
      hint: "Pick another account or model and retry, or wait until the limit resets.",
      action: "switch_account",
      code: "agent_limit_reached",
    });
  });
}

/** Demo-only: "refused spawn" — a `spawn_agent` call the harness refuses before any agent exists (an error result, no agent). */
export const SPAWN_REFUSED_TRIGGER = /refused spawn/i;

export async function spawnRefusedTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await act(c, orch, [
      {
        name: "spawn_agent",
        input: { role: "Security reviewer", title: "Review the auth flow", task: "Read src/auth and list risky spots." },
        result: "spawn_agent requires role, title, task and tier (fast|balanced|deep)",
        error: true,
        ms: 300,
      },
    ]);
    await say(c, orch, "The sub-agent could not start: the delegation was missing its tier. I can retry with one, or do the review myself.");
  });
}

/** Demo-only: "slow command" — an ACP-style turn whose last command runs a minute; Stop answers it "rejected" (an error result). */
export const SLOW_TRIGGER = /slow command/i;

export async function slowTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await act(c, orch, [{ name: "read_file", input: { path: "README.md" }, result: "# Atlas", ms: 500 }]);
    await act(c, orch, [{ name: "bash", input: { command: "ls nope" }, result: "ls: nope: No such file or directory", error: true, ms: 500 }]);
    await act(c, orch, [{ name: "bash", input: { command: "python3 count.py" }, result: "60", ms: 60_000, onCancel: "rejected" }]);
    await say(c, orch, "It printed 60.");
  });
}

export async function liveTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    const rec = c.rec;
    emit(rec, { type: "agent.activity", agent_id: orch, kind: "thinking", label: "Thinking…" });
    for (const word of ["Looking at ", "the request. ", "The entry point ", "comes first, ", "then the budget rule."]) {
      emit(rec, { type: "message.thinking_delta", agent_id: orch, text: word });
      await sleep(c, 400);
    }
    const plan = (done: number) =>
      PLAN.map((content, i) => ({ content, priority: "medium", status: i < done ? "completed" : i === done ? "in_progress" : "pending" }) as const);
    emit(rec, { type: "agent.plan", agent_id: orch, entries: [...plan(0)] });
    emit(rec, { type: "agent.activity", agent_id: orch, kind: "tool", label: "Reading src/index.ts" });
    await act(c, orch, [{ name: "read_file", input: { path: "src/index.ts" }, result: "export {};", ms: 700 }]);
    emit(rec, { type: "agent.plan", agent_id: orch, entries: [...plan(1)] });
    emit(rec, { type: "agent.activity", agent_id: orch, kind: "tool", label: "Searching for “budget”" });
    await act(c, orch, [{ name: "search", input: { query: "budget" }, result: "src/budget.ts:12", ms: 700 }]);
    emit(rec, { type: "agent.plan", agent_id: orch, entries: [...plan(2)] });
    emit(rec, { type: "agent.activity", agent_id: orch, kind: "tool", label: "Running `pnpm test`" });
    await act(c, orch, [{ name: "bash", input: { command: "pnpm test" }, result: "12 passed", ms: 700 }]);
    emit(rec, { type: "agent.plan", agent_id: orch, entries: [...plan(3)] });
    emit(rec, { type: "agent.activity", agent_id: orch, kind: "text", label: "Writing" });
    await say(c, orch, "All three steps are done: the entry point is fine, the budget rule lives in `src/budget.ts`, and the tests pass.");
  });
}

/** Demo-only: "helper approval" — a sub-agent whose command waits for the person's approval (NEW-3: its row says so). */
export const APPROVAL_TRIGGER = /helper approval/i;

export async function approvalTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await delegate(
      c,
      orch,
      [
        {
          role: "Command runner",
          title: "Run the migration check",
          task: "Run `pnpm db:check` and report what it says.",
          tier: "fast",
          run: async (cc) => {
            // Waits (for the approval `withDemoV7` adds) until the turn is stopped or ten minutes pass.
            await sleep(cc, 600_000);
            return "No pending migrations.";
          },
        },
      ],
      "A helper will run the migration check.",
    );
    await say(c, orch, "The migration check passed: nothing is pending.");
  });
}

/**
 * Demo-only: "stubborn stop" — a running command that ends 8 s after Stop is pressed, as a built-in sub-agent's bash does at the
 * harness (G5: the composer says "Still stopping — a running command has to finish" after 5 s).
 */
export const STUBBORN_TRIGGER = /stubborn stop/i;

export async function stubbornTurn(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await say(c, orch, "Running `sleep 40; echo done` — this takes a while.");
    const until = Date.now() + 120_000;
    while (!c.signal.cancelled && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    if (c.signal.cancelled) await new Promise((r) => setTimeout(r, 8_000));
    await sleep(c, 0);
    await say(c, orch, "done");
  });
}
