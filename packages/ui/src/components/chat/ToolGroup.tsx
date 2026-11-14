import { lazy, Suspense, useMemo } from "react";

import { cn } from "../../lib/cn";
import { locateInProject } from "../../lib/toolsMore";
import { callRow, editView, groupProblems, groupState, groupSummary, mergeRuns, toolKind, viewState, type CallRow } from "../../lib/toolView";
import { stepState, type StepState, type ToolUse, type TurnEnd } from "../../lib/transcript";
import { useOptionalCode } from "../../state/code";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { useTranscript } from "./transcriptContext";

/** A tool call's input and result load with the first one opened (their own chunk: links, tables, diff colours). */
const ToolDetailLazy = lazy(() => import("./ToolDetail").then((m) => ({ default: m.ToolDetail })));
function ToolDetail({ uses, end, interrupted }: { uses: readonly ToolUse[]; end: TurnEnd; interrupted: boolean }) {
  const [use, ...more] = uses;
  if (!use) return null;
  return (
    <Suspense fallback={<div className="h-row rounded-md bg-code-bg" aria-busy />}>
      <ToolDetailLazy use={use} more={more} end={end} interrupted={interrupted} />
    </Suspense>
  );
}

type Item = { use: ToolUse; state: StepState; row: CallRow };

const ROW_STATE: Record<StepState, ActivityState> = { running: "running", error: "failed", stopped: "stopped", done: "done" };
const WORD: Partial<Record<StepState, string>> = { error: "failed", stopped: "stopped" };

/** A run's "+N −M" (G2: the size of the change is on the row, before it is opened); null for anything but finished edits. */
function EditCounts({ uses }: { uses: readonly ToolUse[] }) {
  const ctx = useTranscript();
  let added = 0;
  let removed = 0;
  for (const use of uses) {
    const result = ctx.results.get(use.id);
    if (result?.is_error || toolKind(use.name, use.input) !== "edit") return null;
    const view = editView(use.name, use.input, typeof result?.content === "string" ? result.content : "");
    if (!view) return null;
    added += view.added;
    removed += view.removed;
  }
  if (added === 0 && removed === 0) return null;
  return (
    <span className="shrink-0 tabular-nums">
      {added > 0 && <span className="text-ok">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-err">−{removed}</span>}
    </span>
  );
}

/**
 * The words of a row (toolpolish): the object (mono for a path, a command, a pattern; a phrase stays in the UI face), a quiet
 * qualifier, the folder only when the group spans several, "2 edits" for a merged run, then +N −M.
 */
function RowDetail({ run, folder }: { run: readonly Item[]; folder: boolean }) {
  const [first] = run;
  if (!first) return null;
  const { row } = first;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {row.object && (
        // The object is content (a path, a command), shortened by design; the full text is in the row's tooltip.
        <span data-allow-truncate className={cn("min-w-0 truncate", row.mono ? "font-mono text-xs" : "font-sans text-sm")}>
          {row.object}
        </span>
      )}
      {row.qualifier && <span className="shrink-0">{row.qualifier}</span>}
      {folder && row.folder && <span className="shrink-0">in {row.folder}</span>}
      {run.length > 1 && <span className="shrink-0">· {run.length} edits</span>}
      <EditCounts uses={run.map((r) => r.use)} />
    </span>
  );
}

function tipOf(run: readonly Item[]): string {
  const [first] = run;
  if (!first) return "";
  const { row } = first;
  return [row.verb, row.object, row.qualifier, run.length > 1 ? `· ${run.length} edits` : ""].filter(Boolean).join(" ");
}

/**
 * One activity row per run of tool calls (decision 91d); collapsed by default. Every row has one grammar (`callRow`): a
 * past-tense verb, the object, a quiet qualifier; its state is the leading glyph and, when it is not "done", a quiet word at the
 * right. Consecutive edits of one file are one row with one combined diff. The group's summary leads with what was done and puts
 * problems as a quiet suffix; its glyph shows the worst state only when every call ended that way (`groupState`).
 * `end`: how the turn ended (a stop's call reads "stopped"); `interrupted`: a restart cut the turn (its calls read "interrupted").
 */
export function ToolGroup({ uses, end = null, interrupted = false }: { uses: ToolUse[]; end?: TurnEnd; interrupted?: boolean }) {
  const ctx = useTranscript();
  const code = useOptionalCode();
  const locate = useMemo(() => (code ? (p: string) => locateInProject(code.folders, p) : () => null), [code]);
  // A refusal (the agent's "rejected", the harness's deny) reads as stopped, never failed (retest3 G1).
  const items: Item[] = uses.map((use) => {
    const result = ctx.results.get(use.id);
    return { use, state: viewState(stepState(result, ctx.agentRunning, end, interrupted), result), row: callRow(use.name, use.input, locate) };
  });
  const runs = mergeRuns(items, (it) =>
    it.state === "done" && it.row.path && toolKind(it.use.name, it.use.input) === "edit" ? `${it.row.folder}\u0001${it.row.path}` : "",
  );
  const folder = (code?.folders.length ?? 0) > 1 && new Set(items.map((it) => it.row.folder).filter(Boolean)).size > 1;
  const [only] = runs;
  if (runs.length === 1 && only) return <ToolRow run={only} folder={folder} end={end} interrupted={interrupted} />;
  const states = items.map((it) => it.state);
  const problems = groupProblems(states, interrupted ? "interrupted" : "stopped");
  return (
    <ActivityRow
      state={ROW_STATE[groupState(states)]}
      // One truncating line (the problems are part of it, dim) so a narrow column cuts it with an ellipsis before the chevron.
      verb={
        <>
          {groupSummary(uses)}
          {problems && <span className="text-fg-3"> · {problems}</span>}
        </>
      }
      tip={[groupSummary(uses), problems].filter(Boolean).join(" · ")}
    >
      {runs.map((run) => (
        <ToolRow key={run[0]?.use.id} run={run} folder={folder} end={end} interrupted={interrupted} />
      ))}
    </ActivityRow>
  );
}

function ToolRow({ run, folder, end, interrupted }: { run: readonly Item[]; folder: boolean; end: TurnEnd; interrupted: boolean }) {
  const [first] = run;
  if (!first) return null;
  const word = interrupted && first.state === "stopped" ? "interrupted" : WORD[first.state];
  return (
    <ActivityRow
      state={ROW_STATE[first.state]}
      verb={first.row.verb}
      detail={<RowDetail run={run} folder={folder} />}
      tip={tipOf(run)}
      {...(word ? { aside: word } : {})}
    >
      <ToolDetail uses={run.map((r) => r.use)} end={end} interrupted={interrupted} />
    </ActivityRow>
  );
}
