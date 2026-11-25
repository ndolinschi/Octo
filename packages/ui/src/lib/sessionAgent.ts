import { agentLabelOf } from "./errors/words";
import { modelName, parseAcp, type AcpName } from "./models";

/**
 * Who runs a session, for its row (shell polish, item 7): an `acp:` agent by its label alone ("Claude Code", never the id:
 * decision 94e), Octo's own loop by its model ("Opus 5.5"); null when the session names no model. Its own module: only the
 * sidebar's and Home's chunks use it, and `lib/models` loads with the app.
 */
export function sessionAgentName(model: string, acp: readonly AcpName[] = []): string | null {
  if (model.trim() === "") return null;
  const ref = parseAcp(model);
  return ref ? (acp.find((a) => a.id === ref.id)?.label ?? agentLabelOf(ref.id)) : modelName(model, acp);
}
