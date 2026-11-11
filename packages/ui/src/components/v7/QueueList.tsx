import { ChevronDown, ChevronUp, Clock, CornerDownLeft, Pause, X } from "lucide-react";
import { useState } from "react";
import type { QueuedMessage } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { queueCountLabel, queueLine, queueView } from "../../lib/v7/queue";
import { Button, IconButton } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { ErrorLine } from "./parts";

export type QueueListProps = {
  paused: boolean;
  messages: readonly QueuedMessage[];
  onRemove(id: string): Promise<void>;
  /** Stops the running turn and runs this message next. */
  onSendNow(id: string): Promise<void>;
  onResume(): Promise<void>;
  onClear(): Promise<void>;
};

type Pending = { kind: "remove" | "send"; id: string } | { kind: "resume" | "clear" } | null;

/**
 * Messages waiting for the running turn (v7 §2), as a compact stack above the composer: one 28px row each with "Send
 * now" and remove; folded past three; the paused state with Resume / Clear. Nothing when the queue is empty and running.
 */
export function QueueList(props: QueueListProps) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Removed rows disappear at once (optimistic); the next `queue.updated` confirms or, after a failure, they return.
  const messages = props.messages.filter((m) => !hidden.has(m.id));
  if (!messages.length && !props.paused) return null;
  const view = queueView(messages, expanded);

  const run = async (p: NonNullable<Pending>, work: () => Promise<void>, what: string) => {
    setPending(p);
    setError(null);
    if (p.kind === "remove") setHidden((h) => new Set(h).add(p.id));
    try {
      await work();
    } catch (e) {
      if (p.kind === "remove")
        setHidden((h) => {
          const next = new Set(h);
          next.delete(p.id);
          return next;
        });
      setError(`Could not ${what}: ${errorMessage(e)}. Try again.`);
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      aria-label={queueCountLabel(messages.length)}
      className="@container/queue flex min-w-0 flex-col rounded-md border border-line bg-panel p-1 text-sm"
    >
      {props.paused && (
        <div className="flex min-h-7 flex-wrap items-center gap-2 py-0.5 pr-0.5 pl-2">
          <Glyph icon={Pause} size={14} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-fg-2">{messages.length ? "Queue paused after a failed or stopped turn" : "Queue paused"}</span>
          <span className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2 max-md:h-10"
              disabled={pending !== null}
              onClick={() => void run({ kind: "resume" }, props.onResume, "resume the queue")}
            >
              Resume
            </Button>
            {messages.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 max-md:h-10"
                disabled={pending !== null}
                onClick={() => void run({ kind: "clear" }, props.onClear, "clear the queue")}
              >
                Clear
              </Button>
            )}
          </span>
        </div>
      )}
      {view.shown.length > 0 && (
        <ul className="flex flex-col">
          {view.shown.map((m) => {
            const busy = pending !== null && "id" in pending && pending.id === m.id;
            return (
              <li key={m.id} data-row className="group flex h-7 min-w-0 items-center gap-2 rounded-sm pr-0.5 pl-2 hover:bg-hover max-md:h-10">
                <Glyph icon={Clock} size={14} className="shrink-0 text-fg-3" />
                <span className="min-w-0 flex-1 truncate text-fg-2" title={m.text}>
                  {queueLine(m.text) || "(empty message)"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={CornerDownLeft}
                  className={cn("h-6 px-2 max-md:h-10", busy && pending.kind === "send" && "text-fg")}
                  disabled={pending !== null}
                  title="Stop the running turn and send this next"
                  onClick={() => void run({ kind: "send", id: m.id }, () => props.onSendNow(m.id), "send it now")}
                >
                  <span className="@max-[360px]/queue:sr-only">Send now</span>
                </Button>
                <IconButton
                  icon={X}
                  size="sm"
                  label="Remove from queue"
                  className="max-md:size-10"
                  disabled={pending !== null}
                  onClick={() => void run({ kind: "remove", id: m.id }, () => props.onRemove(m.id), "remove it")}
                />
              </li>
            );
          })}
        </ul>
      )}
      {(view.hidden > 0 || expanded) && messages.length > 2 && (
        <button
          type="button"
          data-row
          aria-expanded={expanded}
          className="flex h-7 items-center gap-2 rounded-sm pl-2 text-left text-fg-3 press-row focus-inset hover:bg-hover hover:text-fg max-md:h-10"
          onClick={() => setExpanded((x) => !x)}
        >
          <Glyph icon={expanded ? ChevronUp : ChevronDown} size={14} />
          {expanded ? "Show less" : `${view.hidden} more queued`}
        </button>
      )}
      {error && <ErrorLine className="px-2 py-1">{error}</ErrorLine>}
    </section>
  );
}

/** The queue count on the send button (decision 30's "queue count"): a small figure at the button's top-right. */
export function QueueBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={queueCountLabel(count)}
      className="pointer-events-none absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[11px] leading-none font-medium text-primary-fg tabular-nums"
    >
      {count}
    </span>
  );
}
