import type { AgentActivity, Message } from "@octo/agent-client";
import { acpCall, toolMeta } from "../../lib/tools";

/** Decision 55 e: with nothing at all for this long, the line says so instead of staying mute. */
export const QUIET_MS = 10_000;

export type ActivityInput = {
  /** The harness's `agent.activity` for this agent, when it sends one. */
  activity: AgentActivity | undefined;
  /** The newest tool call of this agent that has no result yet. */
  runningTool: { name: string; input: unknown } | null;
  /** Text is streaming right now. */
  writing: boolean;
  /** Reasoning is streaming right now. */
  thinking: boolean;
  /** Roles of this agent's sub-agents that are running. */
  waitingOn: string[];
  /** Milliseconds since the last sign of life (any event for this agent). */
  quietMs: number;
  /** The agent's name for the quiet line ("Claude Code", "the orchestrator"). */
  agentName: string;
};

export type ActivityLine = { kind: "thinking" | "tool" | "text" | "waiting" | "approval" | "quiet"; label: string };

const quoted = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** "Reading src/x.ts", "Running `pnpm test`", "Searching for "budget"" — from a tool call that has started. */
export function toolActivity(name: string, input: unknown): string {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const acp = acpCall(name, input);
  if (acp) {
    const title = acp.title.trim();
    if (name === "execute") return title ? `Running ${quoted(title)}` : "Running a command";
    return title || "Using a tool";
  }
  const arg = toolMeta(name, input).arg;
  switch (name) {
    case "read_file":
      return arg ? `Reading ${arg}` : "Reading a file";
    case "list_dir":
      return arg && arg !== "." ? `Listing ${arg}` : "Listing the folder";
    case "write_file":
      return arg ? `Writing ${arg}` : "Writing a file";
    case "bash":
      return typeof record.command === "string" && record.command.trim()
        ? `Running ${quoted(record.command.trim().split("\n")[0] ?? "")}`
        : "Running a command";
    case "search":
    case "grep":
      return typeof record.query === "string" || typeof record.pattern === "string" ? `Searching for “${String(record.query ?? record.pattern)}”` : "Searching";
    case "save_note":
      return "Saving a note";
    case "spawn_agent":
      return typeof record.role === "string" && record.role ? `Starting ${record.role}` : "Starting an agent";
    default:
      return `Using ${name}`;
  }
}

/**
 * The live activity line (decision 55 a): what is happening now, never just "Working…". The harness's own label wins;
 * until it sends one, the label comes from what the transcript already shows (a running tool, streaming text, waiting
 * sub-agents). Ten quiet seconds say so.
 */
export function activityLine(input: ActivityInput): ActivityLine {
  const a = input.activity;
  if (a) {
    switch (a.kind) {
      case "tool":
        if (a.label) return { kind: "tool", label: a.label };
        break;
      case "thinking":
        return { kind: "thinking", label: "Thinking…" };
      case "text":
        return { kind: "text", label: "Writing…" };
      case "waiting_approval":
        return { kind: "approval", label: a.label || "Waiting for your approval" };
      case "quiet":
        return { kind: "quiet", label: `Still working — no output from ${input.agentName} yet` };
      case "idle":
        break;
    }
  }
  if (input.waitingOn.length) return { kind: "waiting", label: `Waiting on ${input.waitingOn.join(", ")}` };
  if (input.runningTool) return { kind: "tool", label: toolActivity(input.runningTool.name, input.runningTool.input) };
  if (input.writing) return { kind: "text", label: "Writing…" };
  if (input.thinking) return { kind: "thinking", label: "Thinking…" };
  if (input.quietMs >= QUIET_MS) return { kind: "quiet", label: `Still working — no output from ${input.agentName} yet` };
  return { kind: "thinking", label: "Thinking…" };
}

/**
 * Whether the live line under a turn adds anything. Not when the newest row above already shows that step (`current`), and
 * not "Writing…" while streamed text is on screen: its caret already says it, and a spinner row under the text moved down
 * with every new line (two indicators for one thing).
 */
export function showsActivityLine(line: ActivityLine, current: ActivityLine["kind"] | null, streaming: boolean): boolean {
  if (current !== null && line.kind === current) return false;
  return !(line.kind === "text" && streaming);
}

/** The newest tool call in `messages` that has no result yet (the one running now), if any. */
export function runningToolOf(messages: readonly Message[]): { id: string; name: string; input: unknown } | null {
  const answered = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    for (const b of m.content) if (b.type === "tool_result") answered.add(b.tool_use_id);
    if (m.role !== "assistant") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b?.type === "tool_use" && !answered.has(b.id)) return { id: b.id, name: b.name, input: b.input };
    }
    // Only the newest assistant message can hold a call still running.
    return null;
  }
  return null;
}

/** Splits a label on backticks: odd parts are code (a command), shown in mono. */
export function labelParts(label: string): { text: string; code: boolean }[] {
  return label
    .split("`")
    .map((text, i) => ({ text, code: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}
