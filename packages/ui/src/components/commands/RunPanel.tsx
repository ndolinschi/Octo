import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { durationText, runStatusText, runTone, stripAnsi, type RunTone } from "../../lib/commands/format";
import { isRunning, type RunView } from "../../lib/commands/runs";
import { useNow } from "../../lib/hooks";
import { Button, IconButton } from "../primitives/Button";
import { Spinner } from "../primitives/Status";
import { useRuns } from "./RunsContext";

const TONE: Record<RunTone, string> = { run: "text-fg-2", ok: "text-ok", err: "text-err", muted: "text-fg-3" };
/** How far from the end still counts as following the output. */
const FOLLOW_SLACK_PX = 24;

/**
 * The runs of this review and the output of the selected one, under the diff (decision 68): status, exit code and time on one
 * line, Stop while it runs, Re-run after it. Output streams in as `command.output` events and follows the end until the
 * reader scrolls up. Nothing here animates except the spinner of a run that is running.
 */
export function RunPanel({ tab }: { /** The "Run: name" tab (decision 68): fills its tab, names the command, has no close button. */ tab?: string } = {}) {
  const r = useRuns();
  if (!r.panelOpen && tab === undefined) return null;
  const cur = r.current;
  return (
    <section
      aria-label={tab === undefined ? "Command runs" : `Runs of ${tab}`}
      className={cn("flex min-h-0 flex-col bg-panel", tab === undefined ? "h-1/3 min-h-48 shrink-0 border-t border-line" : "flex-1")}
    >
      <header className="flex min-h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <div
          role="tablist"
          aria-label={tab === undefined ? "Runs of this review" : `Runs of ${tab}`}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {r.runs.map((v) => (
            <RunTab key={v.run.id} v={v} selected={cur?.run.id === v.run.id} onSelect={() => r.select(v.run.id)} />
          ))}
          {r.runs.length === 0 && <span className="px-2 text-xs text-fg-3">No runs yet</span>}
        </div>
        {cur && isRunning(cur.run) && (
          <Button size="sm" variant="secondary" onClick={() => void r.stop(cur.run.id)} className="max-md:h-10">
            Stop
          </Button>
        )}
        {cur && !isRunning(cur.run) && (
          <Button size="sm" variant="secondary" disabled={!r.worktreePresent} onClick={() => void r.start(cur.run.name)} className="max-md:h-10">
            Re-run
          </Button>
        )}
        {tab === undefined && <IconButton icon={X} label="Close the run panel" onClick={r.closePanel} className="max-md:size-10" />}
      </header>
      {r.error && (
        <p role="alert" className="shrink-0 border-b border-line px-3 py-1.5 text-xs text-err">
          {r.error}
        </p>
      )}
      {cur ? (
        <RunBody v={cur} />
      ) : tab === undefined ? (
        <p className="px-3 py-3 text-sm text-fg-3">Use Run in the header to start a command in this review's worktree.</p>
      ) : (
        <p className="flex items-center gap-3 px-3 py-3 text-sm text-fg-3">
          Not run yet.
          <Button size="sm" variant="secondary" onClick={() => void r.start(tab)}>
            Run {tab}
          </Button>
        </p>
      )}
    </section>
  );
}

function RunTab({ v, selected, onSelect }: { v: RunView; selected: boolean; onSelect(): void }) {
  const tone = runTone(v.run);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs press-row focus-inset max-md:h-10",
        selected ? "bg-hover text-fg" : "text-fg-3 hover:text-fg-2",
      )}
    >
      {isRunning(v.run) && <Spinner />}
      <span>{v.run.name}</span>
      <span className={TONE[tone]}>{runStatusText(v.run)}</span>
    </button>
  );
}

function RunBody({ v }: { v: RunView }) {
  const run = v.run;
  const text = stripAnsi(v.output);
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [text, run.id]);
  return (
    <>
      <p className="flex shrink-0 flex-wrap items-center gap-x-3 px-3 py-1.5 text-xs text-fg-3">
        <span className={cn("font-medium", TONE[runTone(run)])}>{runStatusText(run)}</span>
        <span className="min-w-0 truncate font-mono" title={`${run.command} in ${run.cwd}`}>
          {run.command}
        </span>
        {isRunning(run) ? <LiveDuration startedAt={run.started_at} /> : <span>{durationText(run.duration_ms)}</span>}
        {run.truncated && <span>Output cut at 5 MB</span>}
        {v.clipped && <span>Earlier output not shown</span>}
      </p>
      <pre
        ref={box}
        aria-label={`Output of ${run.name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg focus-inset"
      >
        {text || (isRunning(run) ? "Waiting for output…" : "No output.")}
      </pre>
    </>
  );
}

/** Ticks only while a run is running (decision 76). */
function LiveDuration({ startedAt }: { startedAt: string }) {
  const now = useNow(true, 1000);
  return <span className="tabular-nums">{durationText(now - Date.parse(startedAt))}</span>;
}
