import { useCallback, useEffect, useRef, useState } from "react";
import type { Review, ReviewComment, ReviewFile, ReviewFileDiff, ReviewFiles, ReviewFinding } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { LruCache } from "../../lib/lru";
import type { ReviewApi } from "../../lib/review/api";
import { useProject } from "../../state/project";

export type ReviewData = { review: Review; files: ReviewFiles; comments: ReviewComment[]; findings: ReviewFinding[] };
async function loadAll(api: ReviewApi, id: string): Promise<ReviewData> {
  const [review, files, comments, findings] = await Promise.all([api.get(id), api.files(id), api.comments(id), api.findings(id)]);
  return { review, files, comments: comments.filter((c) => c.state === "pending"), findings };
}

export type ReviewLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ReviewData };

/**
 * One review's data: the review, its files in reading order, pending comments and findings. `review.updated` events of
 * this review reload it quietly (no loading state), so a change from elsewhere shows without flicker.
 */
export function useReview(api: ReviewApi, id: string) {
  const [done, setDone] = useState<{ req: string; load: ReviewLoad } | null>(null);
  const [key, setKey] = useState(0);
  const req = `${id}:${key}`;
  const load: ReviewLoad = done?.req === req ? done.load : { status: "loading" };
  const { onEvent } = useProject();
  const seq = useRef(0);

  // The first load of a request (and its retry) reports loading and errors; later quiet reloads only replace the data.
  useEffect(() => {
    let alive = true;
    loadAll(api, id).then(
      (data) => alive && setDone({ req, load: { status: "ready", data } }),
      (e: unknown) => alive && setDone({ req, load: { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [api, id, req]);

  const fetchAll = useCallback(async () => {
    const n = ++seq.current;
    try {
      const data = await loadAll(api, id);
      if (n === seq.current) setDone({ req, load: { status: "ready", data } });
    } catch {
      // A failed quiet reload keeps what is on screen; the next action or event tries again, and writes report their own errors.
    }
  }, [api, id, req]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "review.updated" && e.review_id === id) void fetchAll();
      }),
    [onEvent, id, fetchAll],
  );

  const patch = useCallback(
    (fn: (d: ReviewData) => ReviewData) => setDone((d) => (d?.load.status === "ready" ? { req: d.req, load: { status: "ready", data: fn(d.load.data) } } : d)),
    [],
  );
  const retry = useCallback(() => setKey((k) => k + 1), []);
  return { load, patch, retry, reload: fetchAll };
}

export type DiffOptions = { context: number; ignoreWhitespace: boolean; since: string | undefined };
export type DiffLoad = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; diff: ReviewFileDiff };

const REVIEW_DIFF_CACHE_MAX = 80;

/** The diff of the selected file; reloads when the file, the options or the review's head change. */
export function useFileDiff(api: ReviewApi, id: string, path: string | null, o: DiffOptions, head: string) {
  const [cache] = useState(() => new LruCache<string, ReviewFileDiff>(REVIEW_DIFF_CACHE_MAX));
  const [done, setDone] = useState<{ req: string; path: string; load: DiffLoad } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const { context, ignoreWhitespace, since } = o;
  const cacheKey = `${id}|${path}|${context}|${ignoreWhitespace}|${since ?? ""}|${head}`;
  const req = `${cacheKey}|${retryKey}`;
  const cached = path !== null ? cache.peek(cacheKey) : undefined;
  useEffect(() => {
    if (path === null) return;
    if (cache.has(cacheKey)) {
      cache.get(cacheKey);
      return;
    }
    let alive = true;
    api.diff(id, path, { context, ignoreWhitespace, ...(since ? { since } : {}) }).then(
      (diff) => {
        cache.set(cacheKey, diff);
        if (alive) setDone({ req, path, load: { status: "ready", diff } });
      },
      (e: unknown) => alive && setDone({ req, path, load: { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [api, cache, id, path, context, ignoreWhitespace, since, cacheKey, req]);
  const retry = useCallback(() => {
    cache.delete(cacheKey);
    setRetryKey((k) => k + 1);
  }, [cache, cacheKey]);
  // Cached diffs return synchronously (no loading flash / Monaco unmount); an option change keeps the previous diff of the same file on screen until the new one is in.
  const state: DiffLoad =
    path === null
      ? { status: "idle" }
      : cached !== undefined
        ? { status: "ready", diff: cached }
        : done?.req === req
          ? done.load
          : done?.path === path
            ? done.load
            : { status: "loading" };
  return { state, retry };
}

/** Merges one updated file into the file list. */
export function withFile(files: ReviewFiles, f: ReviewFile): ReviewFiles {
  const next = files.files.map((x) => (x.path === f.path ? f : x));
  return { ...files, files: next, viewed_count: next.filter((x) => x.viewed).length };
}
