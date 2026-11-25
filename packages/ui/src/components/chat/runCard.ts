import type { ActiveTool, AgentStatus, Message, PlanEntry } from "@octo/agent-client";
import { callRow, viewState, type CallRow, type Locate } from "../../lib/toolView";
import type { TurnEnd } from "../../lib/transcript";
import { stepState, type StepState } from "../../lib/turnEnding";
import { toolActivity } from "./activity";

/**
 * The sub-agent run card (UI decision 101): what it does now, how far along it is, what it did and how long each step took,
 * which model runs it, and what the person can do. Pure: the card (`AgentRunCard`) and the delegation row read this.
 */

/** A step of an agent's run: one tool call, phrased as the transcript's own rows phrase it (`callRow`). */
export type RunStep = {
  id: string;
  state: StepState;
  row: CallRow;
  /** A running step reads in the present ("Reading src/x.ts"), as the activity line says it (`toolActivity`). */
  live: string | null;
  /** How long the call ran, as the harness timed it (`tool_result.duration_ms`); null when it did not (older rows): never a guess. */
  durationMs: number | null;
  /** When a running call started (ms since the epoch), for its live timer; null when unknown. */
  startedAt: number | null;
  /** A failed call's reason: the first line of its result. */
  reason: string | null;
};

/** The last steps the card shows; older ones fold behind "Show N earlier". */
export const STEPS_SHOWN = 5;

/** How long a card the waiting rule opened stays open after its agent finished, before it folds back into its row. */
export const RUN_CARD_LINGER_MS = 1600;

/** At most one spoken update of the live step per this many milliseconds (the card's polite live region). */
export const ANNOUNCE_EVERY_MS = 8000;

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

/**
 * The steps of an agent's transcript, oldest first. A call without a result is running while the agent runs, else it was cut
 * (stopped); a refusal reads stopped, not failed (as in `ToolGroup`). `activeTools` gives a running call's start; without it the
 * start is the time its call was stored.
 */
export function runSteps(
  messages: readonly Message[],
  opts: { running: boolean; end?: TurnEnd; locate?: Locate; activeTools?: Readonly<Record<string, ActiveTool>> | undefined },
): RunStep[] {
  const results = new Map<string, Extract<Message["content"][number], { type: "tool_result" }>>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const steps: RunStep[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const result = results.get(b.id);
      const state = viewState(stepState(result, opts.running, opts.end ?? null), result);
      const output = typeof result?.content === "string" ? result.content : undefined;
      const started = opts.activeTools?.[b.id]?.started_at ?? m.created_at;
      const at = Date.parse(started);
      steps.push({
        id: b.id,
        state,
        row: callRow(b.name, b.input, opts.locate, output),
        live: state === "running" ? toolActivity(b.name, b.input) : null,
        durationMs: typeof result?.duration_ms === "number" ? result.duration_ms : null,
        startedAt: state === "running" && !Number.isNaN(at) ? at : null,
        reason: state === "error" && output ? firstLine(output) || null : null,
      });
    }
  }
  return steps;
}

/** The steps shown: the last `STEPS_SHOWN` (all when `all`), and how many earlier ones are folded. */
export function visibleSteps<T>(steps: readonly T[], all: boolean, shown = STEPS_SHOWN): { earlier: number; steps: readonly T[] } {
  if (all || steps.length <= shown) return { earlier: 0, steps };
  return { earlier: steps.length - shown, steps: steps.slice(steps.length - shown) };
}

export type Segment = "done" | "current" | "pending";

/**
 * Honest progress (decision 101 b). With a plan of known steps: "Step 4 of 6" and one segment per plan step. Without one there
 * is no denominator to show: the count of steps done and, while it runs, an indeterminate current-step mark — never an invented
 * total or a percentage.
 */
export type RunProgress = { kind: "plan"; label: string; segments: Segment[] } | { kind: "count"; label: string; live: boolean } | { kind: "none" };

export function runProgress(plan: readonly PlanEntry[] | null | undefined, steps: readonly Pick<RunStep, "state">[], status: AgentStatus): RunProgress {
  const running = status === "running";
  if (plan && plan.length > 0) {
    const total = plan.length;
    const done = plan.filter((e) => e.status === "completed").length;
    const segments = plan.map<Segment>((e) => (e.status === "completed" ? "done" : e.status === "in_progress" ? "current" : "pending"));
    if (!running) {
      // A finished run's plan is a record: no "current" segment, and the label says how much of it got done.
      const settled = segments.map<Segment>((s) => (s === "done" ? "done" : "pending"));
      if (status === "completed" && done === total) return { kind: "plan", label: `All ${total} steps done`, segments: settled };
      return { kind: "plan", label: `${done} of ${total} steps done`, segments: settled };
    }
    const at = plan.findIndex((e) => e.status === "in_progress");
    const step = at >= 0 ? at + 1 : Math.min(done + 1, total);
    return { kind: "plan", label: `Step ${step} of ${total}`, segments };
  }
  const done = steps.filter((s) => s.state !== "running").length;
  if (done === 0 && !running) return { kind: "none" };
  const word = done === 1 ? "step" : "steps";
  return { kind: "count", label: running ? `${done} ${word} done` : `${done} ${word}`, live: running };
}

/** What the card offers (decision 101 d). No pause: the harness cannot pause and resume an agent. */
export type RunAction = "needs" | "stop" | "open";

export function runActions(a: { status: AgentStatus; waiting: boolean; canStop: boolean; canOpen: boolean }): RunAction[] {
  const out: RunAction[] = [];
  const running = a.status === "running";
  if (running && a.waiting) out.push("needs");
  if (running && a.canStop) out.push("stop");
  if (a.canOpen) out.push("open");
  return out;
}

/** The first sentence-sized line of a result, without Markdown's marks (the outcome as the card's title). */
export function outcomeLine(result: string | null | undefined): string {
  const line = firstLine(result ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  return line.replace(/:$/, "");
}

/**
 * The card's title (decision 101 a): what happens now while the agent runs (the activity line's own words; what it waits for
 * from the person wins), the outcome once it ended.
 */
export function runTitle(a: {
  status: AgentStatus;
  waitText: string | null;
  activity: string;
  result: string | null | undefined;
  failure: string | null;
  interrupted: boolean;
}): string {
  switch (a.status) {
    case "running":
      return a.waitText ?? a.activity;
    case "completed":
      return outcomeLine(a.result) || "Finished";
    case "failed":
      return a.failure ?? "This agent failed.";
    case "cancelled":
      return a.interrupted ? "Interrupted" : "Stopped";
    default:
      return "Not started";
  }
}

/** A router's escalation: the retry's `route_reason` starts "Retried on <choice> after <why>." (harness `delegation.go`). */
export function escalation(reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim();
  if (!text.startsWith("Retried on ")) return null;
  const end = text.indexOf(". ");
  return end > 0 ? text.slice(0, end + 1) : text;
}

/**
 * The short route reason the meta line shows: an escalation's own sentence, else the router's reason's first sentence; null
 * when the router did not choose (an explicit tier).
 */
export function routeShort(a: { route_choice?: string | null; route_reason?: string | null }): string | null {
  if (!a.route_choice) return null;
  const esc = escalation(a.route_reason);
  if (esc) return esc;
  const text = (a.route_reason ?? "").trim();
  if (!text) return null;
  const end = text.indexOf(". ");
  return end > 0 ? text.slice(0, end + 1) : text;
}

/**
 * The "waiting on" rule (decision 101 e): while the orchestrator waits on a round of agents, the running ones open as cards in
 * place — each one when it waits on at most two, else only the first (the rest stay compact rows).
 */
export function waitedCards(agents: readonly { id: string; running: boolean }[], waiting: boolean): Set<string> {
  if (!waiting) return new Set();
  const running = agents.filter((a) => a.running).map((a) => a.id);
  return new Set(running.length <= 2 ? running : running.slice(0, 1));
}
