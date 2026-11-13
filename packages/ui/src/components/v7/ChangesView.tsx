import { EmptyState } from "../primitives/EmptyState";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { TurnChanges } from "@octo/agent-client";
import { useMediaQuery } from "../../lib/hooks";
import { DIFF_SPLIT_MIN, diffLayout, filesChanged, neighbours, rowKey, splitPath } from "../../lib/v7/changes";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { SkeletonRows } from "../primitives/InfoList";
import { FloatRoom } from "../primitives/floatRoom";
import { Presence } from "../primitives/Presence";
import type { DiffMonaco } from "./DiffEditor";
import { DiffPanel } from "./DiffPanel";
import { TurnFiles } from "./TurnFiles";
import { useChanges, type ChangesApi, type Selection } from "./useChanges";
import { useWidth } from "./useWidth";

/** Below this pane width the list and the diff take turns (the list first, Back returns to it). */
const TWO_COLUMNS_MIN = 720;

export type ChangesViewProps = {
  api: ChangesApi;
  theme: "dark" | "light";
  /** The files feature's Monaco loader (the dock passes it; Monaco is a value only there). */
  loadMonaco(): Promise<DiffMonaco>;
  /** Bump on `change.recorded` to reload the list. */
  refreshKey?: number;
  /** Show one turn only (the transcript's "Review"); null or absent: every turn, newest first. */
  focusTurn?: number | null;
  /** The request that started a turn, by its id (its first words); default "Turn {id}". */
  turnLabel?(turnId: number): string;
  /** Decision 47: a line comment goes to the composer's pending comments. */
  onAddComment?(comment: { folder: string; path: string; start: number; end: number; text: string }): void;
  /** Lines of a file that already carry a pending comment. */
  commentsFor?(folder: string, path: string): readonly { start: number; end: number }[];
  onOpenFile?(folder: string, path: string): void;
};

type Confirm = { kind: "file"; selection: Selection } | { kind: "turn"; turn: TurnChanges } | null;

const NONE: readonly { start: number; end: number }[] = [];

/** The changes view (v7 §1, decision 47): per-turn file lists beside a diff, revert with a confirm, line comments. */
export function ChangesView(props: ChangesViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const wideWindow = useMediaQuery(`(min-width: ${DIFF_SPLIT_MIN}px)`);
  const c = useChanges(props.api, props.refreshKey ?? 0, props.focusTurn ?? null);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [turnBusy, setTurnBusy] = useState<number | null>(null);
  const two = width === null || width >= TWO_COLUMNS_MIN;
  const layout = diffLayout(wideWindow ? DIFF_SPLIT_MIN : 0, two && width !== null ? width - 288 : 0);
  const label = props.turnLabel ?? ((id: number) => `Turn ${id}`);

  const index = c.selected ? c.all.findIndex((s) => s.turnId === c.selected?.turnId && s.file === c.selected.file) : -1;
  const near = neighbours(c.all, index);
  const select = (s: Selection) => {
    c.select(s);
    setShowDiff(true);
  };
  const sel = c.selected;
  const commented = useMemo(() => (sel && props.commentsFor ? props.commentsFor(sel.file.folder, sel.file.path) : NONE), [sel, props]);

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
  if (c.turns.status === "loading") body = <SkeletonRows count={6} />;
  else if (c.turns.status === "error")
    body = (
      <Empty title="The changes did not load" text={`${c.turns.message}.`}>
        <Button size="sm" variant="secondary" onClick={c.reload}>
          Try again
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
        label={label(t.turn_id)}
        selectedKey={two || showDiff ? c.selectedKey : null}
        rows={c.rows}
        reverting={turnBusy === t.turn_id}
        onSelect={(file) => select({ turnId: t.turn_id, file })}
        onRevertTurn={() => setConfirm({ kind: "turn", turn: t })}
      />
    ));

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
      {...(two ? {} : { onBack: () => setShowDiff(false) })}
      onPrev={near.prev ? () => near.prev && c.select(near.prev) : null}
      onNext={near.next ? () => near.next && c.select(near.next) : null}
      onToggleWhitespace={() => setIgnoreWhitespace((x) => !x)}
      onRevert={() => setConfirm({ kind: "file", selection: sel })}
      onRetry={c.retryDiff}
      {...(props.onOpenFile ? { onOpenFile: () => props.onOpenFile?.(sel.file.folder, sel.file.path) } : {})}
      {...(props.onAddComment ? { onAddComment: (x) => props.onAddComment?.({ folder: sel.file.folder, ...x }) } : {})}
    />
  );

  return (
    <div ref={box} className="flex h-full min-h-0 min-w-0 bg-panel" data-v7-changes>
      {body ? (
        <div className="flex-1 overflow-auto px-2 pt-1 pb-2">
          {body}
          <FloatRoom />
        </div>
      ) : two ? (
        <>
          <nav aria-label="Changed files" className="@container/list flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r border-line px-2 pt-1 pb-2">
            {list}
            <FloatRoom />
          </nav>
          {diff}
        </>
      ) : showDiff && diff ? (
        diff
      ) : (
        <nav aria-label="Changed files" className="@container/list flex flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-2">
          {list}
          <FloatRoom />
        </nav>
      )}
      <Presence show={confirm !== null}>
        {confirm && <RevertDialog confirm={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void runConfirm()} />}
      </Presence>
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
          ? "This writes back the file's content from before this turn."
          : "This writes back every file of this turn as it was before it (created files are deleted, deleted ones restored).";
  return (
    <Dialog
      title={title}
      description={`${what} A file that changed again since is left alone and named.`}
      width="sm"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
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
    <EmptyState title={title} actions={children ? <div className="flex flex-wrap items-center justify-center gap-2">{children}</div> : undefined}>
      {text}
    </EmptyState>
  );
}
