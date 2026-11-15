import { Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReviewComment, ReviewFinding, ReviewFindingDecision } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { commentWhere } from "../../lib/review/position";
import { Button, IconButton } from "../primitives/Button";
import { Input } from "../primitives/Field";
import { Segmented } from "../primitives/Segmented";

type Tab = "comments" | "findings";

/** R5 (polish step 6b): pending comments and findings are list rows split by hairlines, not outlined cards on the overlay. */
const PENDING_ROW = "flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-1";

const SEVERITY_TONE: Record<ReviewFinding["severity"], string> = {
  critical: "text-err",
  high: "text-err",
  medium: "text-warn",
  low: "text-fg-2",
  info: "text-fg-3",
};

/**
 * The pending comments of this review (edit, delete, jump to the line) and, when the harness has any, its findings with
 * keep / dismiss. Nothing here is posted until the review is submitted.
 */
export function PendingPanel(props: {
  comments: readonly ReviewComment[];
  findings: readonly ReviewFinding[];
  problem: string | null;
  onJump(where: { path: string; line?: number | undefined; side?: "new" | "old" | undefined }): void;
  onEdit(c: ReviewComment): void;
  onDelete(c: ReviewComment): void;
  onDecide(f: ReviewFinding, d: ReviewFindingDecision): void;
  onGeneral(): void;
  onClose(): void;
}) {
  const [tab, setTab] = useState<Tab>(props.comments.length === 0 && props.findings.length > 0 ? "findings" : "comments");
  const box = useRef<HTMLElement>(null);
  const { onClose } = props;
  // Closing returns focus to the control that opened the panel (when nothing else took it, like the comment box does).
  // The opener is read while rendering, before the panel takes focus (an effect would see the panel itself on a re-run).
  const [opener] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if ((!now || now === document.body) && opener instanceof HTMLElement && opener.isConnected) opener.focus();
      });
    },
    [opener],
  );
  useEffect(() => {
    const el = box.current;
    el?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    el?.addEventListener("keydown", onKeyDown);
    return () => el?.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <aside
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label="Pending comments and findings"
      className="absolute inset-y-0 right-0 z-20 flex w-[400px] max-w-full flex-col border-l border-line-strong bg-overlay shadow-pop outline-none"
    >
      <header className="flex h-ctl-lg shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="text-heading text-fg">Pending</h2>
        <span className="min-w-0 truncate text-xs text-fg-3">Posted only when you submit</span>
        <IconButton icon={X} label="Close" onClick={props.onClose} className="ml-auto max-md:size-10" />
      </header>
      {props.findings.length > 0 && (
        <div className="shrink-0 border-b border-line px-4 py-2">
          <Segmented<Tab>
            label="Pending list"
            value={tab}
            onChange={setTab}
            options={[
              { id: "comments", label: `Comments ${props.comments.length}` },
              { id: "findings", label: `Findings ${props.findings.length}` },
            ]}
          />
        </div>
      )}
      {props.problem && (
        <p role="alert" className="border-b border-line px-4 py-2 text-xs text-err">
          {props.problem}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === "comments" ? (
          props.comments.length === 0 ? (
            <p className="text-sm text-fg-3">
              No pending comments. Hover a line and press the “+” in the gutter, or select lines and press <kbd className="font-sans">c</kbd>.
            </p>
          ) : (
            <ul className="flex flex-col">
              {props.comments.map((c) => (
                <CommentCard key={c.id} c={c} onJump={props.onJump} onEdit={props.onEdit} onDelete={props.onDelete} />
              ))}
            </ul>
          )
        ) : (
          <ul className="flex flex-col">
            {props.findings.map((f) => (
              <FindingCard key={f.id} f={f} onJump={props.onJump} onDecide={props.onDecide} />
            ))}
          </ul>
        )}
      </div>
      <footer className="flex shrink-0 justify-end border-t border-line p-2">
        <Button size="sm" variant="secondary" onClick={props.onGeneral} className="max-md:h-10">
          Add a general comment
        </Button>
      </footer>
    </aside>
  );
}

function CommentCard(props: {
  c: ReviewComment;
  onJump: (w: { path: string; line?: number; side?: "new" | "old" }) => void;
  onEdit(c: ReviewComment): void;
  onDelete(c: ReviewComment): void;
}) {
  const { c } = props;
  const [confirm, setConfirm] = useState(false);
  const jump = () =>
    c.path && props.onJump({ path: c.path, ...(c.line !== undefined ? { line: c.start_line ?? c.line } : {}), ...(c.side ? { side: c.side } : {}) });
  return (
    <li className={PENDING_ROW}>
      <div className="flex min-w-0 items-center gap-1">
        {c.path ? (
          <Button variant="link" mono size="xs" onClick={jump} className="min-w-0 truncate" title={commentWhere(c)}>
            {commentWhere(c)}
          </Button>
        ) : (
          <span className="text-xs font-medium text-fg-2">General comment</span>
        )}
        {c.side === "old" && <span className="shrink-0 text-xs text-fg-3">removed side</span>}
        <span className="ml-auto flex shrink-0 items-center">
          {confirm ? (
            <>
              <span className="mr-1 text-xs text-fg-2">Delete?</span>
              <Button size="sm" variant="danger" className="h-6 px-2" onClick={() => props.onDelete(c)}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <IconButton icon={Pencil} size="sm" label="Edit comment" onClick={() => props.onEdit(c)} className="max-md:size-10" />
              <IconButton icon={Trash2} size="sm" label="Delete comment" onClick={() => setConfirm(true)} className="max-md:size-10" />
            </>
          )}
        </span>
      </div>
      <p className="text-sm break-words whitespace-pre-wrap text-fg">{c.body}</p>
      {c.suggestion !== undefined && (
        <div className="overflow-hidden rounded-sm bg-code-bg">
          <p className="border-b border-line px-2 py-1 text-xs text-fg-3">Suggested change</p>
          <pre className="overflow-x-auto px-2 py-1.5 font-mono text-xs leading-5 text-fg">{c.suggestion || " "}</pre>
        </div>
      )}
      {c.finding_id && <p className="text-xs text-fg-3">Kept from a finding</p>}
    </li>
  );
}

function FindingCard(props: {
  f: ReviewFinding;
  onJump: (w: { path: string; line?: number; side?: "new" | "old" }) => void;
  onDecide(f: ReviewFinding, d: ReviewFindingDecision): void;
}) {
  const { f } = props;
  const [reason, setReason] = useState<string | null>(null);
  const lines = f.end_line > f.start_line ? `${f.start_line}–${f.end_line}` : `${f.start_line}`;
  return (
    <li className={cn(PENDING_ROW, f.status === "dismissed" && "opacity-70")}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0 text-xs font-medium", SEVERITY_TONE[f.severity])}>{f.severity}</span>
        <Button
          variant="link"
          mono
          size="xs"
          onClick={() => props.onJump({ path: f.path, line: f.start_line, side: "new" })}
          className="min-w-0 truncate"
          title={`${f.path}:${lines}`}
        >
          {f.path}:{lines}
        </Button>
        {f.verdict && <span className="ml-auto shrink-0 text-xs text-fg-3">{f.verdict}</span>}
      </div>
      <p className="text-sm [overflow-wrap:anywhere] text-fg">{f.statement}</p>
      {f.scenario && <p className="text-xs [overflow-wrap:anywhere] text-fg-2">{f.scenario}</p>}
      {f.patch && <pre className="overflow-x-auto rounded-sm bg-code-bg px-2 py-1.5 font-mono text-xs leading-5 text-fg">{f.patch}</pre>}
      {f.status === "new" && reason === null && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => props.onDecide(f, { status: "kept" })} className="max-md:h-10">
            Keep as my comment
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReason("")} className="max-md:h-10">
            Dismiss
          </Button>
        </div>
      )}
      {f.status === "new" && reason !== null && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            props.onDecide(f, { status: "dismissed", ...(reason.trim() ? { reason: reason.trim() } : {}) });
          }}
        >
          <Input
            aria-label="Why dismiss this finding (optional)"
            placeholder="Why? It tunes the next pass"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" type="submit">
              Dismiss finding
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReason(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {f.status !== "new" && (
        <p className="flex items-center gap-2 text-xs text-fg-3">
          {f.status === "kept" ? "Kept as a pending comment." : `Dismissed${f.dismiss_reason ? `: ${f.dismiss_reason}` : "."}`}
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" onClick={() => props.onDecide(f, { status: "new" })}>
            Undo
          </Button>
        </p>
      )}
    </li>
  );
}
