import { Check, Clock, MessageSquarePlus, X } from "lucide-react";
import { useRef } from "react";
import type { Approval, ApprovalAnswer, ApprovalOption } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import {
  APPROVAL_TIMEOUT_MS,
  APPROVAL_URGENT_MS,
  approvalCaption,
  approvalDeadline,
  formatCountdown,
  isAllowOption,
  resolutionLabel,
  type Resolution,
} from "../../lib/v7/approval";
import { splitPath } from "../../lib/v7/changes";
import { Button } from "../primitives/Button";
import { Textarea } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { StateGlyph } from "../primitives/StateGlyph";
import { Spinner } from "../primitives/Status";
import { CardFrame, DiffBar, focusOnMount, ErrorLine, Kbd, LineCounts } from "./parts";
import { useApprovalCard, type Busy } from "./useApprovalCard";

export type ApprovalCardProps = {
  approval: Approval;
  /** Set once the request is answered (here, by the timer, a cancel or another window): the card is one line. */
  resolution: Resolution | null;
  /** `HARNESS_APPROVAL_TIMEOUT` when the host knows it; 0 = never. */
  timeoutMs?: number;
  /** Take focus when it appears unless the user is typing (the newest pending card). */
  focusOnArrival?: boolean;
  onResolve(id: string, answer: ApprovalAnswer): Promise<void>;
  /** The card's own answer, the timer running out, or a 404 (answered elsewhere): the owner keeps it as resolved. */
  onResolved(id: string, resolution: Resolution): void;
  /** Opens the requesting agent's tab (the role is a link when given). */
  onOpenAgent?(agentId: string): void;
};

/** A pending approval in the conversation (v7 §3, decision 46): what will run, the three answers, keys, the countdown. */
export function ApprovalCard(props: ApprovalCardProps) {
  const { approval } = props;
  const deadline = approvalDeadline(approval.created_at, props.timeoutMs ?? APPROVAL_TIMEOUT_MS);
  const now = useNow(props.resolution === null && deadline !== null);
  const left = deadline === null ? null : deadline - now;
  if (props.resolution) return <ResolvedApproval approval={approval} resolution={props.resolution} />;
  if (left !== null && left <= 0) return <ResolvedApproval approval={approval} resolution={{ decision: "deny", by: "timeout" }} />;
  return <PendingApproval {...props} left={left} />;
}

function PendingApproval(props: ApprovalCardProps & { left: number | null }) {
  const { approval, left } = props;
  const card = useRef<HTMLElement>(null);
  const c = useApprovalCard({
    approval,
    card,
    focusOnArrival: props.focusOnArrival ?? false,
    onResolve: props.onResolve,
    onResolved: (r) => props.onResolved(approval.id, r),
  });
  const options = approval.detail.options ?? [];
  const disabled = c.busy !== null;
  const noteId = `v7-note-${approval.id}`;
  return (
    <CardFrame
      ref={card}
      attention
      pulse
      tabIndex={0}
      aria-label={`${approval.agent_label} asks: ${approval.title}. A to allow, D to deny.`}
      aria-keyshortcuts="A D Enter"
      onKeyDown={c.onKeyDown}
      data-v7-approval={approval.id}
      className="focus-visible:shadow-[0_0_0_2px_var(--octo-focus)]"
    >
      <header className="flex h-8 min-w-0 items-center gap-2 px-3">
        <StateGlyph state="needs" />
        <span className="min-w-0 truncate text-fg-2">
          {props.onOpenAgent ? (
            <button type="button" className="press text-fg hover:underline" onClick={() => props.onOpenAgent?.(approval.agent_id)}>
              {approval.agent_label}
            </button>
          ) : (
            <span className="text-fg">{approval.agent_label}</span>
          )}{" "}
          · {approvalCaption(approval)}
        </span>
        {left !== null && (
          <span
            className={cn("ml-auto shrink-0 text-xs tabular-nums", left < APPROVAL_URGENT_MS ? "text-warn" : "text-fg-3")}
            title="Unanswered requests are denied automatically"
          >
            <span className="@max-[360px]/v7:hidden">Auto-deny in </span>
            {formatCountdown(left)}
          </span>
        )}
      </header>
      <div className="flex flex-col gap-2 px-3">
        <ApprovalSubject approval={approval} />
        {c.noteOpen && (
          <Textarea
            id={noteId}
            aria-label="Note for the agent"
            placeholder="Why, or what to do instead (sent with a denial)"
            rows={2}
            value={c.note}
            onChange={(e) => c.setNote(e.target.value)}
            ref={focusOnMount}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 p-3">
        {options.length > 0 ? (
          options.map((o, i) => <OptionButton key={o.id} option={o} primary={i === 0 && isAllowOption(o)} busy={c.busy} onClick={() => c.choose(o)} />)
        ) : (
          <>
            <ActionButton variant="primary" busy={c.busy} action="allow" disabled={disabled} onClick={() => c.act("allow")} shortcut="A">
              Allow once
            </ActionButton>
            <ActionButton variant="secondary" busy={c.busy} action="allow_for_turn" disabled={disabled} onClick={() => c.act("allow_for_turn")}>
              Allow for this turn
            </ActionButton>
            <ActionButton variant="danger" busy={c.busy} action="deny" disabled={disabled} onClick={() => c.act("deny")} shortcut="D">
              Deny
            </ActionButton>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={MessageSquarePlus}
          className="ml-auto max-md:h-10"
          aria-expanded={c.noteOpen}
          aria-controls={c.noteOpen ? noteId : undefined}
          onClick={() => c.setNoteOpen(!c.noteOpen)}
        >
          {c.noteOpen ? "No note" : "Add note"}
        </Button>
        {c.error && <ErrorLine className="basis-full">{c.error}</ErrorLine>}
      </div>
    </CardFrame>
  );
}

/** The thing to approve: a path with its line counts, a command in mono, or the ACP tool's title (and its command / path). */
function ApprovalSubject({ approval }: { approval: Approval }) {
  const { detail } = approval;
  const path = detail.path ? splitPath(detail.path) : null;
  return (
    <>
      {approval.kind === "acp" && <p className="min-w-0 [overflow-wrap:anywhere] text-fg">{approval.title}</p>}
      {detail.command !== undefined && (
        <pre className="octo-code max-h-40 overflow-auto rounded-sm bg-code-bg px-3 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
          <span className="text-fg-3 select-none">$ </span>
          {detail.command}
        </pre>
      )}
      {path && (
        <div className="flex min-h-7 min-w-0 items-center gap-2 rounded-sm bg-code-bg px-3 py-1 font-mono text-xs">
          <span className="min-w-0 truncate" title={`${detail.folder ? `${detail.folder}/` : ""}${detail.path ?? ""}`}>
            {path.dir && <span className="text-fg-3">{path.dir}/</span>}
            <span className="text-fg">{path.name}</span>
          </span>
          {detail.diff && (
            <span className="ml-auto flex shrink-0 items-center gap-2 font-sans">
              <LineCounts added={detail.diff.added} removed={detail.diff.removed} />
              <DiffBar added={detail.diff.added} removed={detail.diff.removed} />
            </span>
          )}
        </div>
      )}
      {approval.kind === "write" && !path && <p className="[overflow-wrap:anywhere] text-fg">{approval.title}</p>}
    </>
  );
}

function ActionButton(props: {
  variant: "primary" | "secondary" | "danger";
  action: "allow" | "allow_for_turn" | "deny";
  busy: Busy;
  disabled: boolean;
  shortcut?: string;
  onClick(): void;
  children: string;
}) {
  const mine = props.busy === props.action;
  return (
    <Button
      variant={props.variant}
      size="sm"
      className="max-md:h-10"
      disabled={props.disabled}
      aria-busy={mine}
      aria-keyshortcuts={props.shortcut}
      onClick={props.onClick}
    >
      {mine && <Spinner size={12} className="text-current" />}
      {props.children}
      {props.shortcut && !mine && <Kbd>{props.shortcut}</Kbd>}
    </Button>
  );
}

function OptionButton({ option, primary, busy, onClick }: { option: ApprovalOption; primary: boolean; busy: Busy; onClick(): void }) {
  const mine = busy === `option:${option.id}`;
  const allow = isAllowOption(option);
  return (
    <Button
      variant={primary ? "primary" : allow ? "secondary" : "danger"}
      size="sm"
      className="max-md:h-10"
      disabled={busy !== null}
      aria-busy={mine}
      onClick={onClick}
    >
      {mine && <Spinner size={12} className="text-current" />}
      {option.label}
    </Button>
  );
}

/** One line once answered: what happened, to what, by whom; the note in the tooltip. */
function ResolvedApproval({ approval, resolution }: { approval: Approval; resolution: Resolution }) {
  const allowed = resolution.decision !== "deny";
  const icon = resolution.by === "timeout" ? Clock : allowed ? Check : X;
  return (
    <CardFrame aria-label={`${resolutionLabel(resolution)}: ${approval.title}`} data-v7-approval={approval.id} data-resolved="">
      <div className="flex h-8 min-w-0 items-center gap-2 px-3" title={resolution.note ? `Note: ${resolution.note}` : undefined}>
        <Glyph icon={icon} size={14} className={cn("shrink-0", allowed ? "text-ok" : resolution.by === "timeout" ? "text-warn" : "text-err")} />
        <span className="shrink-0 text-fg-2">{resolutionLabel(resolution)}</span>
        <span className="min-w-0 truncate font-mono text-xs text-fg-3">{approval.detail.command ?? approval.detail.path ?? approval.title}</span>
        <span className="ml-auto shrink-0 text-xs text-fg-3 @max-[360px]/v7:hidden">{approval.agent_label}</span>
      </div>
    </CardFrame>
  );
}
