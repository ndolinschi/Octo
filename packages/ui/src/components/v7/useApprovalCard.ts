import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Approval, ApprovalAnswer, ApprovalOption } from "@octo/agent-client";
import { answerFor, keyAction, optionAnswer, type ApprovalAction, type Resolution } from "../../lib/v7/approval";
import { errorMessage } from "../../lib/format";

/** Which control is waiting for the bridge (its button shows the pressed state; the others are disabled). */
export type Busy = ApprovalAction | `option:${string}` | null;

function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

function codeOf(e: unknown): string | null {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : null;
}

/**
 * Behaviour of one pending approval card: answering (one request in flight, a visible error with a retry), the note,
 * the `A` / `D` / `Enter` keys, and focus on arrival unless the user is typing (v7 §3).
 */
export function useApprovalCard(props: {
  approval: Approval;
  card: RefObject<HTMLElement | null>;
  focusOnArrival: boolean;
  onResolve(id: string, answer: ApprovalAnswer): Promise<void>;
  onResolved(resolution: Resolution): void;
}) {
  const { approval, card, onResolve, onResolved } = props;
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const inFlight = useRef(false);

  const send = useCallback(
    async (which: Busy, answer: ApprovalAnswer, resolution: Resolution) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(which);
      setError(null);
      try {
        await onResolve(approval.id, answer);
        onResolved(resolution);
      } catch (e) {
        // 404: someone else (another window, the timer, a cancel) answered first; the card closes as resolved elsewhere.
        if (codeOf(e) === "not_found") onResolved({ decision: "deny", by: "elsewhere" });
        else setError(`Your answer did not reach the harness: ${errorMessage(e)}. Try again.`);
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [approval.id, onResolve, onResolved],
  );

  const act = useCallback(
    (action: ApprovalAction) => {
      const answer = answerFor(action, note);
      const resolution: Resolution = answer.note ? { decision: action, by: "you", note: answer.note } : { decision: action, by: "you" };
      void send(action, answer, resolution);
    },
    [note, send],
  );

  const choose = useCallback(
    (option: ApprovalOption) => {
      const answer = optionAnswer(option, note);
      const resolution: Resolution = { decision: answer.decision, by: "you", option: option.label };
      void send(`option:${option.id}`, answer, answer.note ? { ...resolution, note: answer.note } : resolution);
    },
    [note, send],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Enter on a button inside the card presses that button; on the card itself it allows.
      if (e.key === "Enter" && e.target !== card.current) return;
      const action = keyAction(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey }, isField(e.target));
      if (!action) return;
      e.preventDefault();
      // With ACP options, A / Enter take the agent's first allow option (the harness would pick the same one).
      const first = approval.detail.options?.find((o) => (action === "deny" ? o.kind.startsWith("reject") : o.kind.startsWith("allow")));
      if (first) choose(first);
      else act(action);
    },
    [act, approval.detail.options, card, choose],
  );

  // Focus on arrival only (the first render's choice), and never out of a field the user is typing in.
  const autoFocus = useRef(props.focusOnArrival);
  useEffect(() => {
    if (!autoFocus.current || isField(document.activeElement)) return;
    card.current?.focus({ preventScroll: true });
  }, [card]);

  return { busy, error, noteOpen, setNoteOpen, note, setNote, act, choose, onKeyDown };
}
