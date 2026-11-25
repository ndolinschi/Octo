import { agentLabelOf } from "../../lib/errors/words";
import { parseAcp } from "../../lib/models";
import { useAcpNames } from "../../state/models";

/**
 * An ACP agent's display label, for the composer and transcript. Kept tiny so the eager composer does not pull
 * `Transcript` or `useActivity` login probing (`loginHint.ts`) into the entry chunk.
 */

/** The label of the agent a model setting names (decision 94e): never its id. Null for a plain model. */
export function useAgentName(model: string | null | undefined): string | undefined {
  const acp = useAcpNames();
  const ref = model ? parseAcp(model) : null;
  if (!ref) return undefined;
  return acp.find((a) => a.id === ref.id)?.label ?? agentLabelOf(ref.id);
}
