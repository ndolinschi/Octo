import { memo, useState } from "react";
import { cn } from "../../lib/cn";
import { formatStepDuration } from "../../lib/duration";
import { useNow } from "../../lib/hooks";
import { Button } from "../primitives/Button";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { InlineButton } from "../primitives/InlineButton";
import { MiddleText } from "../primitives/MiddleText";
import { useFileRef } from "../shared/FileLink";
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

const CODE_CHIP = "inline-flex min-w-0 items-baseline rounded-xs bg-active px-1 py-0.5 font-mono text-xs text-fg-2";
const FILE_CHIP = "relative inline-flex max-w-full min-w-0 items-baseline rounded-xs bg-active py-0.5 pr-1 pl-6 font-mono text-xs text-fg-2";
// A middle-cut path keeps its first letter and the ellipsis ("s…eue.ts") instead of collapsing the head to nothing.
const KEEP_HEAD = "[&_.octo-mid>:first-child]:min-w-[2ch]!";
const FILE_ICON = "pointer-events-none absolute top-1/2 left-1 -translate-y-1/2 text-fg-3";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/** A file path chip: always shows its file glyph (resolved or not) and opens the file when it belongs to the project. */
function FileChip({ path }: { path: string }) {
  const hit = useFileRef(path);
  const icon = fileIcon(basename(hit ? hit.ref.path : path));
  const label = <MiddleText text={path} />;
  if (!hit) {
    return (
      <span data-allow-truncate="" className={cn(FILE_CHIP, KEEP_HEAD)}>
        <Glyph icon={icon} size={14} className={FILE_ICON} />
        {label}
      </span>
    );
  }
  return (
    <InlineButton
      data-file-link=""
      data-warm="tool:files"
      data-allow-truncate=""
      title={hit.title}
      onPress={hit.open}
      className={cn(FILE_CHIP, KEEP_HEAD, "group/chip cursor-pointer transition-colors duration-fast hover:text-link focus-visible:text-link")}
    >
      <Glyph icon={icon} size={14} className={cn(FILE_ICON, "transition-colors duration-fast group-hover/chip:text-link group-focus-visible/chip:text-link")} />
      {label}
    </InlineButton>
  );
}

/** The step's object: file paths get a file chip with glyph, search query and scope path get inline-code chips (query keeps priority). */
function Detail({ verb, object, path, mono, qualifier }: StepText) {
  if (!object && !qualifier) return null;
  const isSearch = verb === "Searched for";
  const inPath = qualifier.startsWith("in ") ? qualifier.slice(3) : "";
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {object &&
        (path ? (
          <FileChip path={object} />
        ) : isSearch && mono ? (
          <span className={cn(CODE_CHIP, inPath ? "max-w-[calc(100%-6.5rem)]" : "max-w-full")}>
            <span data-allow-truncate="" className="min-w-0 truncate">
              {object}
            </span>
          </span>
        ) : (
          <span
            data-allow-truncate=""
            className={cn("min-w-0 truncate", inPath && "max-w-[calc(100%-6.5rem)]", mono ? "font-mono text-xs" : "font-sans text-sm")}
          >
            {object}
          </span>
        ))}
      {inPath ? (
        <>
          <span className="shrink-0">in</span>
          <span data-allow-truncate="" className={cn(CODE_CHIP, KEEP_HEAD, "min-w-auto shrink-8")}>
            <MiddleText text={inPath} />
          </span>
        </>
      ) : (
        qualifier && <span className="shrink-0">{qualifier}</span>
      )}
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
      detail={<Detail verb={p.verb} object={p.object} path={p.path} mono={p.mono} qualifier={p.qualifier} />}
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
