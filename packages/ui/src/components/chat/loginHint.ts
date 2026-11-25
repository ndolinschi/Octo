import { useCallback, useEffect, useState } from "react";
import { parseAcp } from "../../lib/models";
import { useActivity } from "../../state/activity";

/**
 * Login hint and provider id of an `acp:` model setting. Kept out of `agentName.ts` so the eager composer does not pull
 * `useActivity` and login probing into the entry chunk (only lazy `Transcript` and `StartFailure` read these).
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
