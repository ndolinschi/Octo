/**
 * Walk B13: what each tool tab is for, in one line a newcomer understands. The panels show it behind the (i) after their
 * title (on the phone: "About this panel" in the header's "⋯"), the tabs as their tooltip (`dock/tabInfo`), and the palette
 * searches it (with `TOOL_HINT` in `state/workspace/paletteCommands.ts` as the row's detail): one source.
 */
export const TOOL_PURPOSE = {
  sessions: "Your sessions with Octo, and the agents it started.",
  agents: "Every agent working in this project: what it is doing, on which model, and what it has cost.",
  notes: "Decisions and facts saved while working. Agents read them when they are relevant.",
  files: "The project's folders. Open a file to read or edit it.",
  browser: "Preview your running app or any URL, pick elements, edit CSS or text live, and send annotated screenshots to Chat.",
  terminal: "Interactive shell in the project's folders: run CLIs, git, tests or REPLs.",
  processes: "Running commands, dev servers and background workers: inspect output, stop, kill or restart them.",
  details: "Folders, models, usage, activity and the files agents wrote.",
  changes: "What the agents changed in this project, with each diff and a way to revert it.",
  review: "Read a pull request or a local branch, comment on it, and submit your review.",
  memory: "What Octo remembers about this project, and what it can look up.",
  usage: "Tokens, cost and usage limits, by model, agent, project or day.",
  side: "Ask about this project without interrupting Octo. Nothing here is added to the session.",
} as const satisfies Record<string, string>;

export type PurposeTool = keyof typeof TOOL_PURPOSE;
