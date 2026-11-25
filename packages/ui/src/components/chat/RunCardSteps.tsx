import { memo, useState } from "react";
import { cn } from "../../lib/cn";
import { formatStepDuration } from "../../lib/duration";
import { useNow } from "../../lib/hooks";
import { Button } from "../primitives/Button";
import { InlineCode } from "../shared/FileLink";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { labelParts } from "./activity";
import { visibleSteps, type RunStep } from "./runCard";

const STATE: Record<RunStep["state"], ActivityState> = { running: "running", done: "done", error: "failed", stopped: "stopped" };

/**
 * Decision 101 c: the run's last steps, oldest first — each one the transcript's own row (`ActivityRow`, phrased by `callRow`)
 * with its time right-aligned; the step running now is dim with a live timer; older steps fold behind a quiet "Show N earlier".
 * `current`: what the agent does between calls (thinking, writing), as the last row.
 */
export function RunSteps(props: { steps: readonly RunStep[]; current: { label: string; since: number | null } | null }) {
  const [all, setAll] = useState(false);
  const { earlier, steps } = visibleSteps(props.steps, all);
  if (steps.length === 0 && !props.current) return null;
  return (
    <div data-run-steps className="-ml-6 flex min-w-0 flex-col">
      {earlier > 0 && (
        <Button variant="quiet" size="xs" onClick={() => setAll(true)} className="ml-4 self-start">
          Show {earlier} earlier
        </Button>
      )}
      <ul className="flex min-w-0 flex-col">
        {steps.map((s) => (
          <li key={s.id} className="min-w-0">
            {s.state === "running" ? (
              <CurrentStep label={s.live ?? s.row.verb} since={s.startedAt} />
            ) : (
              <SettledStep
                state={s.state}
                verb={s.row.verb}
                object={s.row.object}
                path={s.row.path}
                mono={s.row.mono}
                qualifier={s.row.qualifier}
                durationMs={s.durationMs}
                reason={s.reason}
              />
            )}
          </li>
        ))}
        {props.current && (
          <li className="min-w-0">
            <CurrentStep label={props.current.label} since={props.current.since} />
          </li>
        )}
      </ul>
    </div>
  );
}

type StepText = { verb: string; object: string; path: string; mono: boolean; qualifier: string };

/** The step's object: a file is the FileLink chip (decision 19), a command or pattern mono, a phrase in the UI face. */
function Detail({ object, path, mono, qualifier }: Omit<StepText, "verb">) {
  if (!object && !qualifier) return null;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {object &&
        (path ? (
          // The chip's look comes from the prose rules; its line is cut on an element of its own, because `.octo-prose`'s
          // `text-wrap: pretty` (unlayered) would beat `truncate` on the same element and break a long path mid-name.
          <span className="octo-prose octo-prose-sm flex min-w-0 text-fg-2">
            <span data-allow-truncate className="min-w-0 truncate">
              <InlineCode>{object}</InlineCode>
            </span>
          </span>
        ) : (
          <span data-allow-truncate className={cn("min-w-0 truncate", mono ? "font-mono text-xs" : "font-sans text-sm")}>
            {object}
          </span>
        ))}
      {qualifier && <span className="shrink-0">{qualifier}</span>}
    </span>
  );
}

const tipOf = (t: StepText) => [t.verb, t.object, t.qualifier].filter(Boolean).join(" ");

/** A finished step: memoised on its own fields, so a streaming agent re-renders only the row that runs. */
const SettledStep = memo(function SettledStep(p: StepText & { state: Exclude<RunStep["state"], "running">; durationMs: number | null; reason: string | null }) {
  return (
    <ActivityRow
      state={STATE[p.state]}
      verb={p.verb}
      detail={<Detail object={p.object} path={p.path} mono={p.mono} qualifier={p.qualifier} />}
      duration={p.durationMs}
      formatDuration={formatStepDuration}
      tip={p.reason ? `${tipOf(p)}\n\n${p.reason}` : tipOf(p)}
      {...(p.state === "stopped" ? { aside: "stopped" } : {})}
      note={p.reason}
    />
  );
});

/**
 * The step running now, dim, with its own one-second timer (only this row ticks): a call in the present tense as the activity
 * line says it ("Reading src/x.ts"), or what the agent does between calls ("Thinking…"), timed from its last message.
 */
function CurrentStep({ label, since }: { label: string; since: number | null }) {
  const now = useNow(true);
  const parts = labelParts(label);
  return (
    <ActivityRow
      state="running"
      verb={
        <span className="text-fg-3">
          {parts.map((part, i) =>
            part.code ? (
              <code key={i} className="font-mono text-xs">
                {part.text}
              </code>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </span>
      }
      duration={since !== null ? Math.max(0, now - since) : null}
      tip={label}
    />
  );
}
