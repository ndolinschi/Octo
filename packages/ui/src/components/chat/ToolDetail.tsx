import { lazy, Suspense, useMemo, useState } from "react";
import { Button } from "../primitives/Button";
import { cn } from "../../lib/cn";
import { structured } from "../../lib/table";
import { acpCall } from "../../lib/tools";
import { locateInProject, looksLikeDiff } from "../../lib/toolsMore";
import { useOptionalCode } from "../../state/code";
import {
  callSummary,
  clockTime,
  commandOf,
  editView,
  inputPairs,
  rawInput,
  readTarget,
  stoppedLine,
  toolKind,
  viewState,
  type ToolKind,
} from "../../lib/toolView";
import { stepState, type ToolUse, type TurnEnd } from "../../lib/transcript";
import { HighlightedCode } from "../shared/Markdown";
import { EditBody } from "./tools/EditBody";
import { BodyFrame, INSET, useCallTimes, type RawCall } from "./tools/parts";
import { ReadBody } from "./tools/ReadBody";
import { ShellBody } from "./tools/ShellBody";
import { useTranscript } from "./transcriptContext";

/** Tabular tool results load the table component with the first one (its own chunk). */
const DataTable = lazy(() => import("../shared/DataTable").then((m) => ({ default: m.DataTable })));
const Pairs = lazy(() => import("../shared/DataTable").then((m) => ({ default: m.Pairs })));

/** At most this many lines of an unknown tool's text result are drawn. */
const RESULT_CAP = 200;

/**
 * The opened tool call (retest3 G1, toolpolish): an action with its outcome, by kind — a command's output tail and exit, a read's
 * lines, an edit's inline diff (a run of edits of one file as one diff), anything else as a key–value view. A call a stop or a
 * refusal cut short is one plain line. Every body ends in one action line with "Raw" (what the agent sent and got back).
 */
export function ToolDetail({
  use,
  more = [],
  end = null,
  interrupted = false,
}: {
  use: ToolUse;
  more?: readonly ToolUse[];
  end?: TurnEnd;
  /** A restart cut the turn (its stored exchange is `interrupted`). */
  interrupted?: boolean;
}) {
  const ctx = useTranscript();
  const result = ctx.results.get(use.id);
  const state = viewState(stepState(result, ctx.agentRunning, end, interrupted), result);
  const times = useCallTimes(use);
  const kind = toolKind(use.name, use.input);
  const output = result ? result.content : null;
  const stopped = state === "stopped" ? stoppedLine(result, end, clockTime(times.end), interrupted) : null;
  const failed = state === "error" ? (output ?? "").trim() || "The tool reported an error with no message." : null;
  const uses = useMemo(() => [use, ...more], [use, more]);
  const raw = useMemo(
    () => ({
      input: uses.map((u) => rawInput(u.name, u.input)).join("\n\n"),
      result: uses.length === 1 ? output : uses.map((u) => ctx.results.get(u.id)?.content ?? "").join("\n\n"),
    }),
    [uses, output, ctx.results],
  );
  const views = useMemo(
    () =>
      kind === "edit"
        ? uses.flatMap((u) => {
            const v = editView(u.name, u.input, ctx.results.get(u.id)?.content ?? "");
            return v ? [v] : [];
          })
        : [],
    [kind, uses, ctx.results],
  );

  if (kind === "shell") {
    const command = commandOf(use.name, use.input);
    if (command)
      return (
        <ShellBody
          command={command}
          output={stopped ? null : output}
          state={state}
          start={times.start}
          end={times.end}
          raw={raw}
          {...(stopped ? { stopped } : {})}
        />
      );
  }
  if (stopped) return <BodyFrame kind="stopped" raw={raw} lead={<span className="text-fg-2">{stopped}</span>} />;
  if (kind === "read") {
    const target = readTarget(use.name, use.input);
    if (target) return <ReadBody target={target} content={output} failed={failed} raw={raw} />;
  }
  if (kind === "edit" && views.length > 0) return <EditBody views={views} start={times.start} failed={failed} raw={raw} />;
  // An ACP delete: the row names the file; the body says what happened (the path and the empty result stay under Raw).
  if (use.name === "delete" && acpCall(use.name, use.input) && !failed) return <BodyFrame kind="delete" raw={raw} lead={<span>The file was deleted.</span>} />;
  return <OtherBody use={use} kind={kind} output={output} failed={failed} raw={raw} />;
}

/** Search, fetch and unknown tools: one summary line, the input as key–value rows, the result (a table when tabular, decision 44). */
function OtherBody({ use, kind, output, failed, raw }: { use: ToolUse; kind: ToolKind; output: string | null; failed: string | null; raw: RawCall }) {
  const code = useOptionalCode();
  const shorten = (path: string) => {
    const hit = code && path.startsWith("/") ? locateInProject(code.folders, path) : null;
    return hit ? `${hit.folder}/${hit.path}` : path;
  };
  // The row already says what was looked for: the action line keeps only how many results came back.
  const summary = callSummary(kind, use.name, use.input, failed ? null : output, shorten);
  const count = /· (\d+ results?)$/.exec(summary)?.[1] ?? "";
  const pairs = useMemo(() => inputPairs(use.name, use.input), [use.name, use.input]);
  const acp = acpCall(use.name, use.input);
  return (
    <BodyFrame kind="other" raw={raw} lead={count ? <span>{count}</span> : output !== null && !output.trim() && !failed && <span>No output</span>}>
      {pairs.length > 0 && (
        <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1", INSET)}>
          {pairs.map((p) => (
            <div key={p.key} className="contents">
              <dt className="text-fg-3">{p.key}</dt>
              <dd className={cn("min-w-0 break-words text-fg-2", p.mono && "font-mono")}>{p.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {failed ? (
        <p className={cn(INSET, pairs.length > 0 && "border-t border-line", "text-err")}>{failed}</p>
      ) : (
        output !== null && output.trim() !== "" && <ResultView body={output} bordered={pairs.length > 0} />
      )}
      {pairs.length === 0 && output === null && !failed && <p className={cn(INSET, "text-fg-3")}>{acp ? acp.title : use.name}: no input.</p>}
    </BodyFrame>
  );
}

function ResultView({ body, bordered }: { body: string; bordered: boolean }) {
  // Decision 44: a tabular result (CSV, JSON rows) is a table and a short key–value result a list; "Text" shows it as text.
  const shape = useMemo(() => structured(body), [body]);
  const [text, setText] = useState(false);
  const lines = useMemo(() => body.split("\n"), [body]);
  return (
    <div className={cn(bordered && "border-t border-line")}>
      {shape && (
        <div className="flex justify-end px-2 pt-1">
          <Button variant="quiet" size="xs" pressed={text} onClick={() => setText((x) => !x)}>
            {text ? "Table" : "Text"}
          </Button>
        </div>
      )}
      {shape && !text ? (
        <div data-tool-table className="max-h-96 overflow-y-auto px-3 pb-1">
          <Suspense fallback={<p className="h-row" aria-busy />}>
            {shape.kind === "table" ? (
              <DataTable table={shape.table} tone="code" />
            ) : (
              <div className="pb-2">
                <Pairs pairs={shape.pairs} />
              </div>
            )}
          </Suspense>
        </div>
      ) : body.trim() ? (
        <pre className="max-h-64 overflow-auto px-3 py-2 font-mono leading-5 whitespace-pre-wrap text-fg-2">
          {/* A diff (a patch) gets the chat's diff colours. */}
          <HighlightedCode code={lines.slice(0, RESULT_CAP).join("\n")} lang={looksLikeDiff(body) ? "diff" : undefined} />
          {lines.length > RESULT_CAP && `\n… ${lines.length - RESULT_CAP} more lines (Raw has them all)`}
        </pre>
      ) : null}
    </div>
  );
}
