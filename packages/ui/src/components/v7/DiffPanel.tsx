import { ArrowLeft, Check, ChevronDown, ChevronUp, ExternalLink, Undo2 } from "lucide-react";
import { memo, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooksMore";
import { kindLabel, kindLetter, splitPath, type DiffLayout } from "../../lib/v7/changes";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { IconButton } from "../primitives/IconButton";
import { FloatRoom } from "../primitives/floatRoom";
import { IconMenu } from "../primitives/IconMenu";
import type { MenuItem } from "../primitives/Menu";
import { MiddleText } from "../primitives/MiddleText";
import { Spinner } from "../primitives/Status";
import { DiffEditor, type DiffMonaco } from "./DiffEditor";
import type { LineComment } from "./DiffComments";
import { LineCounts } from "./parts";
import type { DiffState, RowState, Selection } from "./useChanges";

const KIND_TONE = { A: "text-ok", M: "text-fg-3", D: "text-err" } as const;

/**
 * The right side of the changes view: a 40px row like the file view's breadcrumb (back on narrow panes, the file,
 * counts, prev / next, Open file, Keep, Revert), any revert outcome, then the diff or why there is none.
 */
export const DiffPanel = memo(function DiffPanel(props: {
  selection: Selection;
  diff: DiffState;
  row: RowState | undefined;
  layout: DiffLayout;
  ignoreWhitespace: boolean;
  flash: number;
  theme: import("../../lib/theme").Theme;
  loadMonaco(): Promise<DiffMonaco>;
  commented: readonly { start: number; end: number }[];
  kept?: boolean;
  onToggleKept?(): void;
  onBack?(): void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onToggleWhitespace?(): void;
  onRevert(): void;
  onRetry(): void;
  /** Opens the file in the editor, at a line when given. */
  onOpenFile?(line?: number): void;
  onAddComment?(c: LineComment): void;
}) {
  const { file } = props.selection;
  const { dir, name } = splitPath(file.path);
  const letter = kindLetter(file.kind);
  const reverted = props.row !== undefined && "reverted" in props.row;
  const reverting = props.row !== undefined && "reverting" in props.row;
  const problem = props.row !== undefined && "problem" in props.row ? props.row.problem : null;
  const loading = useDelayedLoading(props.diff.status === "loading");
  const canOpen = props.onOpenFile !== undefined && file.kind !== "deleted";
  const moreItems: MenuItem[] = [
    { id: "prev", label: "Previous file", shortcut: "Alt+[", disabled: !props.onPrev, run: () => props.onPrev?.() },
    { id: "next", label: "Next file", shortcut: "Alt+]", disabled: !props.onNext, run: () => props.onNext?.() },
    ...(props.onToggleKept && !reverted ? [{ id: "keep", label: props.kept ? "Unmark kept" : "Keep file", run: props.onToggleKept }] : []),
    ...(canOpen ? [{ id: "open", label: "Open file", run: () => props.onOpenFile?.() }] : []),
  ];
  return (
    <div className="@container/diff flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-ctl-lg shrink-0 items-center gap-1 px-pane shadow-[inset_0_-1px_0_var(--octo-line)] touch:h-auto touch:min-h-ctl-lg touch:py-1">
        {props.onBack && <IconButton icon={ArrowLeft} label="Back to the list" onClick={props.onBack} />}
        <span className={cn("w-4 shrink-0 text-center font-mono text-xs font-medium", KIND_TONE[letter])}>
          <span aria-hidden>{letter}</span>
          <span className="sr-only">{kindLabel(file.kind)}</span>
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2 pl-1" title={file.path}>
          <MiddleText text={name} className="max-w-full text-sm text-fg" />
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3 @max-[560px]/diff:hidden">{dir ? `${file.folder}/${dir}` : file.folder}</span>
        </span>
        <LineCounts added={file.added} removed={file.removed} className="ml-2 shrink-0 @max-[520px]/diff:hidden" />
        <span className="hidden shrink-0 items-center gap-1 @max-[480px]/diff:flex">
          <IconMenu label="More actions for this file" items={moreItems} />
          <IconButton
            icon={Undo2}
            size="sm"
            label={reverted ? "Reverted" : "Revert"}
            disabled={reverted || reverting}
            aria-busy={reverting}
            onClick={props.onRevert}
          />
        </span>
        <span className="flex shrink-0 items-center gap-1 @max-[480px]/diff:hidden">
          <IconButton icon={ChevronUp} label="Previous file" shortcut="Alt+[" disabled={!props.onPrev} onClick={() => props.onPrev?.()} />
          <IconButton icon={ChevronDown} label="Next file" shortcut="Alt+]" disabled={!props.onNext} onClick={() => props.onNext?.()} />
          {props.onOpenFile && file.kind !== "deleted" && <IconButton icon={ExternalLink} label="Open file" onClick={() => props.onOpenFile?.()} />}
          {props.onToggleKept && !reverted && (
            <>
              <span className="contents @max-[620px]/diff:hidden">
                <Button
                  variant={props.kept ? "quiet" : "secondary"}
                  size="sm"
                  icon={Check}
                  pressed={Boolean(props.kept)}
                  title={props.kept ? "Marked kept (click to undo)" : "Mark file reviewed & keep changes"}
                  onClick={props.onToggleKept}
                  className={cn(props.kept && "text-ok")}
                >
                  {props.kept ? "Kept" : "Keep"}
                </Button>
              </span>
              <span className="hidden @max-[620px]/diff:contents">
                <IconButton
                  icon={Check}
                  label={props.kept ? "Kept" : "Keep"}
                  title={props.kept ? "Marked kept (click to undo)" : "Mark file reviewed & keep changes"}
                  pressed={Boolean(props.kept)}
                  onClick={props.onToggleKept}
                  className={cn(props.kept && "text-ok")}
                />
              </span>
            </>
          )}
          <span className="contents @max-[620px]/diff:hidden">
            <Button
              variant="secondary"
              size="sm"
              icon={Undo2}
              title={reverted ? "Reverted" : "Revert"}
              disabled={reverted || reverting}
              loading={reverting}
              onClick={props.onRevert}
            >
              {reverted ? "Reverted" : "Revert"}
            </Button>
          </span>
          <span className="hidden @max-[620px]/diff:contents">
            <IconButton icon={Undo2} label={reverted ? "Reverted" : "Revert"} disabled={reverted || reverting} aria-busy={reverting} onClick={props.onRevert} />
          </span>
        </span>
      </div>
      {reverted && <Banner tone="ok">Reverted. The file is back to its content from before this request.</Banner>}
      {problem && (
        <Banner
          tone="err"
          action={
            problem.kind !== "other" && props.onOpenFile ? (
              <Button size="xs" variant="secondary" onClick={() => props.onOpenFile?.()}>
                Open file
              </Button>
            ) : null
          }
        >
          {problem.message}
        </Banner>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {props.diff.status === "ready" && "before" in props.diff ? (
          <DiffEditor
            loadMonaco={props.loadMonaco}
            theme={props.theme}
            path={file.path}
            before={props.diff.before}
            after={props.diff.after}
            layout={props.layout}
            ignoreWhitespace={props.ignoreWhitespace}
            flashKey={props.flash}
            commented={props.commented}
            {...(props.onOpenFile && file.kind !== "deleted" ? { onGoToLine: (line: number) => props.onOpenFile?.(line) } : {})}
            {...(props.onAddComment ? { onAddComment: props.onAddComment } : {})}
          />
        ) : props.diff.status === "ready" ? (
          <EmptyState title={props.diff.unavailable}>Only line counts are shown, but revert still works because the earlier content was kept.</EmptyState>
        ) : props.diff.status === "error" ? (
          <EmptyState
            title="The diff did not load"
            tone="err"
            actions={
              <Button size="sm" variant="secondary" onClick={props.onRetry}>
                Retry
              </Button>
            }
          >
            {props.diff.message}.
          </EmptyState>
        ) : (
          loading && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div aria-hidden className="flex-[42]" />
              <div className="flex justify-center">
                <Spinner />
              </div>
              <div aria-hidden className="flex-[58]" />
            </div>
          )
        )}
        <FloatRoom />
      </div>
    </div>
  );
});

function Banner({ tone, action, children }: { tone: "ok" | "err"; action?: ReactNode; children: ReactNode }) {
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 text-sm"
    >
      <span className={cn("min-w-0 flex-1", tone === "ok" ? "text-ok" : "text-err")}>{children}</span>
      {action}
    </div>
  );
}
