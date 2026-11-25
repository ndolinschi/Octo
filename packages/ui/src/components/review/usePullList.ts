import { useCallback, useEffect, useRef, useState } from "react";
import type { PullRequestList, ReviewSummary } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import type { ReviewApi } from "../../lib/review/api";
import { createListCache, mergePages } from "../../lib/review/pullList";
import { useProject } from "../../state/project";

/** Kept for the window's lifetime: the picker paints the last list at once when it opens again (decision 77). */
const cache = createListCache();
const CHUNK_SIZE = 30;
/** If the harness said "stale" and `review.list_updated` never comes, ask once more after this long. */
const STALE_RETRY_MS = 8000;

export type PullListState = {
  list: PullRequestList | null;
  open: ReviewSummary[];
  /** First load with nothing cached: show skeleton rows. */
  loading: boolean;
  /** The request number whose answer is in; a refresh is under way while it is behind the current one. */
  settled: number;
  /** The harness answered from a stale cache and is refreshing it. */
  stale: boolean;
  /** The load failed and nothing is cached to show. */
  error: string | null;
};

/**
 * The picker's data: the cached list for the folder at once, then a quiet first-chunk refresh in place.
 * Additional chunks are loaded on demand via `loadMore()`. `review.list_updated` reloads without clearing anything;
 * `reload()` asks the code host now.
 */
export function usePullList(api: ReviewApi, folder: string, repo?: string) {
  const key = `${folder}|${repo ?? ""}`;
  const { onEvent } = useProject();
  const [state, setState] = useState<PullListState>(() => {
    const cached = cache.read(key);
    return { list: cached ?? null, open: [], loading: cached === undefined, settled: -1, stale: false, error: null };
  });
  const [tick, setTick] = useState({ n: 0, refresh: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const curGen = ++gen.current;
    let alive = true;
    let retry = 0;
    setLoadingMore(false);
    setLoadMoreError(null);
    // The open reviews are an extra: when they fail the pull requests still list.
    const open = api.listOpen().catch((): ReviewSummary[] => []);
    api
      .listPullRequests({
        ...(folder ? { folder } : {}),
        ...(repo ? { repo } : {}),
        filter: "all",
        page: 1,
        per_page: CHUNK_SIZE,
        ...(tick.refresh ? { refresh: true } : {}),
      })
      .then(
        async (list) => {
          const o = await open;
          if (!alive || gen.current !== curGen) return;
          cache.write(key, list);
          setState({ list, open: o, loading: false, settled: tick.n, stale: list.stale === true, error: null });
          if (list.stale) retry = window.setTimeout(() => alive && setTick((t) => ({ n: t.n + 1, refresh: false })), STALE_RETRY_MS);
        },
        // B2 (polish pass F3): a failed list still shows the reviews in progress (they are the local service's, not GitHub's).
        async (e: unknown) => {
          const o = await open;
          if (alive && gen.current === curGen)
            setState((s) => ({ ...s, open: o, loading: false, settled: tick.n, stale: false, error: s.list ? null : errorMessage(e) }));
        },
      );
    return () => {
      alive = false;
      window.clearTimeout(retry);
    };
  }, [api, folder, repo, key, tick]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "review.list_updated") setTick((t) => ({ n: t.n + 1, refresh: false }));
      }),
    [onEvent],
  );

  const loadMore = useCallback(() => {
    const cur = state.list;
    if (!cur?.available || cur.next_page == null || loadingMore) return;
    const curGen = gen.current;
    const nextPage = cur.next_page;
    setLoadingMore(true);
    setLoadMoreError(null);
    api
      .listPullRequests({
        ...(folder ? { folder } : {}),
        ...(repo ? { repo } : {}),
        filter: "all",
        page: nextPage,
        per_page: CHUNK_SIZE,
      })
      .then(
        (next) => {
          if (gen.current !== curGen) return;
          setLoadingMore(false);
          setState((s) => {
            if (!s.list) return s;
            const merged = mergePages([s.list, next]);
            if (!merged) return s;
            cache.write(key, merged);
            return { ...s, list: merged, stale: merged.stale === true };
          });
        },
        (e: unknown) => {
          if (gen.current !== curGen) return;
          setLoadingMore(false);
          setLoadMoreError(errorMessage(e));
        },
      );
  }, [api, folder, repo, key, state.list, loadingMore]);

  const reload = useCallback(() => setTick((t) => ({ n: t.n + 1, refresh: true })), []);
  const updating = state.settled !== tick.n || state.stale;
  return { state, updating, reload, loadMore, loadingMore, loadMoreError };
}
