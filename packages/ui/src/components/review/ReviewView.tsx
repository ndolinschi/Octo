import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Review, ReviewComment, ReviewFinding, ReviewGroup } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { useMediaQuery } from "../../lib/hooks";
import type { ReviewApi } from "../../lib/review/api";
import { blockAt, changeBlocks, hunksToTexts, stepChange, type ChangeBlock } from "../../lib/review/changes";
import { groupFiles, navigableFiles, readingOrder, sinceReview, stepFile } from "../../lib/review/files";
import type { ReviewKeyAction } from "../../lib/review/keys";
import { anchorProblem, commentWhere, fileCommentInput, generalCommentInput, lineCommentInput, linesOf, type Anchor } from "../../lib/review/position";
import { DIFF_SPLIT_MIN, diffLayout } from "../../lib/v7/changes";
import { Button } from "../primitives/Button";
import { SkeletonRows } from "../primitives/InfoList";
import { Presence } from "../primitives/Presence";
import { Composer, type ComposerValue } from "./Composer";
import { DiffPane } from "./DiffPane";
import { FileList, FilePicker } from "./FileList";
import { Overview } from "./Overview";
import { Notice } from "./parts";
import { PendingPanel } from "./PendingPanel";
import { ReviewHeader } from "./ReviewHeader";
import type { Marked, RevealRequest, ReviewMonaco } from "./ReviewDiff";
import { SubmitSheet } from "./SubmitSheet";
import { useFileDiff, useReview, type ReviewData } from "./useReview";
import { useReviewActions } from "./useReviewActions";
import { useReviewKeys } from "./useReviewKeys";
import { useWidth } from "./useWidth";

/** Below this width the file list becomes a picker above the diff. */
const NARROW_BELOW = 760;
const FILES_WIDTH = 288;
const HINT_MS = 5000;

type ComposerState = { kind: "line"; anchor: Anchor; suggest: boolean } | { kind: "file" } | { kind: "general" } | { kind: "edit"; comment: ReviewComment };

/** A review that is open: loads it, then shows it. */
export function ReviewView(props: { api: ReviewApi; reviewId: string; theme: "dark" | "light"; loadMonaco(): Promise<ReviewMonaco>; onBack(): void }) {
  const { load, patch, retry, reload } = useReview(props.api, props.reviewId);
  if (load.status === "loading") return <SkeletonRows count={8} />;
  if (load.status === "error")
    return (
      <Notice
        tone="err"
        title="The review did not load"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={retry}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onBack}>
              Back to the list
            </Button>
          </>
        }
      >
        {load.message}.
      </Notice>
    );
  return <Ready {...props} data={load.data} patch={patch} reload={reload} />;
}

function Ready(props: {
  api: ReviewApi;
  reviewId: string;
  theme: "dark" | "light";
  loadMonaco(): Promise<ReviewMonaco>;
  onBack(): void;
  data: ReviewData;
  patch(fn: (d: ReviewData) => ReviewData): void;
  reload(): Promise<void>;
}) {
  const { api, reviewId, data } = props;
  const { review, comments, findings } = data;
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const wideWindow = useMediaQuery(`(min-width: ${DIFF_SPLIT_MIN}px)`);
  const narrow = width !== null && width < NARROW_BELOW;
  const actions = useReviewActions(api, reviewId, props.patch, props.reload);

  const files = useMemo(() => readingOrder(data.files.files), [data.files.files]);
  const sections = useMemo(() => groupFiles(data.files.files), [data.files.files]);
  const newCommits = Boolean(review.last_submitted_head) && review.head_commit !== review.last_submitted_head;
  const [onlyNew, setOnlyNew] = useState(true);
  const filterSince = newCommits && onlyNew;
  const shownSections = useMemo(() => (filterSince ? groupFiles(sinceReview(files)) : sections), [filterSince, files, sections]);

  const [pick, setPick] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<ReviewGroup>>(new Set());
  const nav = useMemo(() => navigableFiles(shownSections, opened, pick), [shownSections, opened, pick]);
  const file = files.find((f) => f.path === pick) ?? nav[0] ?? files[0] ?? null;
  const path = file?.path ?? null;

  const [overview, setOverview] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [composer, setComposer] = useState<{ n: number; state: ComposerState } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // "Update" shows only when the code host has commits this review has not fetched (the list's `new_commits`).
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    if (review.kind !== "github") return;
    let alive = true;
    api.listPullRequests(review.folder).then(
      (l) => alive && setBehind(l.prs.some((p) => p.review?.id === review.id && p.review.new_commits)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, review.id, review.folder, review.kind, review.head_commit]);
  const [explicitReveal, setReveal] = useState<RevealRequest | null>(null);
  const [cursor, setCursor] = useState<{ path: string | null; index: number | null }>({ path: null, index: null });
  const [edge, setEdge] = useState<{ at: "first" | "last"; n: number } | null>(null);
  const selection = useRef<Anchor | null>(null);
  const seq = useRef(0);

  const diffState = useFileDiff(
    api,
    reviewId,
    path,
    { context: expanded ? 1000 : 3, ignoreWhitespace, since: filterSince ? review.last_submitted_head : undefined },
    review.head_commit,
  );
  const diff = diffState.state.status === "ready" && diffState.state.diff.path === path ? diffState.state.diff : null;
  const hunks = useMemo(() => diff?.hunks ?? [], [diff]);
  const blocks = useMemo<ChangeBlock[]>(() => changeBlocks(hunks), [hunks]);
  const after = useMemo(() => hunksToTexts(hunks).after, [hunks]);
  // After `j` / `k` ran off the end of a file, the next file opens on its first (or last) change: derived, no effect.
  const edgeIndex = edge && blocks.length ? (edge.at === "first" ? 0 : blocks.length - 1) : null;
  const edgeBlock = edgeIndex === null ? undefined : blocks[edgeIndex];
  const reveal = useMemo<RevealRequest | null>(() => (edge && edgeBlock ? { block: edgeBlock, n: edge.n } : explicitReveal), [edge, edgeBlock, explicitReveal]);
  const index = edgeIndex ?? (cursor.path === path ? cursor.index : null);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), HINT_MS);
    return () => window.clearTimeout(t);
  }, [hint]);

  const select = useCallback((p: string) => {
    setPick(p);
    setEdge(null);
    setCursor({ path: p, index: null });
    selection.current = null;
    setReveal(null);
    setComposer(null);
  }, []);

  const goTo = useCallback(
    (i: number) => {
      const block = blocks[i];
      if (!block) return;
      setCursor({ path, index: i });
      setReveal({ block, n: ++seq.current });
    },
    [blocks, path],
  );

  const stepFileBy = (dir: 1 | -1, landOn?: "first" | "last") => {
    const next = stepFile(nav, path, dir);
    if (!next) return setHint(dir === 1 ? "That was the last file." : "That was the first file.");
    select(next.path);
    if (landOn) setEdge({ at: landOn, n: ++seq.current });
  };
  const stepChangeBy = (dir: 1 | -1) => {
    const s = stepChange(blocks.length, index, dir);
    if (s.kind === "in") return goTo(s.index);
    stepFileBy(s.dir, s.dir === 1 ? "first" : "last");
  };

  const startLine = (anchor: Anchor | null, suggest: boolean) => {
    const from = anchor ?? (index !== null && blocks[index] ? { side: blocks[index].side, start: blocks[index].line, end: blocks[index].end } : null);
    if (!from) return setHint("Select some lines, or press j to land on a change, then comment.");
    const problem = anchorProblem(hunks, from, suggest);
    if (problem) return setHint(problem);
    setComposer({ n: ++seq.current, state: { kind: "line", anchor: from, suggest } });
  };
  const toggleViewed = () => file && void actions.setViewed(file.path, !file.viewed);

  const onKey = (a: ReviewKeyAction) => {
    if (a === "next-change") stepChangeBy(1);
    else if (a === "prev-change") stepChangeBy(-1);
    else if (a === "next-file") stepFileBy(1);
    else if (a === "prev-file") stepFileBy(-1);
    else if (a === "viewed") toggleViewed();
    else startLine(selection.current, a === "suggest");
  };
  useReviewKeys(root, onKey);

  // The keys listen on the review itself: take focus when it opens, so they work without a first click.
  useEffect(() => root.current?.focus({ preventScroll: true }), []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.patch(reviewId, { refresh: true });
      await props.reload();
      setBehind(false);
    } catch (e) {
      setHint(`Refresh failed: ${errorMessage(e)}. Check your connection and try again.`);
    } finally {
      setRefreshing(false);
    }
  };

  const jumpTo = (w: { path: string; line?: number | undefined; side?: "new" | "old" | undefined }) => {
    select(w.path);
    setPendingOpen(false);
    if (w.line !== undefined) setHint(`${w.path}:${w.line}. Press j or k to move between changes.`);
  };

  // The composer's field held focus; the review's keys need it back on the review when the box closes.
  const closeComposer = () => {
    setComposer(null);
    root.current?.focus({ preventScroll: true });
  };

  const saveComposer = async (c: { n: number; state: ComposerState }, v: ComposerValue): Promise<string | null> => {
    const s = c.state;
    let problem: string | null;
    if (s.kind === "line" && file) {
      problem = anchorProblem(hunks, s.anchor, v.suggestion !== undefined);
      problem ??= await actions.addComment(lineCommentInput(file.path, s.anchor, v.body, v.suggestion));
    } else if (s.kind === "file" && file) problem = await actions.addComment(fileCommentInput(file.path, v.body));
    else if (s.kind === "general") problem = await actions.addComment(generalCommentInput(v.body));
    else if (s.kind === "edit")
      problem = await actions.updateComment(s.comment, { body: v.body, ...(v.suggestion !== undefined ? { suggestion: v.suggestion } : {}) });
    else problem = null;
    if (!problem) closeComposer();
    return problem;
  };

  const composerEl = composer && file && (
    <ComposerFor
      key={composer.n}
      state={composer.state}
      path={file.path}
      after={after}
      onSave={(v) => saveComposer(composer, v)}
      onCancel={() => setComposer(null)}
    />
  );

  const here = comments.filter((c) => c.path === path && c.line !== undefined);
  const commented: Marked[] = here.map((c) => ({ side: c.side ?? "new", start: c.start_line ?? c.line ?? 1, end: c.line ?? 1 }));
  const flagged: Marked[] = findings.filter((f) => f.path === path && f.status === "new").map((f) => ({ side: "new", start: f.start_line, end: f.end_line }));
  const pickerEl = narrow && <FilePicker sections={shownSections} selected={path} onSelect={select} onStep={stepFileBy} />;

  return (
    <div ref={root} tabIndex={-1} className="relative flex h-full min-h-0 min-w-0 flex-col bg-panel outline-none" data-review>
      <ReviewHeader
        review={review}
        viewed={data.files.viewed_count}
        pending={comments.length}
        behind={behind}
        overviewOpen={overview}
        refreshing={refreshing}
        onOverview={() => setOverview((o) => !o)}
        onPending={() => setPendingOpen((o) => !o)}
        onSubmit={() => setSheet(true)}
        onRefresh={() => void refresh()}
        onBack={props.onBack}
      />
      {overview && <Overview review={review} />}
      <Banners
        review={review}
        newCommits={newCommits}
        onlyNew={onlyNew}
        count={sinceReview(files).length}
        onOnlyNew={setOnlyNew}
        api={api}
        onReopened={props.reload}
      />
      <div className="flex min-h-0 flex-1">
        {!narrow && file && (
          <div style={{ width: FILES_WIDTH }} className="shrink-0 overflow-y-auto border-r border-line">
            <FileList
              sections={shownSections}
              selected={path}
              opened={opened}
              onToggleGroup={(g) => setOpened((o) => (o.has(g) ? new Set([...o].filter((x) => x !== g)) : new Set([...o, g])))}
              onSelect={select}
              onViewed={(p, v) => void actions.setViewed(p, v)}
            />
          </div>
        )}
        {file ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <DiffPane
              file={file}
              diff={path === null ? { status: "idle" } : diffState.state}
              onRetry={diffState.retry}
              theme={props.theme}
              loadMonaco={props.loadMonaco}
              split={diffLayout(wideWindow ? DIFF_SPLIT_MIN : 0, width === null ? 0 : width - (narrow ? 0 : FILES_WIDTH)) === "split"}
              ignoreWhitespace={ignoreWhitespace}
              expanded={expanded}
              sinceReview={filterSince}
              rawUrl={(side) => api.rawUrl(reviewId, file.path, side)}
              commented={commented}
              flagged={flagged}
              reveal={reveal}
              onToggleWhitespace={() => setIgnoreWhitespace((x) => !x)}
              onToggleExpanded={() => setExpanded((x) => !x)}
              onViewed={(v) => void actions.setViewed(file.path, v)}
              onFileComment={() => setComposer({ n: ++seq.current, state: { kind: "file" } })}
              onStepChange={stepChangeBy}
              onAnchor={(a) => startLine(a, false)}
              onSelection={(a) => {
                selection.current = a;
                if (a) setCursor({ path, index: cursorFor(blocks, a) });
                setEdge(null);
              }}
              composer={composerEl}
              picker={pickerEl}
            />
            {hint && (
              <p role="status" className={cn("shrink-0 border-t border-line px-3 py-1.5 text-xs text-fg-2")}>
                {hint}
              </p>
            )}
          </div>
        ) : (
          <Notice title={filterSince ? "Nothing changed since your review" : "No changed files"}>
            {filterSince ? "Turn off “Only what changed since your review” to read the whole pull request." : "This review has no file changes."}
          </Notice>
        )}
      </div>
      {pendingOpen && (
        <PendingPanel
          comments={comments}
          findings={findings}
          problem={actions.problem}
          onJump={jumpTo}
          onEdit={(c) => {
            setPendingOpen(false);
            setComposer({ n: ++seq.current, state: { kind: "edit", comment: c } });
            if (c.path) setPick(c.path);
          }}
          onDelete={(c) => void actions.deleteComment(c)}
          onDecide={(f: ReviewFinding, d) => void actions.decideFinding(f, d)}
          onGeneral={() => {
            setPendingOpen(false);
            setComposer({ n: ++seq.current, state: { kind: "general" } });
          }}
          onClose={() => setPendingOpen(false)}
        />
      )}
      <Presence show={sheet}>
        <SubmitSheet
          api={api}
          review={review}
          onClose={() => setSheet(false)}
          onSubmitted={() => void props.reload()}
          onCommentsChanged={() => void props.reload()}
        />
      </Presence>
    </div>
  );
}

/** Where `j` continues from after the reader clicked or selected `a`: that change, or the one before the next change. */
function cursorFor(blocks: readonly ChangeBlock[], a: Anchor): number | null {
  const i = blockAt(blocks, a.side, a.start);
  if (i === null) return blocks.length ? blocks.length - 1 : null;
  const b = blocks[i];
  const exact = b?.side === a.side && a.start >= b.line && a.start <= b.end;
  const at = exact ? i : i - 1;
  return at < 0 ? null : at;
}

function ComposerFor(props: { state: ComposerState; path: string; after: string; onSave(v: ComposerValue): Promise<string | null>; onCancel(): void }) {
  const s = props.state;
  if (s.kind === "line") {
    const where = commentWhere({ path: props.path, line: s.anchor.end, ...(s.anchor.start < s.anchor.end ? { start_line: s.anchor.start } : {}) });
    const lines = s.anchor.start < s.anchor.end ? `lines ${s.anchor.start}–${s.anchor.end}` : `line ${s.anchor.start}`;
    return (
      <Composer
        heading={`Comment on ${where}${s.anchor.side === "old" ? " (removed side)" : ""}`}
        {...(s.anchor.side === "new" ? { suggestFor: lines } : {})}
        initialBody=""
        initialSuggestion={s.suggest ? linesOf(props.after, s.anchor.start, s.anchor.end) : undefined}
        linesText={linesOf(props.after, s.anchor.start, s.anchor.end)}
        saveLabel="Add comment"
        onSave={props.onSave}
        onCancel={props.onCancel}
      />
    );
  }
  if (s.kind === "edit") {
    const c = s.comment;
    return (
      <Composer
        heading={`Edit comment · ${commentWhere(c)}`}
        initialBody={c.body}
        initialSuggestion={c.suggestion}
        linesText=""
        saveLabel="Save comment"
        onSave={props.onSave}
        onCancel={props.onCancel}
      />
    );
  }
  return (
    <Composer
      heading={s.kind === "file" ? `Comment on the file ${props.path}` : "General comment on the review"}
      initialBody=""
      initialSuggestion={undefined}
      linesText=""
      saveLabel="Add comment"
      onSave={props.onSave}
      onCancel={props.onCancel}
    />
  );
}

function Banners(props: {
  review: Review;
  newCommits: boolean;
  onlyNew: boolean;
  count: number;
  onOnlyNew(v: boolean): void;
  api: ReviewApi;
  onReopened(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reopen = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.api.patch(props.review.id, { state: "open" });
      await props.onReopened();
    } catch (e) {
      setError(`${errorMessage(e)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {props.review.state === "closed" && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 text-sm">
          <span className="text-fg-2">This review is closed. You can read it; reopen it to comment.</span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void reopen()}>
            Reopen
          </Button>
          {error && <span className="text-xs text-err">{error}</span>}
        </div>
      )}
      {props.newCommits && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-sm">
          <span className="text-warn">
            New commits since your review: {props.count} {props.count === 1 ? "file" : "files"} changed.
          </span>
          <label className="flex min-h-6 cursor-pointer items-center gap-2 text-fg-2 max-md:min-h-10">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--octo-primary)]"
              checked={props.onlyNew}
              onChange={(e) => props.onOnlyNew(e.target.checked)}
            />
            Only what changed since your review
          </label>
        </div>
      )}
    </>
  );
}
