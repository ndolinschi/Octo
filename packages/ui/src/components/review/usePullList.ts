import { useCallback, useEffect, useState } from "react";
import type { PullRequestList, ReviewSummary } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import type { ReviewApi } from "../../lib/review/api";
import { createListCache, mergePages } from "../../lib/review/pullList";
import { useProject } from "../../state/project";

/** Kept for the window's lifetime: the picker paints the last list at once when it opens again (decision 77). */
const cache = createListCache();
const PER_PAGE = 100;
const MAX_PAGES = 3;
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

async function fetchAll(api: ReviewApi, folder: string, repo: string | undefined, refresh: boolean): Promise<PullRequestList> {
  const pages: PullRequestList[] = [];
  let page = 1;
  for (;;) {
    const l = await api.listPullRequests({
      ...(folder ? { folder } : {}),
      ...(repo ? { repo } : {}),
      filter: "all",
      page,
      per_page: PER_PAGE,
      ...(refresh && page === 1 ? { refresh: true } : {}),
    });
    pages.push(l);
    if (!l.available || l.next_page == null || pages.length >= MAX_PAGES) break;
    page = l.next_page;
  }
  return mergePages(pages) ?? { host: "github", available: false, prs: [] };
}

/**
 * The picker's data: the cached list for the folder at once, then a quiet refresh in place. `review.list_updated` (the
 * harness refreshed its own cache) reloads without clearing anything; `reload()` asks the code host now.
 */
export function usePullList(api: ReviewApi, folder: string, repo?: string) {
  const key = `${folder}|${repo ?? ""}`;
  const { onEvent } = useProject();
  const [state, setState] = useState<PullListState>(() => {
    const cached = cache.read(key);
    return { list: cached ?? null, open: [], loading: cached === undefined, settled: -1, stale: false, error: null };
  });
  const [tick, setTick] = useState({ n: 0, refresh: false });

  useEffect(() => {
    let alive = true;
    let retry = 0;
    // The open reviews are an extra: when they fail the pull requests still list.
    const open = api.listOpen().catch((): ReviewSummary[] => []);
    fetchAll(api, folder, repo, tick.refresh).then(
      async (list) => {
        const o = await open;
        if (!alive) return;
        cache.write(key, list);
        setState({ list, open: o, loading: false, settled: tick.n, stale: list.stale === true, error: null });
        if (list.stale) retry = window.setTimeout(() => alive && setTick((t) => ({ n: t.n + 1, refresh: false })), STALE_RETRY_MS);
      },
      // B2 (polish pass F3): a failed list still shows the reviews in progress (they are the local service's, not GitHub's).
      async (e: unknown) => {
        const o = await open;
        if (alive) setState((s) => ({ ...s, open: o, loading: false, settled: tick.n, stale: false, error: s.list ? null : errorMessage(e) }));
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

  const reload = useCallback(() => setTick((t) => ({ n: t.n + 1, refresh: true })), []);
  const updating = state.settled !== tick.n || state.stale;
  return { state, updating, reload };
}
