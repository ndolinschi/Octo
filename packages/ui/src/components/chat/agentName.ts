import { useCallback, useEffect, useState } from "react";
import { agentLabelOf } from "../../lib/errors/words";
import { parseAcp } from "../../lib/models";
import { useActivity } from "../../state/activity";
import { useAcpNames } from "../../state/models";

/**
 * An ACP agent's name and login state, for the transcript, the composer and the failed start. Kept out of `Transcript` so the
 * eager composer does not pull the transcript (its own chunk, `transcriptPart`) into the entry.
 */

/** The login hint of the ACP agent an `acp:` setting names, when the plugins report it logged out (or give a hint); `recheck` reads it again. */
export function useLoginHint(model: string | null): { hint: string | null; recheck(): void } {
  const activity = useActivity();
  const id = model?.startsWith("acp:") ? model.slice(4).split("/")[0] : undefined;
  const [hint, setHint] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    activity.plugins().then(
      (plugins) => {
        const a = plugins.flatMap((p) => p.agents).find((x) => x.id === id);
        if (alive) setHint(a && a.logged_in !== true && a.hint ? a.hint : null);
      },
      // Unreadable plugin list: the notice keeps its own text and "Check again" asks once more.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [activity, id, round]);
  const recheck = useCallback(() => setRound((n) => n + 1), []);
  return { hint: id ? hint : null, recheck };
}

/** The provider id of an `acp:` model setting, undefined for a plain model. */
export function providerIdOf(model: string | null | undefined): string | undefined {
  return model ? parseAcp(model)?.id : undefined;
}

/** The label of the agent a model setting names (decision 94e): never its id. Null for a plain model. */
export function useAgentName(model: string | null | undefined): string | undefined {
  const acp = useAcpNames();
  const ref = model ? parseAcp(model) : null;
  if (!ref) return undefined;
  return acp.find((a) => a.id === ref.id)?.label ?? agentLabelOf(ref.id);
}
