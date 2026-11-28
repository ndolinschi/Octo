import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeDetail, FileChangeSummary, RevertResult, TurnChanges } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { useLatest } from "../../lib/hooks";
import { LruCache } from "../../lib/lru";
import { netDiff, netIds, revertOrder, revertProblem, rowKey, type NetDiff, type RevertProblem } from "../../lib/v7/changes";

const CHANGES_CACHE_MAX = 120;

/** The bridge calls the changes view needs, bound to one project (`listChanges`, `getChange`, `revertChange`). */
export type ChangesApi = {
  listChanges(): Promise<TurnChanges[]>;
  getChange(id: number): Promise<ChangeDetail>;
  revertChange(id: number): Promise<RevertResult>;
};

export type TurnsState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; turns: TurnChanges[] };
export type DiffState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & NetDiff);
/** A file the conversation asked for ("Open diff"); `seq` tells a repeated request from the one already shown. */
export type FocusFile = { folder: string; path: string; seq: number };
export type Selection = { turnId: number; file: FileChangeSummary };
/** Per file row: reverted, or why not. */
export type RowState = { reverting: true } | { reverted: true } | { problem: RevertProblem };

/**
 * Data and actions of the changes view: the turns (reloaded when `refreshKey` changes, i.e. on `change.recorded`), the
 * selected file's net diff (first before → last after, details cached in a bounded LRU), and reverts per file and per
 * turn (newest change first; one file's failure does not stop the others).
 */
export function useChanges(api: ChangesApi, refreshKey: number, focusTurn: number | null, focusFile: FocusFile | null = null) {
  const [turns, setTurns] = useState<TurnsState>({ status: "loading" });
  const [picked, setPicked] = useState<{ turnId: number; key: string; seq: number } | null>(null);
  const [asyncDiff, setAsyncDiff] = useState<{ pair: string; state: DiffState } | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [flash, setFlash] = useState(0);
  const inflight = useRef(new Map<number, Promise<ChangeDetail>>());
  const [resolved] = useState(() => new LruCache<number, ChangeDetail>(CHANGES_CACHE_MAX));
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    setTurns((t) => (t.status === "ready" ? t : { status: "loading" }));
    api.listChanges().then(
      (list) => alive && setTurns({ status: "ready", turns: focusTurn === null ? list : list.filter((t) => t.turn_id === focusTurn) }),
      (e: unknown) => alive && setTurns({ status: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [api, refreshKey, reloads, focusTurn]);

  const all = turns.status === "ready" ? turns.turns.flatMap((t) => t.files.map((file) => ({ turnId: t.turn_id, file }))) : [];
  // A pick made before the latest focus request gives way to it; a pick made after wins.
  const seq = focusFile?.seq ?? 0;
  const pickedNow = picked !== null && picked.seq === seq ? picked : null;
  const focused = focusFile ? all.find((s) => s.file.folder === focusFile.folder && s.file.path === focusFile.path) : undefined;
  const selected: Selection | null =
    all.find((s) => pickedNow !== null && s.turnId === pickedNow.turnId && rowKey(s.turnId, s.file) === pickedNow.key) ?? focused ?? all[0] ?? null;
  const selectedKey = selected ? rowKey(selected.turnId, selected.file) : null;

  const detail = useCallback(
    (id: number) => {
      const hit = resolved.get(id);
      if (hit) return Promise.resolve(hit);
      let p = inflight.current.get(id);
      if (!p) {
        p = api.getChange(id).then(
          (d) => {
            resolved.set(id, d);
            inflight.current.delete(id);
            return d;
          },
          (err: unknown) => {
            inflight.current.delete(id);
            throw err;
          },
        );
        inflight.current.set(id, p);
      }
      return p;
    },
    [api, resolved],
  );

  const ids = selected ? netIds(selected.file) : null;
  const first = ids?.first ?? null;
  const last = ids?.last ?? null;
  const pairKey = first !== null && last !== null ? `${first}:${last}` : null;
  // When both change details are already in `resolved`, compute the net diff synchronously so switching files
  // never flashes "loading" or unmounts/recreates the Monaco DiffEditor.
  const cachedA = first !== null ? resolved.peek(first) : undefined;
  const cachedB = last !== null ? resolved.peek(last) : undefined;
  const cachedDiff: DiffState | null = selected && cachedA && cachedB ? { status: "ready", ...netDiff(selected.file, cachedA, cachedB) } : null;

  // The file object changes on every reload; the diff is keyed by its first and last change, the file read when loading.
  const fileRef = useLatest(selected?.file ?? null);
  const [diffTries, setDiffTries] = useState(0);
  useEffect(() => {
    if (first === null || last === null || pairKey === null) return;
    if (resolved.has(first) && resolved.has(last)) {
      // Refresh LRU recency for both entries.
      resolved.get(first);
      resolved.get(last);
      return;
    }
    let alive = true;
    Promise.all([detail(first), detail(last)]).then(
      ([a, b]) => {
        const file = fileRef.current;
        if (!alive || !file) return;
        setAsyncDiff({ pair: pairKey, state: { status: "ready", ...netDiff(file, a, b) } });
        setFlash((n) => n + 1);
      },
      (e: unknown) => alive && setAsyncDiff({ pair: pairKey, state: { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [detail, resolved, first, last, pairKey, diffTries, fileRef]);

  // Background-prefetch adjacent files so stepping to the next/previous file hits `resolved` synchronously.
  const selectedIndex = selected ? all.findIndex((s) => s.turnId === selected.turnId && s.file === selected.file) : -1;
  const nextItem = selectedIndex >= 0 ? all[selectedIndex + 1] : undefined;
  const prevItem = selectedIndex > 0 ? all[selectedIndex - 1] : undefined;
  const nextIds = nextItem ? netIds(nextItem.file) : null;
  const prevIds = prevItem ? netIds(prevItem.file) : null;
  const nextFirst = nextIds?.first ?? null;
  const nextLast = nextIds?.last ?? null;
  const prevFirst = prevIds?.first ?? null;
  const prevLast = prevIds?.last ?? null;
  useEffect(() => {
    for (const id of [nextFirst, nextLast, prevFirst, prevLast]) {
      if (id !== null && !resolved.has(id)) void detail(id).catch(() => undefined);
    }
  }, [detail, resolved, nextFirst, nextLast, prevFirst, prevLast]);

  const diff: DiffState = cachedDiff ?? (pairKey !== null && asyncDiff?.pair === pairKey ? asyncDiff.state : { status: "loading" });

  const revertFile = useCallback(
    async (turnId: number, f: FileChangeSummary): Promise<boolean> => {
      const key = rowKey(turnId, f);
      setRows((r) => ({ ...r, [key]: { reverting: true } }));
      try {
        for (const id of revertOrder(f)) await api.revertChange(id);
        setRows((r) => ({ ...r, [key]: { reverted: true } }));
        if (key === selectedKey) setFlash((n) => n + 1);
        return true;
      } catch (e) {
        setRows((r) => ({ ...r, [key]: { problem: revertProblem(e) } }));
        return false;
      }
    },
    [api, selectedKey],
  );

  const revertTurn = useCallback(
    async (turn: TurnChanges) => {
      let failed = 0;
      for (const f of [...turn.files].reverse()) {
        const key = rowKey(turn.turn_id, f);
        if (rows[key] && "reverted" in rows[key]) continue;
        if (!(await revertFile(turn.turn_id, f))) failed++;
      }
      return failed;
    },
    [revertFile, rows],
  );

  return {
    turns,
    selected,
    selectedKey,
    select: (s: Selection) => setPicked({ turnId: s.turnId, key: rowKey(s.turnId, s.file), seq }),
    all,
    diff,
    retryDiff: () => setDiffTries((n) => n + 1),
    reload: () => setReloads((n) => n + 1),
    rows,
    flash,
    revertFile,
    revertTurn,
  };
}
