import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { durationText, runStatusText, runTone, stripAnsi, type RunTone } from "../../lib/commands/format";
import { isRunning, type RunView } from "../../lib/commands/runs";
import { useNow } from "../../lib/hooks";
import type { GlyphState } from "../../lib/stateGlyph";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { StateGlyph } from "../primitives/StateGlyph";
import { useRuns } from "./RunsContext";

const TONE: Record<RunTone, string> = { run: "text-fg-2", ok: "text-ok", err: "text-err", muted: "text-fg-3" };
const GLYPH: Record<RunTone, GlyphState> = { run: "working", ok: "idle", err: "failed", muted: "idle" };
/** How far from the end still counts as following the output. */
const FOLLOW_SLACK_PX = 24;

/**
 * The runs of this review and the output of the selected one, under the diff (decision 68). In a "Run: name" tab (`tab`) the
 * header is the one status line (decision 91): name · state glyph · the command in dim mono · duration at the right · Stop or
 * Re-run — no chip and no second row repeating the status. In a review's panel the header lists the runs, each with its status,
 * and the body starts with the command line. Output streams in as `command.output` events and follows the end until the reader
 * scrolls up. Nothing animates except the glyph of a run that is running.
 */
export function RunPanel({ tab }: { /** The "Run: name" tab (decision 68): fills its tab, names the command, has no close button. */ tab?: string } = {}) {
  const r = useRuns();
  if (!r.panelOpen && tab === undefined) return null;
  const cur = r.current;
  const action =
    cur &&
    (isRunning(cur.run) ? (
      <Button size="sm" variant="secondary" onClick={() => void r.stop(cur.run.id)}>
        Stop
      </Button>
    ) : (
      <Button size="sm" variant="secondary" disabled={!r.worktreePresent} onClick={() => void r.start(cur.run.name)}>
        Re-run
      </Button>
    ));
  return (
    <section
      aria-label={tab === undefined ? "Command runs" : `Runs of ${tab}`}
      className={cn("flex min-h-0 flex-col bg-panel", tab === undefined ? "h-1/3 min-h-48 shrink-0 border-t border-line" : "flex-1")}
    >
      <header className="flex min-h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        {tab !== undefined ? (
          cur ? (
            <RunLine v={cur} />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{tab}</span>
          )
        ) : (
          <div role="tablist" aria-label="Runs of this review" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {r.runs.map((v) => (
              <Button
                key={v.run.id}
                role="tab"
                variant="quiet"
                size="sm"
                aria-selected={cur?.run.id === v.run.id}
                pressed={cur?.run.id === v.run.id}
                onClick={() => r.select(v.run.id)}
              >
                {v.run.name}
                <span className={TONE[runTone(v.run)]}>{runStatusText(v.run)}</span>
              </Button>
            ))}
            {r.runs.length === 0 && <span className="px-2 text-xs text-fg-3">No runs yet</span>}
          </div>
        )}
        {action}
        {tab === undefined && <IconButton icon={X} label="Close the run panel" onClick={r.closePanel} />}
      </header>
      {r.error && (
        <p role="alert" className="shrink-0 border-b border-line px-3 py-1.5 text-xs text-err">
          {r.error}
        </p>
      )}
      {cur ? (
        <RunBody v={cur} withLine={tab === undefined} />
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

/** Name · state glyph · command (dim mono) · duration: the whole status of a run, once. A failure also says so in words. */
function RunLine({ v }: { v: RunView }) {
  const run = v.run;
  const tone = runTone(run);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 text-sm text-fg">{run.name}</span>
      <span title={runStatusText(run)} className="flex shrink-0">
        <StateGlyph state={GLYPH[tone]} label />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3" title={`${run.command} in ${run.cwd}`}>
        {run.command}
      </span>
      {tone === "err" && <span className="shrink-0 text-xs text-err">{runStatusText(run)}</span>}
      <span className="shrink-0 text-xs text-fg-3">{isRunning(run) ? <LiveDuration startedAt={run.started_at} /> : durationText(run.duration_ms)}</span>
    </div>
  );
}

function RunBody({ v, withLine }: { v: RunView; withLine: boolean }) {
  const run = v.run;
  const text = stripAnsi(v.output);
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [text, run.id]);
  const notes = [run.truncated && "Output cut at 5 MB", v.clipped && "Earlier output not shown"].filter(Boolean);
  return (
    <>
      {(withLine || notes.length > 0) && (
        <p className="flex shrink-0 flex-wrap items-center gap-x-3 px-3 py-1.5 text-xs text-fg-3">
          {withLine && (
            <>
              <span className={cn("font-medium", TONE[runTone(run)])}>{runStatusText(run)}</span>
              <span className="min-w-0 truncate font-mono" title={`${run.command} in ${run.cwd}`}>
                {run.command}
              </span>
              {isRunning(run) ? <LiveDuration startedAt={run.started_at} /> : <span>{durationText(run.duration_ms)}</span>}
            </>
          )}
          {notes.map((n) => (
            <span key={String(n)}>{n}</span>
          ))}
        </p>
      )}
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
