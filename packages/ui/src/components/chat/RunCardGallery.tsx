import type { Agent, ContentBlock, Message, PlanEntry } from "@octo/agent-client";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Section, Variants } from "../primitives/gallery/parts";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { RunCardView } from "./AgentRunCard";
import { RUN_CARD_FRAME } from "./runCardPart";

/**
 * Decision 101 in the component gallery (`?demo=1&gallery=1`, demo only; `app/OctoApp` hands it to the primitives' gallery):
 * the run card in every state at the column's full width and at 320px, from fixed data (nothing here talks to a bridge).
 */
export function RunCardGallery() {
  return (
    <Section
      id="run-card"
      title="Run card (decision 101)"
      note="A sub-agent's row opened: what happens now, how far, the steps and their times, the model, the actions."
    >
      {CASES.map((c) => (
        <Variants key={c.label} label={c.label}>
          <div className="grid w-full grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 px-3">
              <Frame {...c} />
            </div>
            <div className="min-w-0 px-3">
              <Frame {...c} />
            </div>
          </div>
        </Variants>
      ))}
    </Section>
  );
}

const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function agent(p: Partial<Agent> & Pick<Agent, "id" | "role" | "status">): Agent {
  return {
    project_id: "prj_gallery",
    parent_id: "agt_root",
    depth: 1,
    title: "",
    task: "",
    model: "claude-sonnet-5-5",
    tier: "balanced",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 18_400,
    output_tokens: 2_100,
    created_at: at(0),
    started_at: at(0),
    finished_at: p.status === "running" ? null : at(42),
    ...p,
  };
}

type Call = { name: string; input: unknown; result?: string; error?: boolean; ms?: number };

/** A transcript of `calls`: each call and, unless it runs, its result with the time the harness reported. */
function transcript(agentId: string, calls: Call[]): Message[] {
  const out: Message[] = [];
  calls.forEach((c, i) => {
    const id = `${agentId}_t${i}`;
    out.push({ id: i * 2 + 1, agent_id: agentId, role: "assistant", created_at: at(i * 3), content: [{ type: "tool_use", id, name: c.name, input: c.input }] });
    if (c.result === undefined) return;
    const block: ContentBlock = {
      type: "tool_result",
      tool_use_id: id,
      content: c.result,
      is_error: c.error ?? false,
      ...(c.ms !== undefined ? { duration_ms: c.ms } : {}),
    };
    out.push({ id: i * 2 + 2, agent_id: agentId, role: "user", created_at: at(i * 3 + 2), content: [block] });
  });
  return out;
}

const plan = (current: number): PlanEntry[] =>
  ["Read the retry policy", "List the missing cases", "Write the backoff tests", "Write the clock tests", "Run the suite", "Summarise"].map((content, i) => ({
    content,
    priority: "medium",
    status: i < current ? "completed" : i === current ? "in_progress" : "pending",
  }));

const READS: Call[] = [
  { name: "read_file", input: { path: "src/billing/retry.ts" }, result: "…", ms: 1900 },
  { name: "grep", input: { pattern: "withRetry(", path: "src/billing" }, result: "4 matches", ms: 1500 },
  { name: "edit", input: { path: "src/billing/invoice.ts" }, result: "updated", ms: 2500 },
];

type Case = {
  label: string;
  glyph: ActivityState;
  title: string;
  elapsed: number;
  agent: Agent;
  messages: Message[];
  plan?: PlanEntry[];
  wait?: "approval" | "input";
  asks?: string;
};

const LONG =
  "pnpm --filter @atlas/billing exec vitest run src/billing/__tests__/invoice.retry.test.ts src/billing/__tests__/invoice.rounding.test.ts --reporter=verbose --coverage";

const CASES: Case[] = [
  {
    label: "Running, with a plan (step k of n)",
    glyph: "running",
    title: "Updating 5 test files",
    elapsed: 6_000,
    agent: agent({ id: "a1", role: "Test writer", status: "running" }),
    messages: transcript("a1", [...READS, { name: "write_file", input: { path: "src/billing/__tests__/retry.test.ts" } }]),
    plan: plan(3),
  },
  {
    label: "Running, no plan (a count and an indeterminate mark)",
    glyph: "running",
    title: "Thinking…",
    elapsed: 14_000,
    agent: agent({ id: "a2", role: "Code explorer", status: "running", model: "claude-haiku-5-5", tier: "fast" }),
    messages: transcript("a2", READS),
  },
  {
    label: "Waiting for you (links to the needs-you card)",
    glyph: "needs",
    title: "Waiting for your approval",
    elapsed: 21_000,
    agent: agent({ id: "a3", role: "Migration runner", status: "running", tier: "fast", model: "claude-haiku-5-5" }),
    messages: transcript("a3", [{ name: "read_file", input: { path: "migrations/0042_retry_attempts.sql" }, result: "…", ms: 600 }]),
    wait: "approval",
    asks: "pnpm db:migrate",
  },
  {
    label: "Finished",
    glyph: "done",
    title: "Updated the billing guide with the three-attempt retry rule.",
    elapsed: 42_000,
    agent: agent({ id: "a4", role: "Doc writer", status: "completed" }),
    messages: transcript("a4", READS),
  },
  {
    label: "Failed, with its reason",
    glyph: "failed",
    title: "3 tests still fail in invoice.test.ts after the change.",
    elapsed: 9_000,
    agent: agent({
      id: "a5",
      role: "Test fixer",
      status: "failed",
      tier: "fast",
      route_choice: "fast",
      route_reason: "Small, well-scoped change. The fast tier is enough.",
    }),
    messages: transcript("a5", [
      ...READS.slice(0, 1),
      { name: "bash", input: { command: "pnpm test --filter billing" }, result: "3 tests failed: invoice.test.ts", error: true, ms: 4100 },
    ]),
  },
  {
    label: "Escalated (Retried on … after …)",
    glyph: "done",
    title: "All 46 billing tests pass.",
    elapsed: 12_000,
    agent: agent({
      id: "a6",
      role: "Test fixer",
      status: "completed",
      tier: "deep",
      model: "claude-opus-5-5",
      route_choice: "deep",
      route_band: "hard",
      route_reason: "Retried on the deep tier after the tests failed. The fix touches the retry policy and its clock.",
    }),
    messages: transcript("a6", READS),
  },
  {
    label: "Stopped",
    glyph: "stopped",
    title: "Stopped",
    elapsed: 5_000,
    agent: agent({ id: "a7", role: "Lint sweeper", status: "cancelled", tier: "fast", model: "claude-haiku-5-5" }),
    messages: transcript("a7", [{ name: "bash", input: { command: "pnpm eslint src/billing" }, result: "14 problems", ms: 3300 }]),
  },
  {
    label: "Many steps (older ones fold) and a very long step",
    glyph: "done",
    title: "14 callers of withRetry; 9 use the default three attempts, 5 pass their own, and two of those come through the queue workers.",
    elapsed: 57_000,
    agent: agent({
      id: "a8",
      role: "Code explorer",
      status: "completed",
      tier: "fast",
      model: "claude-haiku-5-5",
      input_tokens: 817_000,
      output_tokens: 2_400,
    }),
    messages: transcript("a8", [
      ...Array.from({ length: 40 }, (_, i): Call => ({
        name: "read_file",
        input: { path: `src/billing/file${i}.ts` },
        result: "…",
        ms: 200 + ((i * 37) % 900),
      })),
      { name: "bash", input: { command: LONG }, result: "Tests: 31 passed", ms: 8400 },
    ]),
  },
];

/** The card as `DelegationGroup` draws it open: the frame, the head row, the body. */
function Frame(c: Case): ReactNode {
  return (
    <div role="region" aria-label={`${c.agent.role}: run`} data-run-card={c.agent.status} className={cn("@container/run min-w-0", RUN_CARD_FRAME)}>
      <ActivityRow state={c.glyph} data="run-head" verb={<span className="text-fg">{c.title}</span>} duration={c.elapsed} tip={c.title} expands open />
      <RunCardView
        agent={c.agent}
        projectId="prj_gallery"
        messages={c.messages}
        tools={undefined}
        plan={c.plan ?? null}
        wait={c.wait ?? null}
        asks={c.asks ?? null}
        sessionId={c.agent.status === "running" ? `ses_${c.agent.id}` : null}
        title={c.title}
        header={false}
        onOpen={() => undefined}
        onNeeds={() => undefined}
      />
    </div>
  );
}
