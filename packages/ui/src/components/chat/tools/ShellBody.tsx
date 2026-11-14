import { useMemo, useState } from "react";
import { cn } from "../../../lib/cn";
import { formatDuration } from "../../../lib/format";
import { exitLabel, spanMs, splitLines, tailLines } from "../../../lib/toolView";
import type { StepState } from "../../../lib/transcript";
import { CopyButton, Disclosure, FRAME, INSET } from "./parts";

/** Lines of output shown under a command before "Show all"; then at most this many at a time ("Show more"). */
const TAIL = 8;
const PAGE = 1000;

/**
 * retest3 G1: a command as an action with its outcome — the command line (mono, wrapped, copy), the last lines of its output in a
 * quiet block (all of it on demand, a page at a time), then the exit in words and how long it ran. Output is never coloured as an
 * error; only the exit of a command that failed is.
 */
export function ShellBody(props: { command: string; output: string | null; state: StepState; start: string | null; end: string | null; stopped?: string }) {
  const { command, output, state } = props;
  const [shown, setShown] = useState(0);
  const tail = useMemo(() => tailLines(output ?? "", TAIL), [output]);
  const all = useMemo(() => (shown > 0 ? splitLines(output ?? "") : null), [shown, output]);
  const lines = all ? all.slice(0, shown) : tail.lines;
  const ms = spanMs(props.start, props.end);
  const exit = props.stopped ?? exitLabel(state, output ?? "");
  return (
    <div data-tool-body="shell" className={FRAME}>
      <div className={cn("flex min-w-0 items-start gap-2", INSET)}>
        <span aria-hidden className="shrink-0 font-mono leading-5 text-fg-3 select-none">
          $
        </span>
        <code className="min-w-0 flex-1 font-mono leading-5 break-words whitespace-pre-wrap text-fg">{command}</code>
        <span className="-my-0.5 shrink-0">
          <CopyButton text={command} label="Copy command" />
        </span>
      </div>
      {lines.length > 0 && (
        <div className="border-t border-line">
          {!all && tail.hidden > 0 && (
            <div className="px-3 pt-1">
              <Disclosure open={false} onToggle={() => setShown(Math.min(tail.total, PAGE))}>
                {tail.hidden} earlier line{tail.hidden === 1 ? "" : "s"}
              </Disclosure>
            </div>
          )}
          <pre
            data-tool-output
            className={cn(
              "px-3 font-mono leading-5 break-words whitespace-pre-wrap text-fg-2",
              all ? "max-h-96 overflow-y-auto py-1" : "py-2",
              !all && tail.hidden > 0 && "pt-0",
            )}
          >
            {lines.join("\n")}
          </pre>
          {all && (
            <div className="flex items-center gap-3 px-3 pb-1">
              {shown < all.length && (
                <Disclosure open={false} onToggle={() => setShown((n) => Math.min(all.length, n + PAGE))}>
                  Show more ({all.length - shown} lines left)
                </Disclosure>
              )}
              <Disclosure open onToggle={() => setShown(0)}>
                Show the last {TAIL} lines
              </Disclosure>
            </div>
          )}
        </div>
      )}
      <div className={cn("flex items-center gap-1.5 border-t border-line tabular-nums", INSET)}>
        <span className={cn(state === "error" ? "text-err" : "text-fg-3")}>{exit}</span>
        {ms !== null && state !== "running" && !props.stopped && <span className="text-fg-3">· {formatDuration(ms)}</span>}
        {output !== null && splitLines(output).length === 0 && state === "done" && <span className="text-fg-3">· no output</span>}
      </div>
    </div>
  );
}
