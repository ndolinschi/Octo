import { ChevronDown, ChevronUp, CornerDownRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ReviewFile, ReviewFileDiff } from "@octo/agent-client";
import { useDelayedLoading } from "../../lib/hooksMore";
import { hunksToTexts } from "../../lib/review/changes";
import { plural, sizeChange, splitPath } from "../../lib/review/files";
import type { Anchor } from "../../lib/review/position";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { IconMenu } from "../primitives/IconMenu";
import { Checkbox } from "../primitives/Checkbox";
import { Spinner } from "../primitives/Status";
import { ImageDiff } from "./ImageDiff";
import { Counts, Notice } from "./parts";
import { ReviewDiff, runsOf, type DiffZone, type Marked, type ReviewMonaco, type RevealRequest } from "./ReviewDiff";
import type { DiffLoad } from "./useReview";

const STATUS_WORD = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", typechange: "Type changed" } as const;

/** The centre of the review: a 40px toolbar for the file, then its diff (or why there is none), then the comment box. */
export function DiffPane(props: {
  file: ReviewFile;
  diff: DiffLoad;
  onRetry(): void;
  theme: "dark" | "light";
  loadMonaco(): Promise<ReviewMonaco>;
  split: boolean;
  ignoreWhitespace: boolean;
  expanded: boolean;
  /** The diff is the part that changed since the review was submitted. */
  sinceReview: boolean;
  rawUrl(side: "new" | "old"): string;
  commented: readonly Marked[];
  flagged: readonly Marked[];
  reveal: RevealRequest | null;
  zones: readonly DiffZone[];
  renderZone(key: string): ReactNode;
  /** Threads that have no line in this diff (outdated), listed under the toolbar. */
  apart?: ReactNode;
  onToggleWhitespace(): void;
  onToggleExpanded(): void;
  onViewed(viewed: boolean): void;
  onFileComment(): void;
  onStepChange(dir: 1 | -1): void;
  onAnchor(anchor: Anchor): void;
  onSelection(anchor: Anchor | null): void;
  /** The comment box, docked under the diff. */
  composer: ReactNode;
  /** The list as a picker (page mode): it takes the file name's place in the bar. */
  picker?: ReactNode;
  /** Page mode: previous / next file live in the bar's "⋯". */
  onStepFile?(dir: 1 | -1): void;
  /** Opens the file (at a line) where the review's code is: its workspace, else the project's folder. Absent: no way to open. */
  onOpenAt?(line?: number): void;
  /** Where `onOpenAt` opens, for the tooltip ("in the review's workspace"). */
  openWhere?: string;
}) {
  const f = props.file;
  const [firstLine, setFirstLine] = useState<number | null>(null);
  const canOpen = props.onOpenAt !== undefined && f.status !== "deleted" && !f.binary;
  const { dir, name } = splitPath(f.path);
  const loading = useDelayedLoading(props.diff.status === "loading");
  return (
    <div className="@container/diff flex min-h-0 min-w-0 flex-1 flex-col">
      {/* R4 (polish step 6b): the file's bar is one 40px line with the editor bar's controls (28px, 16px glyphs, gap 4): the
          name leads, the folder and counts are meta, then Viewed, previous / next change and "⋯". In page mode (R6) the file
          picker takes the name's place on the same line. */}
      <div data-diff-bar className="flex h-ctl-lg shrink-0 items-center gap-1 border-b border-line px-2 touch:h-auto touch:min-h-ctl-lg touch:py-1">
        {props.picker ?? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2 pl-2">
            <span className="min-w-0 shrink-0 truncate text-sm font-medium text-fg" title={f.path}>
              {name}
            </span>
            <span className="min-w-0 truncate text-xs text-fg-3 @max-md/diff:hidden">{f.old_path ? `renamed from ${f.old_path}` : dir}</span>
            <Counts added={f.added} removed={f.removed} className={f.binary ? "hidden" : "@max-xs/diff:hidden"} />
            {props.sinceReview && <span className="shrink-0 text-xs text-warn">since your review</span>}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          <span title={f.viewed ? "Viewed (v)" : "Mark as viewed (v)"} className="flex px-2">
            <Checkbox label="Viewed" checked={f.viewed} onChange={props.onViewed} />
          </span>
          <IconButton icon={ChevronUp} label="Previous change (k)" onClick={() => props.onStepChange(-1)} />
          <IconButton icon={ChevronDown} label="Next change (j)" onClick={() => props.onStepChange(1)} />
          {/* As in Changes (DiffPanel): the first changed line, opened in the editor; the line numbers of the new side open it too. */}
          {canOpen && firstLine !== null && (
            <IconButton
              icon={CornerDownRight}
              label={`Go to line ${firstLine}`}
              title={`Go to line ${firstLine}${props.openWhere ? ` ${props.openWhere}` : ""}`}
              onClick={() => props.onOpenAt?.(firstLine)}
            />
          )}
          <IconMenu
            label="More for this file"
            items={[
              ...(props.onStepFile
                ? [
                    { id: "prev-file", label: "Previous file", run: () => props.onStepFile?.(-1) },
                    { id: "next-file", label: "Next file", run: () => props.onStepFile?.(1) },
                    { id: "sep-file", separator: true } as const,
                  ]
                : []),
              { id: "ws", label: "Ignore whitespace", checked: props.ignoreWhitespace, run: props.onToggleWhitespace },
              { id: "expand", label: "Show all lines", checked: props.expanded, run: props.onToggleExpanded },
              { id: "comment", label: "Comment on this file", run: props.onFileComment },
              ...(canOpen ? [{ id: "open", label: "Open file", run: () => props.onOpenAt?.() }] : []),
            ]}
          />
        </span>
      </div>
      {props.apart}
      <div className="flex min-h-0 flex-1 flex-col">
        {props.diff.status === "error" ? (
          <Notice
            tone="err"
            title="The diff did not load"
            actions={
              <Button size="sm" variant="secondary" onClick={props.onRetry}>
                Try again
              </Button>
            }
          >
            {props.diff.message}.
          </Notice>
        ) : props.diff.status !== "ready" ? (
          loading ? (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          ) : null
        ) : (
          <Body {...props} file={f} diff={props.diff.diff} onFirstLine={setFirstLine} />
        )}
      </div>
      {props.composer}
    </div>
  );
}

function Body(props: Omit<Parameters<typeof DiffPane>[0], "diff"> & { diff: ReviewFileDiff; onFirstLine(line: number | null): void }) {
  const { file: f, diff } = props;
  const texts = useMemo(() => hunksToTexts(diff.hunks), [diff.hunks]);
  const runs = useMemo(() => runsOf(diff.hunks), [diff.hunks]);
  if (f.image) {
    return <ImageDiff file={f} rawUrl={props.rawUrl} />;
  }
  if (f.binary)
    return (
      <Notice title="Binary file">
        {STATUS_WORD[f.status]}: {sizeChange(f)}. There is no text to compare.
      </Notice>
    );
  if (diff.too_large)
    return (
      <Notice title="This diff is too large to show here">
        {plural(f.added + f.removed, "changed line")} in {f.path}. Read it in your editor or on the code host; you can still mark it viewed and comment on the
        file.
      </Notice>
    );
  if (diff.hunks.length === 0)
    return (
      <Notice title={f.status === "renamed" ? "Renamed, content unchanged" : "No lines to show"}>
        {f.status === "renamed" && f.old_path
          ? `${f.old_path} became ${f.path}.`
          : diff.whitespace_ignored
            ? "Only whitespace changed. Turn off “Ignore whitespace” to see it."
            : "The file changed in a way that has no lines (for example its mode)."}
      </Notice>
    );
  return (
    <ReviewDiff
      loadMonaco={props.loadMonaco}
      theme={props.theme}
      path={f.path}
      before={texts.before}
      after={texts.after}
      split={props.split}
      ignoreWhitespace={props.ignoreWhitespace}
      expanded={props.expanded}
      runs={runs}
      commented={props.commented}
      flagged={props.flagged}
      reveal={props.reveal}
      zones={props.zones}
      renderZone={props.renderZone}
      onAnchor={props.onAnchor}
      onSelection={props.onSelection}
      onFirstLine={props.onFirstLine}
      {...(props.onOpenAt && f.status !== "deleted" ? { onGoToLine: (line: number) => props.onOpenAt?.(line) } : {})}
    />
  );
}
