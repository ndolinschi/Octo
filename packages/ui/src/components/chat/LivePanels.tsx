import type { PlanEntry } from "@octo/agent-client";
import { Check, ChevronRight, Circle } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "../primitives/Glyph";
import { Spinner } from "../primitives/Status";

/**
 * The agent's reasoning (decision 55 c): a dim row, collapsed, whose last line streams; expanding shows the stream.
 * It is never stored: when the turn ends it goes, unless it was open (then the text read so far stays until closed).
 */
export function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState("");
  const id = useId();
  if (open && text && kept !== text) setKept(text);
  const shown = text || (open ? kept : "");
  if (!shown) return null;
  const tail = shown.trimEnd().split("\n").pop() ?? "";
  return (
    <div data-thinking>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="group -mx-2 flex h-row max-w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-sm px-2 text-sm text-fg-3 press-row hover:bg-hover hover:text-fg-2"
      >
        <span className="shrink-0">{text ? "Thinking" : "Thought"}</span>
        {!open && <span className="octo-thinking-tail min-w-0 truncate opacity-80">{tail}</span>}
        <Glyph icon={ChevronRight} size={14} className={cn("shrink-0 transition-[rotate] duration-150", open && "rotate-90")} />
      </button>
      {open && (
        <div id={id} className="mt-1 max-h-60 overflow-y-auto overscroll-contain border-l border-line pl-3 text-sm leading-5 whitespace-pre-wrap text-fg-3">
          {shown}
        </div>
      )}
    </div>
  );
}

const DONE = (e: PlanEntry) => e.status === "completed";

/** The agent's plan (decision 55 d): a compact checklist that ticks off as the agent works. */
export function PlanList({ entries }: { entries: PlanEntry[] }) {
  if (!entries.length) return null;
  const done = entries.filter(DONE).length;
  return (
    <section data-plan aria-label={`Plan, ${done} of ${entries.length} done`} className="rounded-md border border-line px-3 py-2">
      <p className="flex h-6 items-center justify-between text-xs text-fg-3">
        <span>Plan</span>
        <span className="tabular-nums">
          {done}/{entries.length}
        </span>
      </p>
      <ul className="flex flex-col">
        {entries.map((e, i) => (
          <li key={i} className="flex min-h-6 items-start gap-2 text-sm">
            <span className="grid h-5 w-4 shrink-0 place-items-center">
              {e.status === "completed" ? (
                <Glyph icon={Check} size={14} className="text-ok" />
              ) : e.status === "in_progress" ? (
                <Spinner className="text-accent" />
              ) : (
                <Glyph icon={Circle} size={14} className="text-fg-3" />
              )}
            </span>
            <span
              className={cn(
                "min-w-0 py-0.5 leading-5 wrap-anywhere",
                e.status === "completed" ? "text-fg-3 line-through decoration-line-strong" : e.status === "in_progress" ? "text-fg" : "text-fg-2",
              )}
            >
              {e.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
