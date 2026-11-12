import type { MemoryExchange } from "@octo/agent-client";
import { Ellipsis, MessageSquareShare } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { foldText, metaParts, STATUS_NOTE } from "../../lib/memory/sessions";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";

const Markdown = lazy(() => import("../shared/Markdown").then((m) => ({ default: m.Markdown })));

/** The Markdown arrives in its own chunk; until then the answer shows as plain text, so the page never waits for it. */
function Answer({ text }: { text: string }) {
  return (
    <Suspense fallback={<p className="text-sm whitespace-pre-wrap text-fg">{text}</p>}>
      <Markdown text={text} />
    </Suspense>
  );
}

/**
 * One exchange: the request as typed, the answer as Markdown folded after 12 lines ("Show all"), a quiet meta line,
 * "Open in conversation" and a "⋯" menu with "Forget this exchange" (behind a confirm). A forgotten exchange is a
 * one-line marker. No coloured frames (decision 81): the request is set apart by weight and a hairline, not a box.
 */
export function ExchangeCard(props: {
  exchange: MemoryExchange;
  now: number;
  highlighted: boolean;
  onOpenMessage?: ((turnId: number) => void) | undefined;
  onForget(id: string): Promise<void>;
}) {
  const e = props.exchange;
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (e.removed) {
    return (
      <li className="border-t border-line py-3 text-sm text-fg-3 first:border-t-0" data-exchange={e.id}>
        This exchange was removed.
      </li>
    );
  }
  const folded = foldText(e.answer);
  const note = STATUS_NOTE[e.status];
  return (
    <li
      data-exchange={e.id}
      data-highlighted={props.highlighted ? "" : undefined}
      className={cn("flex flex-col gap-2 border-t border-line py-3 first:border-t-0", props.highlighted && "bg-hover/50")}
    >
      <article aria-label={`Exchange from ${e.started_at}`} className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium break-words whitespace-pre-wrap text-fg">{e.request}</p>
          <IconButton
            ref={button}
            icon={Ellipsis}
            label="Exchange actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            className={cn("-mr-1 shrink-0", menu && "bg-active text-fg")}
            onClick={() => {
              const r = button.current?.getBoundingClientRect();
              if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
            }}
          />
        </div>
        {e.answer.trim() !== "" && (
          <div className="min-w-0 text-sm text-fg-2">
            <Answer text={open ? e.answer : folded.text} />
            {folded.hidden > 0 && (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="mt-1 rounded-sm text-xs text-fg-3 press-row focus-inset hover:text-fg"
              >
                {open ? "Show less" : `Show all (${folded.hidden} more ${folded.hidden === 1 ? "line" : "lines"})`}
              </button>
            )}
          </div>
        )}
        {note && <p className={cn("text-sm", e.status === "failed" ? "text-err" : "text-fg-3")}>{note}</p>}
        {e.answer_truncated && <p className="text-xs text-fg-3">The answer was longer than 64 KiB; the end is cut.</p>}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3">
          {metaParts(e, props.now).map((p, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>·</span>}
              {p}
            </span>
          ))}
          {props.onOpenMessage && (
            <Button variant="ghost" size="sm" icon={MessageSquareShare} className="ml-auto" onClick={() => props.onOpenMessage?.(e.turn_id)}>
              Open in conversation
            </Button>
          )}
        </div>
      </article>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Exchange actions"
            x={menu.x}
            y={menu.y}
            alignEnd
            items={[{ id: "forget", label: "Forget this exchange", run: () => setConfirm(true) }]}
            onClose={() => setMenu(null)}
          />
        )}
      </Presence>
      {confirm && <ForgetDialog onClose={() => setConfirm(false)} onForget={() => props.onForget(e.id)} />}
    </li>
  );
}

function ForgetDialog(props: { onClose(): void; onForget(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="Forget this exchange?"
      description="The request and its answer are deleted from memory and from search. A marker stays in the session. The conversation itself is not changed. This cannot be undone."
      onClose={props.onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              props.onForget().then(props.onClose, (err: unknown) => {
                setError(`${errorMessage(err)} Try again.`);
                setBusy(false);
              });
            }}
          >
            {busy ? "Forgetting" : "Forget"}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
    </Dialog>
  );
}
