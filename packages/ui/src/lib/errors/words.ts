// Small and apart from `plain.ts` so the model names (first paint) do not pull the whole error mapping into the entry bundle.

/** "claude-code" → "Claude Code": the label of an agent whose provider entry is not at hand (never the id, decision 94e). */
const KNOWN: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  copilot: "GitHub Copilot",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
};
export function agentLabelOf(id: string): string {
  const known = KNOWN[id];
  if (known) return known;
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    .join(" ");
}

/**
 * R2: the product's inside words, which the person never reads either (the copy glossary: "Octo's local service", "Octo",
 * "copy of the code"). A test-side rule: `JARGON` decides at run time whether a harness message is shown as it came, and a
 * message that only names the harness should still be shown. Not matched: a command or path in backticks or after a slash
 * or dot (`harness doctor`, apps/harness), and the "Harness version" label of the diagnostics.
 */
export const INSIDE_WORDS = /(?<![`/.\w-])(harness|bridge|orchestrators?|worktrees?)(?![`/\w-]|\.\w|\sversion)/i;

/** Words the person never reads (decision 94b); `plain.test.ts` runs every produced string through this. */
export const JARGON =
  /\b(ACP|MCP|JSON-?RPC|stderr|stdout|exit(?:ed)? (?:with )?(?:status|code)|errno|EPIPE|ECONN\w*)\b|\b[a-z]+\/[a-z_]+\b|\b[a-z]+_[a-z_]+\b/i;
