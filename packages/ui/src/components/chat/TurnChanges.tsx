import type { Bridge, FileChangeSummary, TurnChanges as TurnChangeList } from "@octo/agent-client";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { firstChangedLine, lineDiff, type DiffRow } from "../../lib/toolView";
import { filesChanged, kindLabel, netDiff, netIds, rowKey } from "../../lib/v7/changes";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { DiffPreview } from "./tools/DiffPreview";
import { Counts, FRAME, INSET, TextAction, useOpenAt, useOpenChanges } from "./tools/parts";

/*
 * retest3 G2: a turn that changed files says so under its reply — "2 files changed +5 −2", "Expand all" (each file's compact diff
 * in place) and "Review changes" (the Changes tab on this turn, where a file or the whole turn is reverted). The project's
 * changes are read once and shared by every turn (again when a change is recorded).
 */

type Entry = { data: TurnChangeList[] | null; loading: boolean; stale: boolean; listeners: Set<() => void> };
const entries = new WeakMap<Bridge, Map<string, Entry>>();

function entryFor(bridge: Bridge, projectId: string): Entry {
  let byProject = entries.get(bridge);
  if (!byProject) {
    byProject = new Map<string, Entry>();
    entries.set(bridge, byProject);
  }
  let e = byProject.get(projectId);
  if (!e) byProject.set(projectId, (e = { data: null, loading: false, stale: true, listeners: new Set() }));
  return e;
}

function load(bridge: Bridge, projectId: string, e: Entry): void {
  if (e.loading || !e.stale || !bridge.listChanges) return;
  e.loading = true;
  e.stale = false;
  const done = (data: TurnChangeList[] | null) => {
    e.loading = false;
    if (data) e.data = data;
    for (const l of e.listeners) l();
    // A change recorded while reading: read again.
    if (e.stale) load(bridge, projectId, e);
  };
  bridge.listChanges(projectId).then(done, () => done(null));
}

function useTurnChanges(turnId: number): TurnChangeList | null {
  const { bridge } = useApp();
  const { projectId, onEvent } = useProject();
  const e = entryFor(bridge, projectId);
  const data = useSyncExternalStore(
    (l) => {
      e.listeners.add(l);
      return () => e.listeners.delete(l);
    },
    () => e.data,
  );
  useEffect(() => load(bridge, projectId, e), [bridge, projectId, e]);
  useEffect(
    () =>
      onEvent((ev) => {
        if (ev.type !== "change.recorded") return;
        e.stale = true;
        load(bridge, projectId, e);
      }),
    [onEvent, bridge, projectId, e],
  );
  return data?.find((t) => t.turn_id === turnId) ?? null;
}

export function TurnChanges({ turnId }: { turnId: number }) {
  const turn = useTurnChanges(turnId);
  const openChanges = useOpenChanges();
  // Collapsed: the one quiet row. Expanded: every file with its compact diff; a file's header folds that one.
  const [shown, setShown] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  if (!turn || turn.files.length === 0) return null;
  const keys = turn.files.map((f) => rowKey(turn.turn_id, f));
  const toggle = (key: string) =>
    setFolded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div data-turn-changes className="-mt-2 flex min-w-0 flex-col gap-1">
      <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-fg-3">
        <Glyph icon={FileDiff} size={14} className="shrink-0" />
        <span className="shrink-0 text-fg-2">{filesChanged(turn.files.length)}</span>
        <Counts added={turn.added} removed={turn.removed} />
        <span className="ml-auto flex shrink-0 items-center gap-3 pl-2">
          <TextAction
            onClick={() => {
              setShown(!shown);
              setFolded(new Set());
            }}
          >
            {shown ? "Collapse all" : "Expand all"}
          </TextAction>
          {openChanges && (
            <TextAction onClick={() => openChanges(turn.turn_id)} title="Open this turn's changes, where a file or the whole turn can be reverted">
              Review changes
            </TextAction>
          )}
        </span>
      </div>
      {shown &&
        turn.files.map((f, i) => {
          const key = keys[i] ?? "";
          return <FileChange key={key} turnId={turn.turn_id} file={f} open={!folded.has(key)} onToggle={() => toggle(key)} />;
        })}
    </div>
  );
}

function FileChange(props: { turnId: number; file: FileChangeSummary; open: boolean; onToggle(): void }) {
  const { file } = props;
  const openAt = useOpenAt();
  const openChanges = useOpenChanges();
  const [line, setLine] = useState<number | null>(null);
  const goto = openAt && file.kind !== "deleted" ? (n: number) => openAt(file.path, file.folder, { line: n }) : undefined;
  return (
    <div data-turn-file className={FRAME}>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", INSET)}>
        <Button
          variant="link"
          tone="quiet"
          mono
          size="xs"
          icon={props.open ? ChevronDown : ChevronRight}
          aria-expanded={props.open}
          onClick={props.onToggle}
          title={`${kindLabel(file.kind)}: ${file.folder}/${file.path}`}
          className="min-w-0 shrink"
        >
          <span className="min-w-0 truncate">
            {file.folder}/{file.path}
          </span>
        </Button>
        {file.added !== null && file.removed !== null && <Counts added={file.added} removed={file.removed} />}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {openChanges && <TextAction onClick={() => openChanges(props.turnId, { folder: file.folder, path: file.path })}>Open diff</TextAction>}
          {goto && line !== null && <TextAction onClick={() => goto(line)}>Go to line {line}</TextAction>}
        </span>
      </div>
      {props.open && <FileDiffBody file={file} onLine={goto} onFirstLine={setLine} />}
    </div>
  );
}

type Loaded = { status: "loading" } | { status: "ready"; rows: DiffRow[] } | { status: "none"; why: string };

function FileDiffBody(props: { file: FileChangeSummary; onLine: ((n: number) => void) | undefined; onFirstLine(line: number | null): void }) {
  const { file, onFirstLine } = props;
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const ids = useMemo(() => netIds(file), [file]);
  const canRead = Boolean(bridge.getChange);
  useEffect(() => {
    if (!ids || !bridge.getChange) return;
    const getChange = (id: number) => bridge.getChange?.(projectId, id) ?? Promise.reject(new Error("Octo's local service cannot show this change"));
    let alive = true;
    Promise.all([getChange(ids.first), ids.last === ids.first ? null : getChange(ids.last)]).then(
      ([first, last]) => {
        if (!alive) return;
        const d = netDiff(file, first, last ?? first);
        if ("unavailable" in d) return setLoaded({ status: "none", why: d.unavailable });
        const rows = lineDiff(d.before, d.after);
        setLoaded({ status: "ready", rows });
        onFirstLine(firstChangedLine(rows));
      },
      (e: unknown) => alive && setLoaded({ status: "none", why: `The diff did not load: ${errorMessage(e)}. Review changes to try again.` }),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, ids, file, onFirstLine]);
  const shown: Loaded = !ids || !canRead ? { status: "none", why: "No diff is available for this change." } : loaded;
  return (
    <div className="border-t border-line py-1">
      {shown.status === "ready" ? (
        <DiffPreview rows={shown.rows} numbered onLine={props.onLine} label={`Changes to ${file.path}`} />
      ) : shown.status === "none" ? (
        <p className="px-3 py-1 text-fg-3">{shown.why}</p>
      ) : (
        <p className="flex h-row items-center px-3 text-fg-3" aria-busy>
          Loading the diff…
        </p>
      )}
    </div>
  );
}
