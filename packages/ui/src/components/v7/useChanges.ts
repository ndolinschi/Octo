import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeDetail, FileChangeSummary, RevertResult, TurnChanges } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { useLatest } from "../../lib/hooks";
import { netDiff, netIds, revertOrder, revertProblem, rowKey, type NetDiff, type RevertProblem } from "../../lib/v7/changes";

/** The bridge calls the changes view needs, bound to one project (`listChanges`, `getChange`, `revertChange`). */
export type ChangesApi = {
  listChanges(): Promise<TurnChanges[]>;
  getChange(id: number): Promise<ChangeDetail>;
  revertChange(id: number): Promise<RevertResult>;
};

export type TurnsState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; turns: TurnChanges[] };
export type DiffState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & NetDiff);
export type Selection = { turnId: number; file: FileChangeSummary };
/** Per file row: reverted, or why not. */
export type RowState = { reverting: true } | { reverted: true } | { problem: RevertProblem };

/**
 * Data and actions of the changes view: the turns (reloaded when `refreshKey` changes, i.e. on `change.recorded`), the
 * selected file's net diff (first before → last after, details cached by id), and reverts per file and per turn
 * (newest change first; one file's failure does not stop the others).
 */
export function useChanges(api: ChangesApi, refreshKey: number, focusTurn: number | null) {
  const [turns, setTurns] = useState<TurnsState>({ status: "loading" });
  const [picked, setPicked] = useState<{ turnId: number; key: string } | null>(null);
  const [diff, setDiff] = useState<DiffState>({ status: "loading" });
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [flash, setFlash] = useState(0);
  const cache = useRef(new Map<number, Promise<ChangeDetail>>());
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
  const selected: Selection | null =
    all.find((s) => picked !== null && s.turnId === picked.turnId && rowKey(s.turnId, s.file) === picked.key) ?? all[0] ?? null;
  const selectedKey = selected ? rowKey(selected.turnId, selected.file) : null;

  const detail = useCallback(
    (id: number) => {
      let p = cache.current.get(id);
      if (!p) {
        p = api.getChange(id);
        cache.current.set(id, p);
        p.catch(() => cache.current.delete(id));
      }
      return p;
    },
    [api],
  );

  const ids = selected ? netIds(selected.file) : null;
  const first = ids?.first ?? null;
  const last = ids?.last ?? null;
  // The file object changes on every reload; the diff is keyed by its first and last change, the file read when loading.
  const fileRef = useLatest(selected?.file ?? null);
  const [diffTries, setDiffTries] = useState(0);
  useEffect(() => {
    if (first === null || last === null) return;
    let alive = true;
    setDiff({ status: "loading" });
    Promise.all([detail(first), detail(last)]).then(
      ([a, b]) => {
        const file = fileRef.current;
        if (!alive || !file) return;
        setDiff({ status: "ready", ...netDiff(file, a, b) });
        setFlash((n) => n + 1);
      },
      (e: unknown) => alive && setDiff({ status: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [detail, first, last, diffTries, fileRef]);

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
    select: (s: Selection) => setPicked({ turnId: s.turnId, key: rowKey(s.turnId, s.file) }),
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
