import type { PurposeTool } from "./toolPurpose";

/**
 * The tool purposes (`toolPurpose`), short: the detail of the palette's "Show …" rows (lowercase, no full stop). Only the palette
 * (a lazy chunk) reads them, so they live apart from `toolPurpose`, which the entry imports (the bundler hoists a module whole).
 */
export const TOOL_HINT = {
  sessions: "sessions and their agents",
  agents: "what each agent is doing",
  notes: "decisions and facts agents read",
  files: "folders; open a file to read or edit",
  browser: "preview pages and annotate elements for Chat",
  terminal: "interactive shell in the project",
  processes: "running commands, logs, kill or restart",
  details: "folders, models, tokens, activity",
  changes: "what the agents changed",
  review: "pick one, read it, comment, submit",
  memory: "what the project remembers",
  usage: "tokens, cost, limits",
  side: "not added to the conversation",
} as const satisfies Record<PurposeTool, string>;
