import { ChevronDown, ChevronUp, Clock, CircleStop, CornerDownLeft, Info, MoreHorizontal, Pause, X } from "lucide-react";
import { useRef, useState } from "react";
import type { QueuedMessage } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorCode, errorMessage } from "../../lib/format";
import { queueCountLabel, queueLine, queueSummary, queueView } from "../../lib/v7/queue";
import { queuedModeTag, STEER_REASON, steerOutcome } from "../../lib/v7/steerQueue";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Notice } from "../primitives/Notice";
import { Presence } from "../primitives/Presence";
import { SectionHeader } from "../primitives/SectionHeader";
import { Sheet } from "../primitives/Sheet";
import { usePhone } from "../../lib/phone";

export type QueueListProps = {
  paused: boolean;
  messages: readonly QueuedMessage[];
  onRemove(id: string): Promise<void>;
  /** Parity B6: hands the message to the running turn at its next step, without stopping it. Rejects with `steer_unsupported` for an ACP agent. */
  onSendNow(id: string): Promise<void>;
  /** Stops the running turn and runs this message next. */
  onStopAndSend(id: string): Promise<void>;
  /** The orchestrator is an ACP agent: it cannot take a message mid-turn, so only "Stop and send" is offered. */
  steerUnsupported?: boolean;
  onResume(): Promise<void>;
  onClear(): Promise<void>;
  /** Decision 96: the messages wait for a free slot under the running caps ("Waiting for a free slot (3 sessions running)"). */
  waiting?: string | null | undefined;
};

type Pending = { kind: "remove" | "send" | "stop"; id: string } | { kind: "resume" | "clear" } | null;

/**
 * Messages waiting for the running turn (v7 §2), as a compact stack above the composer: one 28px row each with "Send
 * now" and remove; folded past three; the paused state with Resume / Clear. Nothing when the queue is empty, paused or not (P2-8).
 */
export function QueueList(props: QueueListProps) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone) return <QueueBody {...props} />;
  // Direction 7: on the phone the queue is one chip above the field ("2 queued") that opens the list in a bottom sheet.
  const count = props.messages.length;
  if (!count) return null;
  return (
    <div data-phone-queue className="flex px-1 pt-1">
      <Button variant="quiet" size="sm" icon={props.paused ? Pause : Clock} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {props.paused ? `${count} queued · paused` : `${count} queued`}
      </Button>
      <Presence show={open}>
        <Sheet label="Waiting to send" onClose={() => setOpen(false)}>
          <div className="px-2 pb-2">
            <QueueBody {...props} />
          </div>
        </Sheet>
      </Presence>
    </div>
  );
}

function QueueBody(props: QueueListProps) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Parity B6: rows handed to the running turn (still listed until it takes them), and an ACP answer learned from a 409.
  const [steering, setSteering] = useState<ReadonlySet<string>>(new Set());
  const [learned, setLearned] = useState(false);
  const unsupported = props.steerUnsupported === true || learned;
  // The queue is one summary row at every width until it is unfolded; a pause or an error unfolds it by itself.
  const [unfolded, setUnfolded] = useState(false);

  // Removed rows disappear at once (optimistic); the next `queue.updated` confirms or, after a failure, they return.
  const messages = props.messages.filter((m) => !hidden.has(m.id));
  // P2-8: paused with nothing queued is not shown (a cleared queue left an empty "Queue paused" strip); a message queued
  // later brings the strip back with its count and Resume.
  if (!messages.length) return null;
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

  const steer = async (id: string) => {
    setPending({ kind: "send", id });
    setError(null);
    try {
      await props.onSendNow(id);
      setSteering((s) => new Set(s).add(id));
    } catch (e) {
      const outcome = steerOutcome(errorCode(e));
      if (outcome === "unsupported") setLearned(true);
      else if (outcome !== "gone") setError(`Could not send it now: ${errorMessage(e)}. Try again.`);
    } finally {
      setPending(null);
    }
  };

  const count = messages.length;
  const sectionClass = "@container/queue flex min-w-0 flex-col border-b border-line px-1 py-0.5 text-sm";
  if (!unfolded && !props.paused && error === null)
    return (
      <section aria-label={queueCountLabel(count)} data-queue-summary className={sectionClass}>
        <ListRow
          tone="quiet"
          leading={<Clock size={14} />}
          title={queueSummary(messages, props.waiting)}
          tip={messages.map((m) => queueLine(m.text)).join("\n")}
          expanded={false}
          className="rounded-md"
          onClick={() => setUnfolded(true)}
          trailing={<Glyph icon={ChevronDown} size={14} className="mx-1.5 text-fg-3" />}
          trailingShown
        />
      </section>
    );
  return (
    <section aria-label={queueCountLabel(count)} className={sectionClass}>
      {/* Round 3: narrow — the sentence is one info glyph's tooltip in the header (it took three lines of the card at 390). */}
      <SectionHeader
        inset
        level="caption"
        as="h3"
        aside={
          view.shown.length > 0 ? (
            <span className="inline-flex">
              <span data-steer-reason={unsupported ? "" : undefined} className="inline-flex">
                <IconButton icon={Info} size="xs" label={unsupported ? STEER_REASON : "Sent one by one when the current reply ends."} />
              </span>
              <IconButton icon={ChevronUp} size="xs" label="Fold the queue" aria-expanded onClick={() => setUnfolded(false)} />
            </span>
          ) : undefined
        }
      >
        {props.paused
          ? `${queueCountLabel(count)} · paused after a failed or stopped reply`
          : props.waiting
            ? `${queueCountLabel(count)} · ${props.waiting}`
            : queueCountLabel(count)}
      </SectionHeader>
      {props.paused && (
        <div className="flex min-h-ctl-sm flex-wrap items-center gap-2 pr-0.5 pl-2">
          <Glyph icon={Pause} size={14} className="shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 text-fg-2">Nothing is sent until you resume.</span>
          <Button size="xs" variant="secondary" disabled={pending !== null} onClick={() => void run({ kind: "resume" }, props.onResume, "resume the queue")}>
            Resume
          </Button>
          <Button size="xs" variant="quiet" disabled={pending !== null} onClick={() => void run({ kind: "clear" }, props.onClear, "clear the queue")}>
            Clear
          </Button>
        </div>
      )}
      {view.shown.length > 0 && (
        <ul className="flex flex-col">
          {view.shown.map((m) => {
            const busy = pending !== null && "id" in pending && pending.id === m.id;
            const text = `${queuedModeTag(m.mode) ? `${queuedModeTag(m.mode)} ` : ""}${queueLine(m.text) || "(empty message)"}`;
            const sendNow = () => void steer(m.id);
            const stopSend = () => void run({ kind: "stop", id: m.id }, () => props.onStopAndSend(m.id), "stop and send it");
            const remove = () => void run({ kind: "remove", id: m.id }, () => props.onRemove(m.id), "remove it");
            return (
              <li key={m.id} data-row>
                <ListRow
                  tone="quiet"
                  leading={<Clock size={14} />}
                  title={text}
                  tip={m.text}
                  className={cn(busy && "opacity-70")}
                  meta={steering.has(m.id) ? <span data-steering>Sends at the next step</span> : undefined}
                  trailing={
                    steering.has(m.id) ? undefined : (
                      <>
                        <span className="flex gap-0.5 @max-[480px]/queue:hidden">
                          {!unsupported && <IconButton icon={CornerDownLeft} size="xs" label="Send now" disabled={pending !== null} onClick={sendNow} />}
                          <IconButton icon={CircleStop} size="xs" label="Stop and send it now" disabled={pending !== null} onClick={stopSend} />
                          <IconButton icon={X} size="xs" label="Remove from queue" disabled={pending !== null} onClick={remove} />
                        </span>
                        <span className="hidden @max-[480px]/queue:inline-flex">
                          <RowMenu
                            label={`Actions for ${queueLine(m.text) || "this message"}`}
                            disabled={pending !== null}
                            items={[
                              ...(unsupported ? [] : [{ id: "now", label: "Send now", run: sendNow }]),
                              { id: "stop", label: "Stop and send it now", run: stopSend },
                              { id: "remove", label: "Remove from queue", run: remove },
                            ]}
                          />
                        </span>
                      </>
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      {(view.hidden > 0 || expanded) && messages.length > 2 && (
        <ListRow
          tone="quiet"
          leading={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          title={expanded ? "Show less" : `${view.hidden} more queued`}
          onClick={() => setExpanded((x) => !x)}
        />
      )}
      {error && (
        <Notice tone="error" className="px-2 py-1">
          {error}
        </Notice>
      )}
    </section>
  );
}

/** "⋯" with a menu: the row's actions below 480 px, where the icons would take the text's room. */
function RowMenu(props: { label: string; disabled: boolean; items: MenuItem[] }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={button}
        icon={MoreHorizontal}
        size="xs"
        label={props.label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={props.disabled}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setAt(at ? null : { x: r.right, y: r.bottom + 4 });
        }}
      />
      <Presence show={at !== null} exitMs={0}>
        {at && <Menu label={props.label} x={at.x} y={at.y} alignEnd items={props.items} onClose={() => setAt(null)} />}
      </Presence>
    </>
  );
}

/** The old count on the send button; the queue now says "N queued" in its own header (decision 91h), the composer no longer mounts this. */
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
