import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReviewComment, ReviewThread } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { threadSummary, visibleComments } from "../../lib/review/threads";
import { Button, IconButton } from "../primitives/Button";
import { Textarea } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { proseClass } from "../primitives/Prose";
import { Markdown } from "../shared/Markdown";
import { PR_TEXT } from "./ExternalText";

/** What the card needs from the review: write a reply (resolves to a sentence on failure), delete a pending one. */
export type ThreadActions = { reply(thread: ReviewThread, body: string): Promise<string | null>; deleteReply(c: ReviewComment): void; readOnly: boolean };

/**
 * An existing review thread (decision 78): author, time and the text of each comment as Markdown marked as other
 * people's text; replies fold after two; a resolved thread is one line until opened; "Reply" makes a pending comment the
 * submit sheet counts. Used inline in the diff and in the list of threads that have no line.
 */
export function ThreadCard(props: { thread: ReviewThread; pending: readonly ReviewComment[]; actions: ThreadActions; now: number; showPath?: boolean }) {
  const t = props.thread;
  const [open, setOpen] = useState(!t.resolved);
  const [all, setAll] = useState(false);
  const [replying, setReplying] = useState(false);
  // The reply box held focus: when it closes (Cancel, Esc, added), focus goes back to the thread's Reply button.
  const replyButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (replying || !refocus.current) return;
    refocus.current = false;
    replyButton.current?.focus();
  }, [replying]);
  const closeReply = () => {
    refocus.current = true;
    setReplying(false);
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
        className="border border-line bg-raised"
      />
    );

  return (
    <section
      aria-label={`Thread on ${t.path}${t.line ? ` line ${t.line}` : ""}`}
      className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3 text-sm"
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
        <span className="min-w-0 flex-1 truncate text-right">Others' text, shown as text</span>
        {t.resolved && <IconButton icon={ChevronDown} label="Collapse the thread" onClick={() => setOpen(false)} className="max-md:size-10" />}
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
          {!props.actions.readOnly && (
            <IconButton icon={Trash2} label="Delete this reply" onClick={() => props.actions.deleteReply(c)} className="max-md:size-10" />
          )}
        </div>
      ))}
      {!props.actions.readOnly &&
        (replying ? (
          <ReplyBox
            onCancel={closeReply}
            onSave={async (body) => {
              const problem = await props.actions.reply(t, body);
              if (!problem) closeReply();
              return problem;
            }}
          />
        ) : (
          <Button ref={replyButton} variant="ghost" size="sm" onClick={() => setReplying(true)} className="w-fit max-md:h-10">
            Reply
          </Button>
        ))}
    </section>
  );
}

function ReplyBox(props: { onSave(body: string): Promise<string | null>; onCancel(): void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
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
        onChange={(e) => setBody(e.target.value)}
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
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={!body.trim() || busy} onClick={() => void save()} className="max-md:h-10">
          Add reply
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel} className="max-md:h-10">
          Cancel
        </Button>
        <span className="text-xs text-fg-3 max-sm:hidden">Posted with your review.</span>
      </div>
    </div>
  );
}
