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
import { FRAME, INSET, Raw, useCallTimes } from "./tools/parts";
import { ReadBody } from "./tools/ReadBody";
import { ShellBody } from "./tools/ShellBody";
import { useTranscript } from "./transcriptContext";

/** Tabular tool results load the table component with the first one (its own chunk). */
const DataTable = lazy(() => import("../shared/DataTable").then((m) => ({ default: m.DataTable })));
const Pairs = lazy(() => import("../shared/DataTable").then((m) => ({ default: m.Pairs })));

/** At most this many lines of an unknown tool's text result are drawn. */
const RESULT_CAP = 200;

/**
 * The opened tool call (retest3 G1): an action with its outcome, by kind — a command with its output tail and exit, a read as
 * `path:lines`, an edit as a compact diff, anything else as a summary and a key–value view. A call a stop or a refusal cut short is
 * one plain line; what the agent or the harness answered stays under "Raw".
 */
export function ToolDetail({ use, end = null }: { use: ToolUse; end?: TurnEnd }) {
  const ctx = useTranscript();
  const result = ctx.results.get(use.id);
  const state = viewState(stepState(result, ctx.agentRunning, end), result);
  const times = useCallTimes(use);
  const kind = toolKind(use.name, use.input);
  const output = result ? result.content : null;
  const stopped = state === "stopped" ? stoppedLine(result, end, clockTime(times.end)) : null;
  const failed = state === "error" ? (output ?? "").trim() || "The tool reported an error with no message." : null;
  const raw = <Raw input={rawInput(use.name, use.input)} result={output} />;

  const body = (() => {
    if (kind === "shell") {
      const command = commandOf(use.name, use.input);
      if (command)
        return (
          <ShellBody command={command} output={stopped ? null : output} state={state} start={times.start} end={times.end} {...(stopped ? { stopped } : {})} />
        );
    }
    if (stopped) return <Stopped text={stopped} />;
    if (kind === "read") {
      const target = readTarget(use.name, use.input);
      if (target) return <ReadBody target={target} content={output} failed={failed} />;
    }
    if (kind === "edit") {
      const view = editView(use.name, use.input, output ?? "");
      if (view) return <EditBody view={view} start={times.start} failed={failed} />;
    }
    return <OtherBody use={use} kind={kind} output={output} failed={failed} />;
  })();

  return (
    <div data-tool-detail className="flex min-w-0 flex-col gap-1">
      {body}
      <div className="pl-2">{raw}</div>
    </div>
  );
}

/** A call cut short: the one line, quiet (never the error tone). */
function Stopped({ text }: { text: string }) {
  return (
    <div data-tool-body="stopped" className={cn(FRAME, INSET, "text-fg-2")}>
      {text}
    </div>
  );
}

/** Search, fetch and unknown tools: one summary line, the input as key–value rows, the result (a table when tabular, decision 44). */
function OtherBody({ use, kind, output, failed }: { use: ToolUse; kind: ToolKind; output: string | null; failed: string | null }) {
  const code = useOptionalCode();
  const shorten = (path: string) => {
    const hit = code && path.startsWith("/") ? locateInProject(code.folders, path) : null;
    return hit ? `${hit.folder}/${hit.path}` : path;
  };
  const summary = callSummary(kind, use.name, use.input, failed ? null : output, shorten);
  const pairs = useMemo(() => inputPairs(use.name, use.input), [use.name, use.input]);
  const acp = acpCall(use.name, use.input);
  return (
    <div data-tool-body="other" className={FRAME}>
      {summary && <p className={cn(INSET, "text-fg-2")}>{summary}</p>}
      {pairs.length > 0 && (
        <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1", INSET, summary && "border-t border-line")}>
          {pairs.map((p) => (
            <div key={p.key} className="contents">
              <dt className="text-fg-3">{p.key}</dt>
              <dd className={cn("min-w-0 break-words text-fg-2", p.mono && "font-mono")}>{p.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {failed ? (
        <p className={cn(INSET, "border-t border-line text-err")}>{failed}</p>
      ) : (
        output !== null && <ResultView body={output} bordered={Boolean(summary) || pairs.length > 0} />
      )}
      {!summary && pairs.length === 0 && output === null && !failed && <p className={cn(INSET, "text-fg-3")}>{acp ? acp.title : use.name}: no input.</p>}
    </div>
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
      ) : (
        <p className={cn(INSET, "text-fg-3")}>No output.</p>
      )}
    </div>
  );
}
