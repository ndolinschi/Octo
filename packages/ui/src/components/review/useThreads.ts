import { useCallback, useEffect, useState } from "react";
import type { ReviewThreads } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import type { ReviewApi } from "../../lib/review/api";
import { useProject } from "../../state/project";

export type ThreadsLoad = { status: "none" } | { status: "loading" } | { status: "ready"; data: ReviewThreads } | { status: "error"; message: string };

/**
 * The code host's existing threads of a review. Loaded beside the review (a failure never blocks reading the diff: the
 * strip says so and offers a retry); `review.updated` with reason `threads` or `refreshed` reloads quietly.
 */
export function useThreads(api: ReviewApi, id: string) {
  const [done, setDone] = useState<{ req: string; load: ThreadsLoad } | null>(null);
  const [key, setKey] = useState(0);
  const { onEvent } = useProject();
  const req = `${id}:${key}`;
  const fetch = api.threads;

  useEffect(() => {
    if (!fetch) return;
    let alive = true;
    fetch(id, key > 0).then(
      (data) => alive && setDone({ req, load: { status: "ready", data } }),
      (e: unknown) => alive && setDone({ req, load: { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [fetch, id, req, key]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "review.updated" || e.review_id !== id || !fetch) return;
        if (e.reason !== "threads" && e.reason !== "refreshed") return;
        fetch(id).then(
          (data) => setDone((d) => ({ req: d?.req ?? req, load: { status: "ready", data } })),
          () => undefined, // a failed quiet reload keeps the threads on screen; "Refresh threads" reports its own error
        );
      }),
    [onEvent, id, fetch, req],
  );

  const load: ThreadsLoad = !fetch ? { status: "none" } : done?.req === req ? done.load : done ? done.load : { status: "loading" };
  const refresh = useCallback(() => setKey((k) => k + 1), []);
  return { load, refresh };
}
