import { Check, Clock, MessageSquarePlus, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
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
import { alwaysLabel, canAlwaysAllow } from "../../lib/v7/rules";
import { Button } from "../primitives/Button";
import { Textarea } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { Card } from "../primitives/Card";
import { Notice } from "../primitives/Notice";
import { ApprovalSubject } from "./ApprovalSubject";
import { focusOnMount } from "./parts";
import { RequestCard } from "../shared/RequestCard";
import { useApprovalCard, type Busy } from "./useApprovalCard";

/** Opens on a click only, so it stays out of the entry chunk (bundle budget). */
const AlwaysPanel = lazy(() => import("./ApprovalExtras").then((m) => ({ default: m.AlwaysPanel })));

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
  /** One row of a group of requests: compact (title, the command on one line, quiet actions, details fold). */
  compact?: boolean;
  /** A compact row tells its group when its "Always allow" panel opens or closes (the panel's save is then the one primary). */
  onAlwaysOpen?(id: string, open: boolean): void;
};

/** The countdown text of a pending approval; null when it never times out. */
export function useApprovalLeft(createdAt: string | null, timeoutMs: number | undefined, active: boolean): number | null {
  const deadline = createdAt === null ? null : approvalDeadline(createdAt, timeoutMs ?? APPROVAL_TIMEOUT_MS);
  const now = useNow(active && deadline !== null);
  return deadline === null ? null : deadline - now;
}

export function Countdown({ left }: { left: number }) {
  return (
    <span className={cn(left < APPROVAL_URGENT_MS ? "text-warn" : "text-fg-3")} title="Unanswered requests are denied automatically">
      <span className="@max-[360px]/v7:hidden">Auto-deny in </span>
      {formatCountdown(left)}
    </span>
  );
}

/** A pending approval in the conversation (v7 §3, decision 46): what will run, the answers, keys, the countdown. */
export function ApprovalCard(props: ApprovalCardProps) {
  const { approval } = props;
  const left = useApprovalLeft(approval.created_at, props.timeoutMs, props.resolution === null);
  if (props.resolution) return <ResolvedApproval approval={approval} resolution={props.resolution} />;
  if (left !== null && left <= 0) return <ResolvedApproval approval={approval} resolution={{ decision: "deny", by: "timeout" }} />;
  return props.compact ? <CompactApproval {...props} /> : <PendingApproval {...props} left={left} />;
}

/** The agent's name, a link to its tab when the host can open it. */
function Asks({ approval, onOpenAgent }: { approval: Approval; onOpenAgent: ((id: string) => void) | undefined }) {
  if (!onOpenAgent) return <>{approval.agent_label}</>;
  return (
    <Button variant="link" tone="quiet" size="xs" onClick={() => onOpenAgent(approval.agent_id)}>
      {approval.agent_label}
    </Button>
  );
}

/** The three answers in the one order of decision 91c: primary, quiet alternatives, deny last. */
function useAnswers(approval: Approval, c: ReturnType<typeof useApprovalCard>, compact = false) {
  // While the "Always allow" panel is open its "Save rule and allow" is the primary; the plain allow steps back.
  const quiet = compact || c.alwaysOpen;
  const options = approval.detail.options ?? [];
  const disabled = c.busy !== null;
  if (options.length > 0) {
    const allows = options.filter(isAllowOption);
    const others = options.filter((o) => !isAllowOption(o));
    return {
      primary: allows[0] ? <OptionButton option={allows[0]} primary={!quiet} busy={c.busy} onClick={() => c.choose(allows[0] as ApprovalOption)} /> : null,
      alternatives: allows.slice(1).map((o) => <OptionButton key={o.id} option={o} primary={false} busy={c.busy} onClick={() => c.choose(o)} />),
      destructive: others.map((o) => <OptionButton key={o.id} option={o} primary={false} busy={c.busy} onClick={() => c.choose(o)} />),
    };
  }
  return {
    primary: (
      <ActionButton variant={quiet ? "secondary" : "primary"} busy={c.busy} action="allow" disabled={disabled} onClick={() => c.act("allow")} shortcut="A">
        Allow once
      </ActionButton>
    ),
    alternatives: (
      <ActionButton variant="quiet" busy={c.busy} action="allow_for_turn" disabled={disabled} onClick={() => c.act("allow_for_turn")}>
        Allow for this turn
      </ActionButton>
    ),
    destructive: (
      <ActionButton variant="danger" busy={c.busy} action="deny" disabled={disabled} onClick={() => c.act("deny")} shortcut="D">
        Deny
      </ActionButton>
    ),
  };
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
  const disabled = c.busy !== null;
  const rule = canAlwaysAllow(approval) ? approval.suggested_rule : undefined;
  const noteId = `v7-note-${approval.id}`;
  const answers = useAnswers(approval, c);
  return (
    <RequestCard
      ref={card}
      tabIndex={0}
      aria-label={`${approval.agent_label} asks: ${approval.title}. A to allow, D to deny.`}
      aria-keyshortcuts="A D Enter"
      onKeyDown={c.onKeyDown}
      data-v7-approval={approval.id}
      title={approvalCaption(approval)}
      asks={<Asks approval={approval} onOpenAgent={props.onOpenAgent} />}
      meta={left !== null ? <Countdown left={left} /> : undefined}
      primary={answers.primary}
      alternatives={
        <>
          {answers.alternatives}
          {rule && (
            <Button variant="quiet" size="sm" disabled={disabled} aria-expanded={c.alwaysOpen} onClick={() => c.setAlwaysOpen(!c.alwaysOpen)}>
              {alwaysLabel(rule)}
            </Button>
          )}
          <Button
            variant="quiet"
            size="sm"
            icon={MessageSquarePlus}
            aria-expanded={c.noteOpen}
            aria-controls={c.noteOpen ? noteId : undefined}
            data-note-toggle=""
            onClick={() => c.setNoteOpen(!c.noteOpen)}
          >
            {c.noteOpen ? "No note" : "Add note"}
          </Button>
        </>
      }
      destructive={answers.destructive}
      error={c.error}
    >
      <ApprovalSubject approval={approval} />
      {c.alwaysOpen && rule && (
        <Suspense fallback={<div className="h-24" />}>
          <AlwaysPanel
            rule={rule}
            busy={c.busy === "allow_always"}
            disabled={disabled}
            onSave={() => c.act("allow_always")}
            onCancel={() => c.setAlwaysOpen(false)}
          />
        </Suspense>
      )}
      {c.noteOpen && (
        <Textarea
          id={noteId}
          aria-label="Note for the agent"
          placeholder="Why, or what to do instead (sent with a denial)"
          rows={2}
          value={c.note}
          onChange={(e) => c.setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Esc closes the field (the text stays) and hands focus back to "Add note".
            e.stopPropagation();
            c.setNoteOpen(false);
            card.current?.querySelector<HTMLElement>("[data-note-toggle]")?.focus();
          }}
          ref={focusOnMount}
        />
      )}
    </RequestCard>
  );
}

/** The one mono line of a request: the command, the path or the host. */
export function subjectLine(a: Approval): string {
  return a.detail.command ?? a.detail.path ?? a.detail.url ?? a.title;
}

/** A row inside a group: title, the command on one line, quiet actions; the full subject folds behind "Details". */
function CompactApproval(props: ApprovalCardProps) {
  const { approval } = props;
  const card = useRef<HTMLElement>(null);
  const c = useApprovalCard({
    approval,
    card,
    focusOnArrival: props.focusOnArrival ?? false,
    onResolve: props.onResolve,
    onResolved: (r) => props.onResolved(approval.id, r),
  });
  const answers = useAnswers(approval, c, true);
  const rule = canAlwaysAllow(approval) ? approval.suggested_rule : undefined;
  const { onAlwaysOpen } = props;
  const alwaysOpen = c.alwaysOpen;
  useEffect(() => {
    onAlwaysOpen?.(approval.id, alwaysOpen);
    return () => onAlwaysOpen?.(approval.id, false);
  }, [onAlwaysOpen, approval.id, alwaysOpen]);
  return (
    <section
      ref={card}
      tabIndex={0}
      aria-label={`${approval.agent_label} asks: ${approval.title}. A to allow, D to deny.`}
      aria-keyshortcuts="A D Enter"
      onKeyDown={c.onKeyDown}
      data-v7-approval={approval.id}
      className="@container/v7 flex min-w-0 flex-col gap-1 rounded-sm px-2 py-2 focus-visible:shadow-[0_0_0_2px_var(--octo-focus)]"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-fg">{approvalCaption(approval)}</span>
        <span data-allow-truncate className="min-w-0 truncate font-mono text-xs text-fg-2" title={subjectLine(approval)}>
          {subjectLine(approval)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {answers.primary}
        {answers.alternatives}
        {rule && (
          <Button variant="quiet" size="sm" disabled={c.busy !== null} aria-expanded={c.alwaysOpen} onClick={() => c.setAlwaysOpen(!c.alwaysOpen)}>
            {alwaysLabel(rule)}
          </Button>
        )}
        {answers.destructive}
        <DetailsFold>
          <ApprovalSubject approval={approval} />
        </DetailsFold>
      </div>
      {c.alwaysOpen && rule && (
        <Suspense fallback={<div className="h-24" />}>
          <AlwaysPanel
            rule={rule}
            busy={c.busy === "allow_always"}
            disabled={c.busy !== null}
            onSave={() => c.act("allow_always")}
            onCancel={() => c.setAlwaysOpen(false)}
          />
        </Suspense>
      )}
      {c.error && <Notice tone="error">{c.error}</Notice>}
    </section>
  );
}

function DetailsFold({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="quiet" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide details" : "Details"}
      </Button>
      {open && <div className="mt-1 flex basis-full flex-col gap-2">{children}</div>}
    </>
  );
}

function ActionButton(props: {
  variant: "primary" | "secondary" | "quiet" | "danger";
  action: "allow" | "allow_for_turn" | "allow_always" | "deny";
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
      disabled={props.disabled}
      loading={mine}
      aria-keyshortcuts={props.shortcut}
      title={props.shortcut ? `${props.children} (${props.shortcut})` : undefined}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function OptionButton({ option, primary, busy, onClick }: { option: ApprovalOption; primary: boolean; busy: Busy; onClick(): void }) {
  const mine = busy === `option:${option.id}`;
  const allow = isAllowOption(option);
  return (
    <Button variant={primary ? "primary" : allow ? "quiet" : "danger"} size="sm" disabled={busy !== null} loading={mine} onClick={onClick}>
      {option.label}
    </Button>
  );
}

/** One line once answered: what happened, to what, by whom; the note in the tooltip. */
function ResolvedApproval({ approval, resolution }: { approval: Approval; resolution: Resolution }) {
  const allowed = resolution.decision !== "deny";
  const icon = resolution.by === "timeout" ? Clock : allowed ? Check : X;
  return (
    <div
      role="group"
      aria-label={`${resolutionLabel(resolution)}: ${approval.title}`}
      data-v7-approval={approval.id}
      data-resolved=""
      className="@container/v7 text-sm"
    >
      <Card surface="panel" padding="none">
        <div className="flex h-8 min-w-0 items-center gap-2 px-3" title={resolution.note ? `Note: ${resolution.note}` : undefined}>
          <Glyph icon={icon} size={14} className={cn("shrink-0", allowed ? "text-ok" : resolution.by === "timeout" ? "text-warn" : "text-err")} />
          <span className="shrink-0 text-fg-2">{resolutionLabel(resolution)}</span>
          <span
            className="min-w-0 truncate font-mono text-xs text-fg-3"
            title={resolution.rule ? `Rule saved: ${resolution.rule}. Remove it in the project's settings.` : undefined}
          >
            {subjectLine(approval)}
          </span>
          <span className="ml-auto shrink-0 text-xs text-fg-3 @max-[360px]/v7:hidden">{approval.agent_label}</span>
        </div>
      </Card>
    </div>
  );
}
