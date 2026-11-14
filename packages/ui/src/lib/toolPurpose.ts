/**
 * Walk B13: what each tool tab is for, in one line a newcomer understands. The panels show it behind the (i) after their
 * title; the palette searches it (with `TOOL_HINT` as the row's detail), so both say the same thing (one source).
 */
export const TOOL_PURPOSE = {
  sessions: "Your conversations with the orchestrator, and the agent sessions it started.",
  agents: "Every agent working in this project: what it is doing, on which model, and what it has cost.",
  notes: "Decisions and facts saved while working. Agents read them when they are relevant.",
  files: "The project's folders. Open a file to read or edit it.",
  details: "This project at a glance: its folders, models, tokens, activity and the files agents wrote.",
  changes: "What the agents changed in this project, with each diff and a way to revert it.",
  review: "Read a pull request or a local branch, comment on it, and submit your review.",
  memory: "What the orchestrator remembers about this project, and what it can look up.",
  usage: "Tokens, cost and rate limits, by model, agent, project or day.",
  side: "Ask about this project without interrupting the work. Nothing here is added to the conversation.",
} as const satisfies Record<string, string>;

export type PurposeTool = keyof typeof TOOL_PURPOSE;

/** The same purposes, short: the detail of the palette's "Show …" rows (lowercase, no full stop). */
export const TOOL_HINT = {
  sessions: "conversations and agent sessions",
  agents: "what each agent is doing",
  notes: "decisions and facts agents read",
  files: "folders; open a file to read or edit",
  details: "folders, models, tokens, activity",
  changes: "what the agents changed",
  review: "pick one, read it, comment, submit",
  memory: "what the project remembers",
  usage: "tokens, cost, limits",
  side: "not added to the conversation",
} as const satisfies Record<PurposeTool, string>;
