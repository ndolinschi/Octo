import type { PlanEntry } from "@octo/agent-client";
import { useState } from "react";
import { useTranscriptView } from "../../lib/transcriptView";
import { ActivityRow } from "./ActivityRow";

/**
 * The agent's reasoning (decision 55 c): a dim row, collapsed in Normal view and expanded in Thinking / Verbose views,
 * whose last line streams; expanding shows the stream.
 * `after`: a tool call or text already follows it, so it is done (no spinner) even while reasoning keeps streaming.
 * It is never stored: when the turn ends it goes, unless it was open (then the text read so far stays until closed).
 */
export function ThinkingRow({ text, after = false }: { text: string; after?: boolean }) {
  const viewMode = useTranscriptView();
  const autoOpen = viewMode === "thinking" || viewMode === "verbose";
  const [override, setOverride] = useState<boolean | null>(null);
  const [prevAuto, setPrevAuto] = useState(autoOpen);
  if (autoOpen !== prevAuto) {
    setPrevAuto(autoOpen);
    setOverride(null);
  }
  const open = override ?? autoOpen;
  const [kept, setKept] = useState("");
  if (open && text && kept !== text) setKept(text);
  const shown = text || (open ? kept : "");
  if (!shown) return null;
  const running = Boolean(text) && !after;
  const tail = shown.trimEnd().split("\n").pop() ?? "";
  return (
    <div data-thinking>
      <ActivityRow
        state={running ? "running" : "done"}
        verb={running ? "Thinking" : "Thought"}
        detail={open ? undefined : <span className="octo-thinking-tail">{tail}</span>}
        open={open}
        onOpenChange={setOverride}
      >
        <div className="max-h-60 overflow-y-auto overscroll-contain text-sm leading-5 whitespace-pre-wrap text-fg-3">{shown}</div>
      </ActivityRow>
    </div>
  );
}

const DONE = (e: PlanEntry) => e.status === "completed";

/** The agent's plan (decision 55 d): a compact checklist that ticks off as the agent works. */
export function PlanList({ entries }: { entries: PlanEntry[] }) {
  if (!entries.length) return null;
  const done = entries.filter(DONE).length;
  return (
    // Polish step 3, C3: no frame; a meta caption over the steps' rows, like a delegation round.
    <section data-plan data-activity="" aria-label={`Plan, ${done} of ${entries.length} done`}>
      <p className="flex h-6 items-center gap-1.5 pl-6 text-xs text-fg-3">
        <span>Plan</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          {done}/{entries.length} done
        </span>
      </p>
      <ul className="flex flex-col">
        {entries.map((e, i) => (
          <li key={i}>
            <ActivityRow
              state={e.status === "completed" ? "done" : e.status === "in_progress" ? "running" : "pending"}
              verb={<span className={e.status === "completed" ? "text-fg-3 line-through decoration-line-strong" : undefined}>{e.content}</span>}
              tip={e.content}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
