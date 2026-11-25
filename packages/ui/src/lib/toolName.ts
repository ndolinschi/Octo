// The two things the transcript builder needs at first paint; the rest of the tool vocabulary (`tools.ts`) loads with the tool lines.

export const SPAWN_TOOL = "spawn_agent";

/** The harness tools an ACP orchestrator calls over MCP (`mcp__octo-harness__spawn_agent`, `octo-harness:save_note`). */
const MCP_TOOL = /^(?:mcp__[\w.-]+__|[\w.-]+:)(spawn_agent|save_note|delete_note|list_dir)$/;

/**
 * A tool name as the UI treats it: a harness tool reached through MCP reads as the built-in one, so older transcripts
 * still render the delegation card and the note rows (the harness normalises new rows itself).
 */
export function harnessTool(name: string): string {
  return MCP_TOOL.exec(name)?.[1] ?? name;
}
