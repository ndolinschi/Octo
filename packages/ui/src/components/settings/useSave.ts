import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** How long "Saved" stays under a row after a change. */
const SAVED_FOR_MS = 2400;

/** One row's save cycle: saving → "Saved" (for a moment) or the error, which stays until the next change. */
export function useSave(): [SaveState, (work: () => Promise<unknown>) => Promise<boolean>] {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    window.clearTimeout(timer.current);
    setState({ kind: "saving" });
    try {
      await work();
      setState({ kind: "saved" });
      timer.current = window.setTimeout(() => setState({ kind: "idle" }), SAVED_FOR_MS);
      return true;
    } catch (e) {
      setState({ kind: "error", message: `${errorMessage(e).replace(/\.$/, "")}. Nothing was changed; try again.` });
      return false;
    }
  }, []);
  return [state, run];
}
