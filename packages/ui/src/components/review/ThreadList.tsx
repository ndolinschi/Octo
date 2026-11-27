import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReviewComment } from "@octo/agent-client";
import { useRowKeys } from "../../lib/hooksMore";
import { firstPhrase, threadsLabel, type ThreadRow } from "../../lib/review/threads";
import { useRovingRows } from "../../lib/rovingRows";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

/** The id the toggle's `aria-controls` names. */
const LIST_ID = "review-thread-list";

/**
 * The file bar's thread counter ("4 threads"): folds the accessible thread list open and shut. Nothing when the file has
 * no threads, so a file without discussion keeps its quiet bar.
 */
export function ThreadsToggle(props: { rows: readonly ThreadRow[]; open: boolean; onToggle(): void }) {
  if (props.rows.length === 0) return null;
  const label = threadsLabel(props.rows);
  return (
    <Button
      variant="quiet"
      size="sm"
      icon={MessageSquare}
      aria-expanded={props.open}
      aria-controls={LIST_ID}
      title={`${label} (n, p)`}
      onClick={props.onToggle}
      className="shrink-0 text-fg-2"
    >
      <span className="@max-xl/diff:sr-only">{label}</span>
      <span aria-hidden className="hidden @max-xl/diff:inline">
        {props.rows.length}
      </span>
    </Button>
  );
}

/**
 * The file's existing threads, outside Monaco (decision on review threads, polish pass F3): the threads drawn in the diff
 * live in Monaco's view-zone layer, which is `aria-hidden` and leaves zones outside the viewport out of the page, so the
 * zones are a visual copy and this list is the way in for the keyboard and assistive technology. One Tab stop (roving
 * rows); a row says where, who, the first sentence and the state; Enter unfolds the thread here (read, reply) and scrolls
 * the diff to its line. The reply draft is the review's, so this card and the visual copy show the same text.
 */
export function ThreadList(props: {
  rows: readonly ThreadRow[];
  open: boolean;
  current: string | null;
  /** Bumped when `n` / `p` chose `current`: focus goes to its row. */
  focusSeq: number;
  onCurrent(id: string | null, row: ThreadRow | null): void;
  pending: ReadonlyMap<string, ReviewComment[]>;
  drafts: ReadonlyMap<string, string>;
  onDraft(id: string, body: string | null): void;
  actions: ThreadActions;
  now: number;
}) {
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  useRovingRows(list);
  const { focusSeq, current } = props;
  useEffect(() => {
    if (focusSeq === 0 || current === null) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(current)}"] [data-row]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }, [focusSeq, current]);
  if (!props.open || props.rows.length === 0) return null;
  return (
    <div
      id={LIST_ID}
      ref={list}
      role="list"
      aria-label={threadsLabel(props.rows)}
      className="flex max-h-72 shrink-0 flex-col overflow-y-auto border-b border-line px-pane py-1"
    >
      {props.rows.map((r) => {
        const t = r.thread;
        const first = t.comments[0];
        const isOpen = props.current === t.id;
        const state = t.resolved ? "Resolved" : "Unresolved";
        return (
          <div key={t.id} role="listitem" data-thread={t.id} className="flex flex-col">
            <ListRow
              size="sm"
              tone={t.resolved ? "quiet" : "default"}
              expanded={isOpen}
              leading={<Glyph icon={isOpen ? ChevronDown : ChevronRight} size={14} />}
              title={
                <>
                  <span className="text-fg-2">{r.where}</span>
                  {first && (
                    <>
                      {" · "}
                      <span className="font-medium">{first.author}</span>
                      {` · ${firstPhrase(first.body)}`}
                    </>
                  )}
                </>
              }
              meta={state}
              onClick={() => props.onCurrent(isOpen ? null : t.id, isOpen ? null : r)}
            />
            {isOpen && (
              <div className="max-w-thread pt-1 pb-2 pl-6">
                <ThreadCard
                  thread={t}
                  fold={false}
                  pending={props.pending.get(t.id) ?? []}
                  draft={props.drafts.get(t.id) ?? null}
                  onDraft={(body) => props.onDraft(t.id, body)}
                  actions={props.actions}
                  now={props.now}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
