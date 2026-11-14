import { useMemo, useState } from "react";
import { cn } from "../../../lib/cn";
import { formatDuration } from "../../../lib/format";
import { exitLabel, spanMs, splitLines, tailLines } from "../../../lib/toolView";
import type { StepState } from "../../../lib/transcript";
import { BodyFrame, CopyAction, Disclosure, TextAction, type RawCall } from "./parts";

/** Lines of output shown under a command before "Show all"; then at most this many at a time ("Show more"). */
const TAIL = 8;
const PAGE = 1000;
/** A command longer than this (or on several lines) is written out in the body: the row shows only its start. */
const LONG_COMMAND = 72;

/**
 * retest3 G1 (toolpolish): a command as an action with its outcome — the row says the command; the body is its output's last
 * lines (wrapped like a terminal, columns kept: mono, `pre-wrap`), the earlier lines on demand at the top, and one action line:
 * the exit in words and how long it ran on the left, "Copy command" and "Raw" on the right. A long or multi-line command is
 * written out first. Output is never coloured as an error; only the exit of a command that failed is.
 */
export function ShellBody(props: {
  command: string;
  output: string | null;
  state: StepState;
  start: string | null;
  end: string | null;
  stopped?: string;
  raw: RawCall;
}) {
  const { command, output, state } = props;
  const [shown, setShown] = useState(0);
  const tail = useMemo(() => tailLines(output ?? "", TAIL), [output]);
  const all = useMemo(() => (shown > 0 ? splitLines(output ?? "") : null), [shown, output]);
  const lines = all ? all.slice(0, shown) : tail.lines;
  const ms = spanMs(props.start, props.end);
  const exit = props.stopped ?? exitLabel(state, output ?? "");
  const long = command.includes("\n") || command.length > LONG_COMMAND;
  const empty = output !== null && splitLines(output).length === 0 && state === "done";
  return (
    <BodyFrame
      kind="shell"
      raw={props.raw}
      lead={
        <>
          <span className={cn(state === "error" && "text-err")}>{exit}</span>
          {ms !== null && state !== "running" && !props.stopped && <span>· {formatDuration(ms)}</span>}
          {empty && <span>· no output</span>}
        </>
      }
      actions={
        <>
          {all && shown < all.length && (
            <TextAction onClick={() => setShown((n) => Math.min(all.length, n + PAGE))}>Show more ({all.length - shown} left)</TextAction>
          )}
          {all && <TextAction onClick={() => setShown(0)}>Show the last {TAIL}</TextAction>}
          <CopyAction text={command} label="Copy command" />
        </>
      }
    >
      {(long || lines.length > 0) && (
        <>
          {long && (
            <pre className={cn("px-3 py-2 font-mono leading-5 break-words whitespace-pre-wrap text-fg", lines.length > 0 && "border-b border-line")}>
              <span aria-hidden className="text-fg-3 select-none">
                ${" "}
              </span>
              {command}
            </pre>
          )}
          {lines.length > 0 && (
            <div>
              {!all && tail.hidden > 0 && (
                <div className="px-3 pt-1">
                  <Disclosure open={false} onToggle={() => setShown(Math.min(tail.total, PAGE))}>
                    Show {tail.hidden} earlier line{tail.hidden === 1 ? "" : "s"}
                  </Disclosure>
                </div>
              )}
              <pre
                data-tool-output
                className={cn("octo-out px-3 font-mono leading-5 text-fg-2", all ? "max-h-96 overflow-y-auto py-2" : "py-2", !all && tail.hidden > 0 && "pt-0")}
              >
                {/* A line per block so a wrapped line hangs under its own start (columns of test output stay readable). */}
                {lines.map((l, i) => (
                  <span key={i} className="octo-out-line">
                    {l || " "}
                  </span>
                ))}
              </pre>
            </div>
          )}
        </>
      )}
    </BodyFrame>
  );
}
