import type { ProjectSession } from "@octo/agent-client";
import { ArrowUp } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { blockedText, outcomeText } from "../../lib/sessions/model";
import { Checkbox } from "../primitives/Checkbox";
import { IconButton } from "../primitives/IconButton";
import { Notice } from "../primitives/Notice";
import { TextArea } from "../primitives/TextField";
import { QuietLine } from "./parts";
import type { SessionActions } from "./useSessionActions";

/** The composer's line height and the most lines it grows to (decision 62: 1 to 10, then it scrolls). */
const LINE = 22;
const MAX_LINES = 10;

/**
 * A message to an agent session (decision 3), in the same frame as the side question and the conversation's composer
 * (`octo-composer`, the send button inside, autosizing, Enter sends, Shift+Enter breaks the line, no resize handle).
 * Enabled while the harness says `can_message`: steered while the agent works, continued after it finished. Disabled, the
 * frame dims and its placeholder line is the harness's reason. "Send result to the orchestrator" is `report_to_parent`.
 */
export function SessionComposer({ session, actions }: { session: ProjectSession; actions: SessionActions }) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [report, setReport] = useState(false);
  const [outcome, setOutcome] = useState<"steered" | "continued" | null>(null);
  const reason = blockedText(session);
  const disabled = reason !== null;
  const empty = text.trim() === "";

  // The area grows with its text (and re-fits when the pane's width re-wraps it).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${Math.max(disabled ? LINE * 2 : LINE, Math.min(el.scrollHeight, LINE * MAX_LINES))}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, disabled]);

  const send = async () => {
    if (disabled || empty || actions.busy) return;
    const sent = await actions.message(session.id, text.trim(), report);
    if (!sent) return;
    setText("");
    setOutcome(sent.outcome);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };
  return (
    <div className="flex flex-col gap-2">
      {actions.error && <Notice tone="error">{actions.error}</Notice>}
      <form
        className={cn("octo-composer flex flex-col gap-1 bg-raised p-2", disabled && "opacity-80")}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor={id} className="sr-only">
          Message to this agent
        </label>
        <TextArea
          ref={area}
          id={id}
          variant="bare"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={reason ?? "Message this agent"}
          title={reason ?? undefined}
          onChange={(e) => {
            setText(e.target.value);
            setOutcome(null);
          }}
          onKeyDown={onKeyDown}
          className="octo-composer-input px-1"
        />
        <div className="flex items-center gap-1">
          <span className="ml-auto" />
          <IconButton icon={ArrowUp} label="Send" shortcut="↵" variant="primary" round type="submit" disabled={disabled || empty || actions.busy !== null} />
        </div>
      </form>
      {!disabled && (
        <div className="flex min-w-0 flex-col gap-1 px-1">
          <Checkbox
            checked={report}
            onChange={setReport}
            label="Send result to the orchestrator"
            description="Its answer is added to the main conversation before the next request."
          />
          {outcome && <QuietLine>{outcomeText(outcome)}</QuietLine>}
        </div>
      )}
    </div>
  );
}
