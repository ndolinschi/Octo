import { Check } from "lucide-react";
import { PanelBody, PanelEmpty } from "../primitives/Panel";
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { TurnChanges } from "@octo/agent-client";
import { useMediaQuery } from "../../lib/hooks";
import { useHistoryLayer } from "../../lib/historyLayer";
import { usePhone } from "../../lib/phone";
import { DIFF_SPLIT_MIN, diffLayout, earlierRequestLabel, filesChanged, neighbours, rowKey, splitPath } from "../../lib/v7/changes";
import { keepAllFiles, keptChangesSnapshot, subscribeKeptChanges, toggleFileKept } from "../../state/keptChanges";
import { useOptionalProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { SkeletonList } from "../primitives/Skeleton";
import { FloatRoom } from "../primitives/floatRoom";
import { Presence } from "../primitives/Presence";
import type { DiffMonaco } from "./DiffEditor";
import { DiffPanel } from "./DiffPanel";
import { TurnFiles } from "./TurnFiles";
import { useChanges, type ChangesApi, type FocusFile, type Selection } from "./useChanges";
import { useWidth } from "../../lib/useWidth";

/** Below this pane width the list and the diff take turns (the list first, Back returns to it). */
const TWO_COLUMNS_MIN = 720;

export type ChangesViewProps = {
  api: ChangesApi;
  theme: import("../../lib/theme").Theme;
  /** The files feature's Monaco loader (the dock passes it; Monaco is a value only there). */
  loadMonaco(): Promise<DiffMonaco>;
  /** Bump on `change.recorded` to reload the list. */
  refreshKey?: number;
  /** Show one turn only (the transcript's "Review"); null or absent: every turn, newest first. */
  focusTurn?: number | null;
  /** One file of the focused turn to select and show ("Open diff"); `seq` distinguishes a repeated request. */
  focusFile?: FocusFile | null;
  /** The filter bar's "Show all" (shown while `focusTurn` is set). */
  onShowAll?(): void;
  /** The request that started a turn (its first words); default "Earlier request" with the time of its first change. */
  turnLabel?(turn: TurnChanges): string;
  /** Decision 47: a line comment goes to the composer's pending comments. */
  onAddComment?(comment: { folder: string; path: string; start: number; end: number; text: string }): void;
  /** Lines of a file that already carry a pending comment. */
  commentsFor?(folder: string, path: string): readonly { start: number; end: number }[];
  onOpenFile?(folder: string, path: string, line?: number): void;
};

type Confirm = { kind: "file"; selection: Selection } | { kind: "turn"; turn: TurnChanges } | null;

const NONE: readonly { start: number; end: number }[] = [];

/** The changes view (v7 §1, decision 47): per-turn file lists beside a diff, revert with a confirm, line comments. */
export function ChangesView(props: ChangesViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const wideWindow = useMediaQuery(`(min-width: ${DIFF_SPLIT_MIN}px)`);
  const projectId = useOptionalProject()?.projectId ?? "default";
  const kept = useSyncExternalStore(subscribeKeptChanges, () => keptChangesSnapshot(projectId));
  const c = useChanges(props.api, props.refreshKey ?? 0, props.focusTurn ?? null, props.focusFile ?? null);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [showDiff, setShowDiff] = useState(props.focusFile != null);
  // A new "Open diff" request on a narrow pane shows the diff (adjusting state during render, not in an effect).
  const [seenSeq, setSeenSeq] = useState(props.focusFile?.seq ?? 0);
  if ((props.focusFile?.seq ?? 0) !== seenSeq) {
    setSeenSeq(props.focusFile?.seq ?? 0);
    if (props.focusFile) setShowDiff(true);
  }
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [turnBusy, setTurnBusy] = useState<number | null>(null);
  const two = width === null || width >= TWO_COLUMNS_MIN;
  const listWidth = width !== null ? Math.min(360, Math.max(280, Math.round(width * 0.3))) : 280;
  const layout = diffLayout(wideWindow ? DIFF_SPLIT_MIN : 0, two && width !== null ? width - listWidth : 0);
  const label = props.turnLabel ?? ((turn: TurnChanges) => earlierRequestLabel(turn, Date.now()));

  const index = c.selected ? c.all.findIndex((s) => s.turnId === c.selected?.turnId && s.file === c.selected.file) : -1;
  const near = neighbours(c.all, index);
  // A1.3: on the phone the diff is a layer over the list, so the system Back returns to the list.
  const phone = usePhone();
  useHistoryLayer(phone && !two && showDiff && c.selected !== null, (navigated) => {
    if (!navigated) setShowDiff(false);
  });
  const select = (s: Selection) => {
    c.select(s);
    setShowDiff(true);
  };
  const sel = c.selected;
  const commentsFor = props.commentsFor;
  const commented = useMemo(() => (sel && commentsFor ? commentsFor(sel.file.folder, sel.file.path) : NONE), [sel, commentsFor]);
  const allKeys = useMemo(() => c.all.map((s) => rowKey(s.turnId, s.file)), [c.all]);
  const keptCount = useMemo(() => allKeys.filter((k) => kept.has(k)).length, [allKeys, kept]);
  const selKey = sel ? rowKey(sel.turnId, sel.file) : null;
  const selKept = selKey !== null && kept.has(selKey);

  const toggleCurrentKept = () => {
    if (!selKey) return;
    const nowKept = toggleFileKept(projectId, selKey);
    // Keeping a file advances to the next unkept file so reviewing a multi-file turn is one click/keystroke per file.
    if (nowKept && near.next && !kept.has(rowKey(near.next.turnId, near.next.file))) {
      c.select(near.next);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "]" && near.next) {
      e.preventDefault();
      c.select(near.next);
    } else if (e.key === "[" && near.prev) {
      e.preventDefault();
      c.select(near.prev);
    }
  };

  const runConfirm = async () => {
    const what = confirm;
    setConfirm(null);
    if (!what) return;
    if (what.kind === "file") await c.revertFile(what.selection.turnId, what.selection.file);
    else {
      setTurnBusy(what.turn.turn_id);
      await c.revertTurn(what.turn);
      setTurnBusy(null);
    }
  };

  let body;
  if (c.turns.status === "loading")
    body = (
      <PanelBody>
        <SkeletonList count={6} size="md" shimmer />
      </PanelBody>
    );
  else if (c.turns.status === "error")
    body = (
      <Empty title="The changes did not load" text={`${c.turns.message}.`}>
        <Button size="sm" variant="secondary" onClick={c.reload}>
          Retry
        </Button>
      </Empty>
    );
  else if (!c.turns.turns.length)
    body = <Empty title="No changes yet" text="Files the agents write, create or delete show here, one list per request, ready to review or revert." />;

  const list =
    c.turns.status === "ready" &&
    c.turns.turns.map((t) => (
      <TurnFiles
        key={t.turn_id}
        turn={t}
        label={label(t)}
        selectedKey={two || showDiff ? c.selectedKey : null}
        rows={c.rows}
        kept={kept}
        reverting={turnBusy === t.turn_id}
        onSelect={(file) => select({ turnId: t.turn_id, file })}
        onRevertTurn={() => setConfirm({ kind: "turn", turn: t })}
      />
    ));

  const reviewHeader = allKeys.length > 0 && (
    <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-fg-3">
      <span className="tabular-nums">
        {keptCount}/{allKeys.length} kept
      </span>
      {keptCount < allKeys.length && (
        <Button variant="quiet" size="xs" icon={Check} onClick={() => keepAllFiles(projectId, allKeys)}>
          Keep all
        </Button>
      )}
    </div>
  );

  const diff = sel && (
    <DiffPanel
      selection={sel}
      diff={c.diff}
      row={c.rows[rowKey(sel.turnId, sel.file)]}
      layout={layout}
      ignoreWhitespace={ignoreWhitespace}
      flash={c.flash}
      theme={props.theme}
      loadMonaco={props.loadMonaco}
      commented={commented}
      kept={selKept}
      onToggleKept={toggleCurrentKept}
      {...(two ? {} : { onBack: () => setShowDiff(false) })}
      onPrev={near.prev ? () => near.prev && c.select(near.prev) : null}
      onNext={near.next ? () => near.next && c.select(near.next) : null}
      onToggleWhitespace={() => setIgnoreWhitespace((x) => !x)}
      onRevert={() => setConfirm({ kind: "file", selection: sel })}
      onRetry={c.retryDiff}
      {...(props.onOpenFile ? { onOpenFile: (line?: number) => props.onOpenFile?.(sel.file.folder, sel.file.path, line) } : {})}
      {...(props.onAddComment ? { onAddComment: (x) => props.onAddComment?.({ folder: sel.file.folder, ...x }) } : {})}
    />
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-panel" data-v7-changes onKeyDown={onKeyDown}>
      {props.focusTurn != null && props.onShowAll && (
        <div className="flex h-ctl-lg shrink-0 items-center gap-2 border-b border-line pr-pane pl-4 text-sm text-fg-2">
          <span className="min-w-0 flex-1 truncate">Showing one request</span>
          <Button variant="quiet" size="sm" className="max-md:h-10" onClick={props.onShowAll}>
            Show all
          </Button>
        </div>
      )}
      <div ref={box} className="flex min-h-0 min-w-0 flex-1">
        {body ? (
          // A flex column, so an empty or failed load is the frame's one centred empty state (P1, B4).
          <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        ) : two ? (
          <>
            <nav
              aria-label="Changed files"
              className="@container/list flex w-[clamp(17.5rem,30%,22.5rem)] shrink-0 flex-col gap-2 overflow-y-auto border-r border-line px-pane pt-1 pb-4"
            >
              {reviewHeader}
              {list}
              <FloatRoom />
            </nav>
            {diff}
          </>
        ) : showDiff && diff ? (
          diff
        ) : (
          <nav aria-label="Changed files" className="@container/list flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto px-pane pt-1 pb-4">
            {reviewHeader}
            {list}
            <FloatRoom />
          </nav>
        )}
        <Presence show={confirm !== null}>
          {confirm && <RevertDialog confirm={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void runConfirm()} />}
        </Presence>
      </div>
    </div>
  );
}

function RevertDialog({ confirm, onCancel, onConfirm }: { confirm: NonNullable<Confirm>; onCancel(): void; onConfirm(): void }) {
  const file = confirm.kind === "file" ? confirm.selection.file : null;
  const title = file
    ? `Revert ${splitPath(file.path).name}?`
    : `Revert ${filesChanged(confirm.kind === "turn" ? confirm.turn.files.length : 0).replace(" changed", "")}?`;
  const what =
    file?.kind === "created"
      ? "This deletes the file the agent created."
      : file?.kind === "deleted"
        ? "This restores the file the agent deleted."
        : file
          ? "This writes back the file's content from before this request."
          : "This writes back every file of this request as it was before it (created files are deleted, deleted ones restored).";
  return (
    <Dialog
      title={title}
      description={`${what} A file that changed again since is left alone and named.`}
      width="sm"
      onClose={onCancel}
      footer={
        <>
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Revert
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <PanelEmpty title={title} {...(children ? { actions: <div className="flex flex-wrap items-center justify-center gap-2">{children}</div> } : {})}>
      {text}
    </PanelEmpty>
  );
}
