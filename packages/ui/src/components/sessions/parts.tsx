import type { Agent, Message, ProjectSession } from "@octo/agent-client";
import type { ReactNode } from "react";
import { stateWord } from "../../lib/sessions/model";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Notice } from "../primitives/Notice";

/**
 * What the Sessions tab does not render itself: the conversation. The dock hands in the project chat's own transcript
 * component, so a session reads exactly like the conversation (features do not import each other).
 */
export type TranscriptSlot = (props: {
  agent: Agent;
  messages: Message[];
  speaker: string;
  promptAuthor: string;
  hideFirstPrompt: boolean;
  /** A pane narrower than the conversation's own floor: smaller type, tighter bubbles, time-only reply meta. */
  density?: "compact" | undefined;
  /** A delegation row's "Open session" (selects that agent's session in the tab). */
  onOpenSession?: ((agentId: string) => void) | undefined;
}) => ReactNode;

/** The conversation boundary at the top of a session that followed another one (`/clear` or "New session"): never an exchange. */
export function BoundaryMarker(props: { earlier: string; onOpenEarlier?: (() => void) | undefined }) {
  return (
    // One line that truncates from the right (the title gives way, "New session · earlier:" never wraps).
    <div data-boundary className="flex min-w-0 items-center gap-1 pb-3 text-xs whitespace-nowrap text-fg-3">
      <span className="shrink-0">New session · earlier:</span>
      {props.onOpenEarlier ? (
        <Button variant="link" size="xs" tone="quiet" className="min-w-0 shrink overflow-hidden px-0" title={props.earlier} onClick={props.onOpenEarlier}>
          <span className="min-w-0 truncate">{props.earlier}</span>
        </Button>
      ) : (
        <span className="min-w-0 truncate">{props.earlier}</span>
      )}
    </div>
  );
}

/** Rows reserve the width of a "⋯" so their times end on one edge, as in Memory's lists. */
export const ROW_TAIL = <span aria-hidden className="size-6" />;

/** The dim second line of a two-line row: text that gives way, and at the right a short tail that never does. */
export function RowLine({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end !== undefined && <span className="shrink-0 tabular-nums">{end}</span>}
    </span>
  );
}

/** The state in words for screen readers; the glyph in the row is decorative. */
export function StateWord({ session }: { session: ProjectSession }) {
  return <span className="sr-only">{stateWord(session.state)}: </span>;
}

/** The quiet line under a disabled control: why it is disabled (rule 20: the next step is in the sentence). */
export function QuietLine({ children }: { children: ReactNode }) {
  return <p className="min-w-0 px-1 text-xs break-words text-fg-3">{children}</p>;
}

/** Confirms a destructive action; a refusal (running, current) shows in the dialog and keeps it open. */
export function ConfirmDelete(props: { title: string; description: string; busy: boolean; error: string | null; onClose(): void; onConfirm(): void }) {
  return (
    <Dialog
      title={props.title}
      description={props.description}
      onClose={props.onClose}
      width="sm"
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={props.busy} onClick={props.onConfirm}>
            {props.busy ? "Deleting" : "Delete"}
          </Button>
        </>
      }
    >
      {props.error && <Notice tone="error">{props.error}</Notice>}
    </Dialog>
  );
}
