import type { FileChangeSummary, TurnChanges as TurnChangeList } from "@octo/agent-client";
import { ArrowUpRight, ChevronsDownUp, ChevronsUpDown, FileDiff } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chipKeyTarget } from "../../lib/chipKeys";
import { useRovingRows } from "../../lib/rovingRows";
import { errorMessage } from "../../lib/format";
import { firstChangedLine, lineDiff, type DiffRow } from "../../lib/toolView";
import { filesChanged, kindLabel, netDiff, netIds, rowKey } from "../../lib/v7/changes";
import { useApp } from "../../state/app";
import { useOptionalCode } from "../../state/code";
import { useProject } from "../../state/project";
import { loadTurnChanges, turnChangesEntry } from "../../state/turnChanges";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { ActivityRow } from "./ActivityRow";
import { DiffPreview, diffMore } from "./tools/DiffPreview";
import { BodyFrame, Counts, Disclosure, TextAction, useOpenAt, useOpenChanges } from "./tools/parts";

/*
 * retest3 G2 (toolpolish): a turn that changed files says so under its reply, as the turn's summary — "2 files changed +5 −2 ·
 * retry.ts · client.ts" (up to three names, then "+N more"; a name shows that file's diff), "Expand all" (a row per file, the
 * same row and body as an edit call) and "Review changes" (the Changes tab on this turn, where a file or the turn is reverted). The project's
 * changes are read once and shared by every turn (again when a change is recorded): `state/turnChanges`.
 */

function useTurnChanges(turnId: number): TurnChangeList | null {
  const { bridge } = useApp();
  // `reload`: one per project view (a project shown again reads its changes again, painting what it had meanwhile).
  const { projectId, onEvent, reload } = useProject();
  const e = turnChangesEntry(bridge, projectId);
  const subscribe = useCallback(
    (l: () => void) => {
      e.listeners.add(l);
      return () => e.listeners.delete(l);
    },
    [e],
  );
  const data = useSyncExternalStore(subscribe, () => e.data);
  useEffect(() => void loadTurnChanges(bridge, projectId, e, reload), [bridge, projectId, e, reload]);
  useEffect(
    () =>
      onEvent((ev) => {
        if (ev.type !== "change.recorded") return;
        e.stale = true;
        void loadTurnChanges(bridge, projectId, e);
      }),
    [onEvent, bridge, projectId, e],
  );
  return data?.find((t) => t.turn_id === turnId) ?? null;
}

/** 7h: ←/→/Home/End between the `[data-row]` chips of a group (`useRovingRows` keeps it one Tab stop). */
function useChipKeys(ref: React.RefObject<HTMLElement | null>): void {
  const bound = useRef<HTMLElement | null>(null);
  const onKey = useRef((e: KeyboardEvent) => {
    const box = bound.current;
    if (!box) return;
    const rows = [...box.querySelectorAll<HTMLElement>("[data-row]")];
    const at = rows.findIndex((r) => r === document.activeElement);
    const to = at < 0 ? null : chipKeyTarget(e.key, at, rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  });
  useEffect(() => {
    const el = ref.current;
    if (el === bound.current) return;
    bound.current?.removeEventListener("keydown", onKey.current);
    el?.addEventListener("keydown", onKey.current);
    bound.current = el;
  });
  useEffect(() => {
    const handler = onKey.current;
    return () => bound.current?.removeEventListener("keydown", handler);
  }, []);
}

/** File names named on the collapsed line before "+N more". */
const NAMED = 3;

const VERB: Record<FileChangeSummary["kind"], string> = { created: "Added", deleted: "Deleted", modified: "Edited" };

export const TurnChanges = memo(function TurnChanges({ turnId }: { turnId: number }) {
  const turn = useTurnChanges(turnId);
  const openChanges = useOpenChanges();
  const code = useOptionalCode();
  // Collapsed: one line that names the files. Listed: a row per file (the same row and body as an edit call); `open` are the
  // rows whose diff shows. A name on the line lists the files with that one open.
  const [listed, setListed] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const chips = useRef<HTMLSpanElement>(null);
  useRovingRows(chips);
  useChipKeys(chips);
  if (!turn || turn.files.length === 0) return null;
  const keys = turn.files.map((f) => rowKey(turn.turn_id, f));
  // The folder is named only when this turn touched more than one (the same rule as the tool rows).
  const multi = (code?.folders.length ?? 0) > 1 && new Set(turn.files.map((f) => f.folder)).size > 1;
  const toggle = (key: string, on: boolean) =>
    setOpen((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const named = turn.files.slice(0, NAMED);
  const rest = turn.files.length - named.length;
  const expandLabel = listed ? "Collapse all" : "Expand all";
  const toggleAll = () => {
    setListed(!listed);
    setOpen(listed ? new Set() : new Set(keys));
  };
  return (
    // R2: on touch 8px more below, so the file names' touch zones stay off the reply's Copy under them.
    <div data-turn-changes className="-mt-2 flex min-w-0 flex-col touch:mb-3">
      {/* One line when it fits; in a narrow column the names take a line of their own on the text edge, and actions collapse to icons instead of wrapping. */}
      <div className="@container/changes min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-3 @min-xl/changes:flex-nowrap">
          {/* The glyph sits in the 16px lead slot of an activity row, so the text starts on the rows' text edge. */}
          <span className="flex h-6 w-4 shrink-0 items-center justify-center">
            <Glyph icon={FileDiff} size={14} />
          </span>
          <span className="flex h-6 shrink-0 items-center gap-1.5">
            <span className="text-fg-2">{filesChanged(turn.files.length)}</span>
            <Counts added={turn.added} removed={turn.removed} />
          </span>
          {/* 7h: the file names are one Tab stop; ←/→ move between them. */}
          <span
            ref={chips}
            role="group"
            aria-label="Changed files"
            // R2: on touch, a names line of its own keeps 20px from the actions above it (their 44px touch zones).
            className="flex h-6 min-w-0 items-center gap-1.5 @max-xl/changes:order-last @max-xl/changes:basis-full @max-xl/changes:pl-6 touch:@max-xl/changes:mt-5"
          >
            {named.map((f, i) => {
              const key = keys[i] ?? "";
              return (
                <span key={key} className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden className={i === 0 ? "shrink-0 @max-xl/changes:hidden" : "shrink-0"}>
                    ·
                  </span>
                  <Button
                    variant="link"
                    tone="quiet"
                    mono
                    size="xs"
                    className="h-6 min-w-0 overflow-hidden"
                    data-row
                    title={`${kindLabel(f.kind)}: ${f.folder}/${f.path} — show its diff`}
                    onClick={() => {
                      setListed(true);
                      toggle(key, !(listed && open.has(key)));
                    }}
                  >
                    <span className="min-w-0 truncate">{basename(f.path)}</span>
                  </Button>
                </span>
              );
            })}
            {rest > 0 && (
              <span className="flex shrink-0 items-center gap-1.5">
                <span aria-hidden>·</span>
                <Button variant="link" tone="quiet" size="xs" className="h-6" data-row onClick={() => setListed(true)}>
                  +{rest} more
                </Button>
              </span>
            )}
          </span>
          <span className="ml-auto flex h-6 shrink-0 items-center gap-1 pl-2 @min-[25rem]/changes:gap-4">
            <span className="hidden @min-[25rem]/changes:contents">
              <TextAction onClick={toggleAll}>{expandLabel}</TextAction>
            </span>
            <span className="contents @min-[25rem]/changes:hidden">
              <IconButton icon={listed ? ChevronsDownUp : ChevronsUpDown} label={expandLabel} size="xs" aria-expanded={listed} onClick={toggleAll} />
            </span>
            {openChanges && (
              <span data-warm="tool:changes" className="contents">
                <span className="hidden @min-[25rem]/changes:contents">
                  <TextAction onClick={() => openChanges(turn.turn_id)} title="Open these changes; revert a file or all of them there">
                    Open changes
                  </TextAction>
                </span>
                <span className="contents @min-[25rem]/changes:hidden">
                  <IconButton
                    icon={ArrowUpRight}
                    label="Open changes"
                    title="Open these changes; revert a file or all of them there"
                    size="xs"
                    onClick={() => openChanges(turn.turn_id)}
                  />
                </span>
              </span>
            )}
          </span>
        </div>
      </div>
      {listed && (
        <div className="mt-1 flex min-w-0 flex-col">
          {turn.files.map((f, i) => {
            const key = keys[i] ?? "";
            return (
              <ActivityRow
                key={key}
                state="done"
                verb={VERB[f.kind]}
                detail={
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span data-allow-truncate className="min-w-0 truncate font-mono text-xs">
                      {multi ? `${f.folder}/${f.path}` : f.path}
                    </span>
                    {f.added !== null && f.removed !== null && <Counts added={f.added} removed={f.removed} />}
                  </span>
                }
                tip={`${VERB[f.kind]} ${f.folder}/${f.path}`}
                open={open.has(key)}
                onOpenChange={(o) => toggle(key, o)}
              >
                <FileChange turnId={turn.turn_id} file={f} />
              </ActivityRow>
            );
          })}
        </div>
      )}
    </div>
  );
});

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

type Loaded = { status: "loading" } | { status: "ready"; rows: DiffRow[] } | { status: "none"; why: string };

/** One file's body: the same frame, diff and action line as an edit call's (`EditBody`). */
function FileChange(props: { turnId: number; file: FileChangeSummary }) {
  const { file } = props;
  const openAt = useOpenAt();
  const openChanges = useOpenChanges();
  const loaded = useFileDiff(file);
  const [all, setAll] = useState(false);
  const sections = useMemo(() => (loaded.status === "ready" ? [loaded.rows] : []), [loaded]);
  const more = useMemo(() => diffMore(sections), [sections]);
  const line = loaded.status === "ready" ? firstChangedLine(loaded.rows) : null;
  const goto = openAt && file.kind !== "deleted" ? (n: number) => openAt(file.path, file.folder, { line: n }) : undefined;
  return (
    <BodyFrame
      kind="file"
      raw={null}
      lead={
        more.more && (
          <Disclosure open={all} onToggle={() => setAll((x) => !x)}>
            {all ? "Show less" : more.rest > 0 ? `Show all (${more.rest} more changed line${more.rest === 1 ? "" : "s"})` : "Show all"}
          </Disclosure>
        )
      }
      actions={
        <>
          {openChanges && (
            <span data-warm="tool:changes" className="contents">
              <TextAction onClick={() => openChanges(props.turnId, { folder: file.folder, path: file.path })}>Open diff</TextAction>
            </span>
          )}
          {goto && line !== null && <TextAction onClick={() => goto(line)}>Go to line {line}</TextAction>}
        </>
      }
    >
      {loaded.status === "ready" ? (
        <DiffPreview sections={sections} numbered all={all} onLine={goto} label={`Changes to ${file.path}`} />
      ) : loaded.status === "none" ? (
        <p className="px-3 py-2 text-fg-3">{loaded.why}</p>
      ) : (
        <p className="flex h-row items-center px-3 text-fg-3" aria-busy>
          Loading the diff…
        </p>
      )}
    </BodyFrame>
  );
}

function useFileDiff(file: FileChangeSummary): Loaded {
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
        setLoaded({ status: "ready", rows: lineDiff(d.before, d.after) });
      },
      (e: unknown) => alive && setLoaded({ status: "none", why: `Could not load the diff: ${errorMessage(e)}. Open changes to retry.` }),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, ids, file]);
  return !ids || !canRead ? { status: "none", why: "No diff is available for this change." } : loaded;
}
