import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { dedupeHits, groupHits, noteHits, searchable, toUiHit, type HitGroup, type UiHit } from "../../lib/memory/search";
import { useApp } from "../../state/app";

export type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; groups: HitGroup[]; count: number; capped: boolean; message: string | undefined };

type Settled = { key: string; state: SearchState };

const DEBOUNCE_MS = 200;

/**
 * One search over everything (decision 93 b): the harness's memory search (exchanges, requests, tasks, facts, files) plus the
 * project's notes, filtered here because the harness does not search them. Sent 200 ms after typing stops, from two
 * characters on. A slow answer for an older query never replaces a newer one (the state is keyed by its query).
 */
export function useMemorySearch(projectId: string, query: string): SearchState {
  const { bridge } = useApp();
  const q = query.trim();
  const [settled, setSettled] = useState<Settled | null>(null);
  const search = bridge.searchMemory;
  const listNotes = bridge.listNotes;
  useEffect(() => {
    if (!searchable(q) || !search) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const key = `${projectId}|${q}`;
      Promise.all([search.call(bridge, projectId, { q }), listNotes.call(bridge, projectId).catch(() => [])]).then(
        ([result, notes]) => {
          if (!live) return;
          const hits: UiHit[] = dedupeHits([...result.hits.map((h) => toUiHit(h, q)), ...noteHits(notes, q)]);
          setSettled({ key, state: { status: "ok", groups: groupHits(hits), count: hits.length, capped: result.hits.length >= 10, message: result.message } });
        },
        (e: unknown) => live && setSettled({ key, state: { status: "error", message: errorMessage(e) } }),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // `bridge` and the two methods do not change while a query is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [projectId, q]);
  if (!searchable(q) || !search) return { status: "idle" };
  return settled?.key === `${projectId}|${q}` ? settled.state : { status: "loading" };
}
