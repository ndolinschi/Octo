import { ArrowLeft, ChevronDown, ChevronUp, CornerDownRight, ExternalLink, Pilcrow, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooksMore";
import { kindLabel, kindLetter, splitPath, type DiffLayout } from "../../lib/v7/changes";
import { Button, IconButton } from "../primitives/Button";
import { IconButton as GoToButton } from "../primitives/IconButton";
import { FloatRoom } from "../primitives/floatRoom";
import { Spinner } from "../primitives/Status";
import { DiffEditor, type DiffMonaco } from "./DiffEditor";
import type { LineComment } from "./DiffComments";
import { LineCounts } from "./parts";
import type { DiffState, RowState, Selection } from "./useChanges";

const KIND_TONE = { A: "text-ok", M: "text-fg-3", D: "text-err" } as const;

/**
 * The right side of the changes view: a 40px row like the file view's breadcrumb (back on narrow panes, the file,
 * counts, prev / next, whitespace, Open file, Revert), any revert outcome, then the diff or why there is none.
 */
export function DiffPanel(props: {
  selection: Selection;
  diff: DiffState;
  row: RowState | undefined;
  layout: DiffLayout;
  ignoreWhitespace: boolean;
  flash: number;
  theme: "dark" | "light";
  loadMonaco(): Promise<DiffMonaco>;
  commented: readonly { start: number; end: number }[];
  onBack?(): void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onToggleWhitespace(): void;
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
  const [firstLine, setFirstLine] = useState<number | null>(null);
  const loading = useDelayedLoading(props.diff.status === "loading");
  return (
    <div className="@container/diff flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        {props.onBack && <IconButton icon={ArrowLeft} label="Back to the list" onClick={props.onBack} className="max-md:size-10" />}
        <span aria-label={kindLabel(file.kind)} className={cn("w-4 shrink-0 text-center font-mono text-xs font-medium", KIND_TONE[letter])}>
          {letter}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2 pl-1">
          <span className="min-w-0 truncate text-sm text-fg">{name}</span>
          <span className="min-w-0 truncate text-xs text-fg-3 @max-md/diff:hidden">{dir ? `${file.folder}/${dir}` : file.folder}</span>
        </span>
        <LineCounts added={file.added} removed={file.removed} className="ml-2 shrink-0 @max-md/diff:hidden" />
        <span className="flex shrink-0 items-center gap-1">
          <IconButton icon={ChevronUp} label="Previous file" disabled={!props.onPrev} onClick={() => props.onPrev?.()} className="max-md:size-10" />
          <IconButton icon={ChevronDown} label="Next file" disabled={!props.onNext} onClick={() => props.onNext?.()} className="max-md:size-10" />
          <span className="contents @max-lg/diff:hidden">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={props.ignoreWhitespace}
              className={cn("max-md:h-10", props.ignoreWhitespace && "bg-active text-fg")}
              title="Hide changes that are only whitespace"
              onClick={props.onToggleWhitespace}
            >
              Ignore whitespace
            </Button>
          </span>
          <span className="hidden @max-lg/diff:contents">
            <IconButton
              icon={Pilcrow}
              label="Ignore whitespace"
              pressed={props.ignoreWhitespace}
              className="max-md:size-10"
              onClick={props.onToggleWhitespace}
            />
          </span>
          {props.onOpenFile && file.kind !== "deleted" && firstLine !== null && (
            <GoToButton icon={CornerDownRight} label={`Go to line ${firstLine}`} onClick={() => props.onOpenFile?.(firstLine)} className="max-md:size-10" />
          )}
          {props.onOpenFile && file.kind !== "deleted" && (
            <IconButton icon={ExternalLink} label="Open file" onClick={() => props.onOpenFile?.()} className="max-md:size-10" />
          )}
          <Button
            variant="secondary"
            size="sm"
            icon={Undo2}
            className="max-md:h-10"
            title={reverted ? "Reverted" : "Revert"}
            disabled={reverted || reverting}
            aria-busy={reverting}
            onClick={props.onRevert}
          >
            <span className="@max-md/diff:sr-only">{reverted ? "Reverted" : "Revert"}</span>
          </Button>
        </span>
      </div>
      {reverted && <Banner tone="ok">Reverted. The file is back to its content from before this turn.</Banner>}
      {problem && (
        <Banner
          tone="err"
          action={
            problem.kind !== "other" && props.onOpenFile ? (
              <Button size="sm" variant="secondary" className="h-6 px-2" onClick={() => props.onOpenFile?.()}>
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
            onFirstLine={setFirstLine}
            {...(props.onOpenFile && file.kind !== "deleted" ? { onGoToLine: (line: number) => props.onOpenFile?.(line) } : {})}
            {...(props.onAddComment ? { onAddComment: props.onAddComment } : {})}
          />
        ) : props.diff.status === "ready" ? (
          <Centered>
            <p className="text-fg-2">{props.diff.unavailable}</p>
            <p className="text-xs text-fg-3">The change is listed with its line counts; revert still works when the content before was kept.</p>
          </Centered>
        ) : props.diff.status === "error" ? (
          <Centered>
            <p role="alert" className="text-err">
              The diff did not load: {props.diff.message}.
            </p>
            <Button size="sm" variant="secondary" onClick={props.onRetry}>
              Try again
            </Button>
          </Centered>
        ) : (
          loading && (
            <Centered>
              <Spinner />
            </Centered>
          )
        )}
        <FloatRoom />
      </div>
    </div>
  );
}

function Banner({ tone, action, children }: { tone: "ok" | "err"; action?: ReactNode; children: ReactNode }) {
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-sm"
    >
      <span className={cn("min-w-0 flex-1", tone === "ok" ? "text-ok" : "text-err")}>{children}</span>
      {action}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">{children}</div>;
}
