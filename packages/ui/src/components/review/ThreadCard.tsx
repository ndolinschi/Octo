import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReviewComment, ReviewThread } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { focusSoon } from "../../lib/focus";
import { timeAgo } from "../../lib/format";
import { threadSummary, visibleComments } from "../../lib/review/threads";
import { Button, IconButton } from "../primitives/Button";
import { Textarea } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { FormActions } from "../primitives/Panel";
import { proseClass } from "../primitives/Prose";
import { Markdown } from "../shared/Markdown";
import { PR_TEXT } from "./ExternalText";

/** What the card needs from the review: write a reply (resolves to a sentence on failure), delete a pending one. */
export type ThreadActions = { reply(thread: ReviewThread, body: string): Promise<string | null>; deleteReply(c: ReviewComment): void; readOnly: boolean };

/**
 * An existing review thread (decision 78): author, time and the text of each comment as Markdown (images as words,
 * links only to the web: `PR_TEXT`; the header no longer says "Others' text, shown as text", which read as noise); replies fold after two; a resolved thread is one line until opened; "Reply" makes a pending comment the
 * submit sheet counts. Used inline in the diff and in the list of threads that have no line.
 */
export function ThreadCard(props: {
  thread: ReviewThread;
  pending: readonly ReviewComment[];
  actions: ThreadActions;
  now: number;
  showPath?: boolean;
  /**
   * The reply being written (null: no reply box). Owned by the review, so the thread list's card and the diff's visual copy
   * show the same draft.
   */
  draft: string | null;
  onDraft(body: string | null): void;
  /** In the thread list a card is always open (the list row folds it); in the diff a resolved thread folds to one line. */
  fold?: boolean;
}) {
  const t = props.thread;
  const fold = props.fold ?? true;
  const [openState, setOpen] = useState(!t.resolved);
  const open = openState || !fold;
  const [all, setAll] = useState(false);
  const replying = props.draft !== null;
  // Only the copy whose Reply was pressed takes focus into its box (the other copy shows the same draft without moving focus).
  const [own, setOwn] = useState(false);
  // The reply box held focus: when it closes (Cancel, Esc, added), focus goes back to the thread's Reply button.
  const replyButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (replying || !refocus.current) return;
    refocus.current = false;
    // In the diff the card lives in Monaco's view-zone layer: a plain focus() scrolls the editor's own layers natively, Monaco
    // then re-renders its zones and the focused element is hidden for a frame (focus falls to the page). Never scroll on focus.
    replyButton.current?.focus({ preventScroll: true });
    // The card shrinks and Monaco lays its zone out again; if that still drops focus to the page, take it back once.
    focusSoon(() => replyButton.current, { onlyIfLost: true, timeout: 800 });
  }, [replying]);
  const closeReply = () => {
    refocus.current = own;
    setOwn(false);
    props.onDraft(null);
  };
  const { shown, hidden } = visibleComments(t.comments, all);

  if (!open)
    return (
      <ListRow
        size="sm"
        tone="quiet"
        expanded={false}
        leading={<Glyph icon={ChevronRight} size={14} />}
        title={`Resolved · ${threadSummary(t)}`}
        onClick={() => setOpen(true)}
        className="bg-raised"
      />
    );

  return (
    <section
      aria-label={`Thread on ${t.path}${t.line ? ` line ${t.line}` : ""}`}
      // R4 (polish step 6b): a card is a tone, no outline (step 1's rule); inside it a field is recessed (`octo-in-card`).
      className="octo-in-card flex flex-col gap-2 rounded-md bg-raised p-3 text-sm"
    >
      <header className="flex min-h-5 items-center gap-2 text-xs text-fg-3">
        {props.showPath && (
          <span className="min-w-0 truncate font-mono" title={t.path}>
            {t.path}
            {t.original_line ? `:${t.original_line}` : ""}
          </span>
        )}
        <span className="shrink-0">{t.outdated ? "Outdated: the code changed since this comment was written" : t.resolved ? "Resolved" : "Unresolved"}</span>
        {t.side === "old" && !t.outdated && <span className="shrink-0">removed side</span>}
        <span aria-hidden className="min-w-0 flex-1" />
        {t.resolved && fold && <IconButton icon={ChevronDown} label="Collapse the thread" onClick={() => setOpen(false)} />}
      </header>
      {shown.map((c, i) => (
        <div key={c.id} className={cn("flex flex-col gap-1", i > 0 && "border-t border-line pt-2")}>
          <p className="flex items-baseline gap-2 text-xs">
            <span className="font-medium text-fg">{c.author}</span>
            <span className="text-fg-3">{timeAgo(c.created_at, props.now)}</span>
          </p>
          <Markdown text={c.body} components={PR_TEXT} className={proseClass("compact")} />
          {i === 0 && hidden > 0 && (
            <Button variant="link" size="xs" onClick={() => setAll(true)} className="w-fit px-1">
              {hidden === 1 ? "1 more reply" : `${hidden} more replies`}
            </Button>
          )}
        </div>
      ))}
      {props.pending.map((c) => (
        <div key={c.id} className="flex items-start gap-2 border-t border-line pt-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-xs text-fg-3">Your reply · pending until you submit the review</p>
            <p className="break-words whitespace-pre-wrap text-fg">{c.body}</p>
          </div>
          {!props.actions.readOnly && <IconButton icon={Trash2} label="Delete this reply" onClick={() => props.actions.deleteReply(c)} />}
        </div>
      ))}
      {!props.actions.readOnly &&
        (replying ? (
          <ReplyBox
            body={props.draft ?? ""}
            onBody={props.onDraft}
            takeFocus={own}
            onCancel={closeReply}
            onSave={async (body) => {
              const problem = await props.actions.reply(t, body);
              if (!problem) closeReply();
              return problem;
            }}
          />
        ) : (
          <Button
            ref={replyButton}
            variant="quiet"
            size="sm"
            onClick={() => {
              setOwn(true);
              props.onDraft("");
            }}
            className="-ml-2 w-fit"
          >
            Reply
          </Button>
        ))}
    </section>
  );
}

function ReplyBox(props: { body: string; onBody(body: string): void; takeFocus: boolean; onSave(body: string): Promise<string | null>; onCancel(): void }) {
  const { body, takeFocus } = props;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // `preventScroll`: see the Reply button above (a scroll inside Monaco's layers hid the zone and dropped the caret).
    if (takeFocus) field.current?.focus({ preventScroll: true });
  }, [takeFocus]);
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    const p = await props.onSave(body.trim());
    if (p) setProblem(p);
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={field}
        rows={3}
        value={body}
        aria-label="Your reply"
        placeholder="Write a reply"
        onChange={(e) => props.onBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onCancel();
          }
        }}
        className="max-sm:text-input-touch"
      />
      {problem && (
        <p role="alert" className="text-xs text-err">
          {problem}
        </p>
      )}
      {/* P2's action row: a dim note at the left, then Cancel and the primary at the right. */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3">Posted with your review.</span>
        <FormActions>
          <Button variant="quiet" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!body.trim() || busy} onClick={() => void save()}>
            Add reply
          </Button>
        </FormActions>
      </div>
    </div>
  );
}
