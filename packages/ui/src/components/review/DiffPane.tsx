import { ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { ReviewFile, ReviewFileDiff } from "@octo/agent-client";
import { useDelayedLoading } from "../../lib/hooksMore";
import { hunksToTexts } from "../../lib/review/changes";
import { plural, sizeChange, splitPath } from "../../lib/review/files";
import type { Anchor } from "../../lib/review/position";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { IconMenu } from "../primitives/IconMenu";
import { Checkbox } from "../primitives/Checkbox";
import { Segmented } from "../primitives/Segmented";
import { Spinner } from "../primitives/Status";
import { ImageDiff } from "./ImageDiff";
import { Counts, Notice } from "./parts";
import { ReviewDiff, runsOf, type DiffZone, type Marked, type ReviewMonaco, type RevealRequest, type ScrollRequest } from "./ReviewDiff";
import type { DiffLoad } from "./useReview";
import type { ReviewDiffLayout } from "../../lib/review/diffLayout";

const STATUS_WORD = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", typechange: "Type changed" } as const;

const DIFF_LAYOUTS: readonly { id: ReviewDiffLayout; label: string; title: string }[] = [
  { id: "unified", label: "Unified", title: "Show changes in a single column" },
  { id: "split", label: "Split", title: "Show old and new code side by side" },
];

/** The centre of the review: a 40px toolbar for the file, then its diff (or why there is none), then the comment box. */
export function DiffPane(props: {
  file: ReviewFile;
  diff: DiffLoad;
  onRetry(): void;
  theme: import("../../lib/theme").Theme;
  loadMonaco(): Promise<ReviewMonaco>;
  split: boolean;
  onDiffLayout?(layout: ReviewDiffLayout): void;
  ignoreWhitespace: boolean;
  expanded: boolean;
  /** The diff is the part that changed since the review was submitted. */
  sinceReview: boolean;
  rawUrl(side: "new" | "old"): string;
  commented: readonly Marked[];
  flagged: readonly Marked[];
  reveal: RevealRequest | null;
  scrollTo?: ScrollRequest | null;
  zones: readonly DiffZone[];
  renderZone(key: string): ReactNode;
  /** The file's thread counter, in the bar (folds the thread list open). */
  threadsToggle?: ReactNode;
  /** The accessible list of the file's threads (drawn and apart), under the bar. */
  threadList?: ReactNode;
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
  const canOpen = props.onOpenAt !== undefined && f.status !== "deleted" && !f.binary;
  const { dir, name } = splitPath(f.path);
  const loading = useDelayedLoading(props.diff.status === "loading");
  const layoutValue: ReviewDiffLayout = props.split ? "split" : "unified";
  return (
    <div className="@container/diff flex min-h-0 min-w-0 flex-1 flex-col">
      {/* R4 (polish step 6b): the file's bar is one 40px line with the editor bar's controls (28px, 16px glyphs, gap 4): the
          name leads, the folder and counts are meta, then Viewed, previous / next change and "⋯". In page mode (R6) the file
          picker takes the name's place on the same line. */}
      <div
        data-diff-bar
        className="flex h-ctl-lg shrink-0 items-center gap-1 px-2 shadow-[inset_0_-1px_0_var(--octo-line)] touch:h-auto touch:min-h-ctl-lg touch:py-1"
      >
        {props.picker ?? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2 pl-2">
            <span className="min-w-0 shrink-[0.2] truncate text-sm font-medium text-fg" title={f.path}>
              {name}
            </span>
            <span className="min-w-0 truncate text-xs text-fg-3 @max-lg/diff:hidden">{f.old_path ? `renamed from ${f.old_path}` : dir}</span>
            {!f.binary && <Counts added={f.added} removed={f.removed} className="@max-xs/diff:hidden" />}
            {props.sinceReview && <span className="shrink-0 text-xs text-warn">since your review</span>}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          {props.threadsToggle}
          {props.onDiffLayout && !f.binary && !f.image && (
            <Segmented<ReviewDiffLayout>
              label="Diff layout"
              options={DIFF_LAYOUTS}
              value={layoutValue}
              onChange={props.onDiffLayout}
              className="@max-[520px]/diff:hidden"
            />
          )}
          <span title={f.viewed ? "Viewed (v)" : "Mark as viewed (v)"} className="flex px-1 @max-[440px]/diff:px-0.5">
            <Checkbox label="Viewed" checked={f.viewed} onChange={props.onViewed} />
          </span>
          <IconButton icon={ChevronUp} label="Previous change" shortcut="k" onClick={() => props.onStepChange(-1)} className="@max-[440px]/diff:hidden" />
          <IconButton icon={ChevronDown} label="Next change" shortcut="j" onClick={() => props.onStepChange(1)} className="@max-[440px]/diff:hidden" />
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
              ...(props.onDiffLayout && !f.binary && !f.image
                ? [
                    { id: "layout-unified", label: "Unified diff", checked: !props.split, run: () => props.onDiffLayout?.("unified") },
                    { id: "layout-split", label: "Split diff", checked: props.split, run: () => props.onDiffLayout?.("split") },
                    { id: "sep-layout", separator: true } as const,
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
      {props.threadList}
      <div className="flex min-h-0 flex-1 flex-col">
        {props.diff.status === "error" ? (
          <Notice
            tone="err"
            title="The diff did not load"
            actions={
              <Button size="sm" variant="secondary" onClick={props.onRetry}>
                Retry
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
          <Body {...props} file={f} diff={props.diff.diff} />
        )}
      </div>
      {props.composer}
    </div>
  );
}

function Body(props: Omit<Parameters<typeof DiffPane>[0], "diff"> & { diff: ReviewFileDiff }) {
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
        {plural(f.added + f.removed, "changed line")} in {f.path}. Read it in your editor or on GitHub; you can still mark it viewed and comment on the file.
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
      scrollTo={props.scrollTo ?? null}
      zones={props.zones}
      renderZone={props.renderZone}
      onAnchor={props.onAnchor}
      onSelection={props.onSelection}
      {...(props.onOpenAt && f.status !== "deleted" ? { onGoToLine: (line: number) => props.onOpenAt?.(line) } : {})}
    />
  );
}
