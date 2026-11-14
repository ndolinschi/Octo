import { lazy, Suspense } from "react";

import { cn } from "../../lib/cn";
import { acpCall, toolMeta } from "../../lib/tools";
import { acpCommandRow, editView, groupSummary, toolKind, viewState } from "../../lib/toolView";
import { stepState, type StepState, type ToolUse, type TurnEnd } from "../../lib/transcript";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { useTranscript } from "./transcriptContext";

/** A tool call's input and result load with the first one opened (their own chunk: links, tables, diff colours). */
const ToolDetailLazy = lazy(() => import("./ToolDetail").then((m) => ({ default: m.ToolDetail })));
function ToolDetail({ use, end }: { use: ToolUse; end: TurnEnd }) {
  return (
    <Suspense fallback={<div className="h-row rounded-md bg-code-bg" aria-busy />}>
      <ToolDetailLazy use={use} end={end} />
    </Suspense>
  );
}

/** retest3 G1: an ACP command reads "Ran git push …" (its title is the command line, whatever its first word). */
function rowMeta(use: ToolUse): { verb: string; arg: string; folder: string } {
  const meta = toolMeta(use.name, use.input);
  const acp = acpCall(use.name, use.input);
  if (acp && use.name === "execute") return { ...acpCommandRow(acp.title), folder: "" };
  // The built-in `edit` tool (old → new string) reads like `write_file`: "Edited src/x.ts".
  const input = typeof use.input === "object" && use.input !== null ? (use.input as { path?: unknown; folder?: unknown }) : {};
  if (!acp && use.name === "edit" && typeof input.path === "string")
    return { verb: "Edited", arg: input.path, folder: meta.folder || (typeof input.folder === "string" ? input.folder : "") };
  return meta;
}

/** An edit row's "+N −M" (G2: the size of the change is on the row, before it is opened). */
function EditCounts({ use }: { use: ToolUse }) {
  const ctx = useTranscript();
  const result = ctx.results.get(use.id);
  if (result?.is_error || toolKind(use.name, use.input) !== "edit") return null;
  const view = editView(use.name, use.input, typeof result?.content === "string" ? result.content : "");
  if (!view || (view.added === 0 && view.removed === 0)) return null;
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-ok">+{view.added}</span> <span className="text-err">−{view.removed}</span>
    </span>
  );
}

/** The argument of a call: code-like text (a path, a command) in mono; an ACP title's prose stays in the UI face. */
const isCodeLike = (text: string) => !/\s/.test(text.trim()) || /[/\\]/.test(text.split(" ")[0] ?? "");

function Arg({ use, text, className }: { use: ToolUse; text: string; className?: string }) {
  // An ACP "execute" title is a command line: mono, like the built-in bash row.
  const prose = acpCall(use.name, use.input) !== null && use.name !== "execute" && !isCodeLike(text);
  // The argument is content (a path, a command), shortened by design; the full text is in the row's tooltip.
  return (
    <span data-allow-truncate className={cn("min-w-0 truncate", prose ? "font-sans text-sm" : "font-mono text-xs", className)}>
      {text}
    </span>
  );
}

/** One activity row per run of tool calls (decision 91d); collapsed by default. `end`: how the turn ended (a stop's call reads "stopped"). */
export function ToolGroup({ uses, end = null }: { uses: ToolUse[]; end?: TurnEnd }) {
  const ctx = useTranscript();
  // A refusal (the agent's "rejected", the harness's deny) reads as stopped, never failed (retest3 G1).
  const rows = uses.map((use) => ({ use, state: viewState(stepState(ctx.results.get(use.id), ctx.agentRunning, end), ctx.results.get(use.id)) }));
  const running = rows.some((r) => r.state === "running");
  const errors = rows.filter((r) => r.state === "error").length;
  const [only] = uses;
  const single = uses.length === 1 ? only : undefined;
  const meta = single ? rowMeta(single) : null;
  const state: ActivityState = running ? "running" : errors > 0 ? "failed" : rows.some((r) => r.state === "stopped") ? "stopped" : "done";
  return (
    <ActivityRow
      state={state}
      verb={single && meta ? meta.verb : groupSummary(uses)}
      detail={
        single && meta ? (
          <span className="flex min-w-0 items-baseline gap-1.5">
            {meta.arg && <Arg use={single} text={meta.arg} />}
            {meta.folder && <span className="shrink-0">in {meta.folder}</span>}
            <EditCounts use={single} />
            {errors > 0 ? <span className="shrink-0">failed</span> : state === "stopped" && <span className="shrink-0">stopped</span>}
          </span>
        ) : (
          [errors > 0 ? `${errors} failed` : "", rows.some((r) => r.state === "stopped") ? "stopped" : ""].filter(Boolean).join(" · ") || undefined
        )
      }
    >
      {single ? <ToolDetail use={single} end={end} /> : rows.map((r) => <ToolRow key={r.use.id} use={r.use} state={r.state} end={end} />)}
    </ActivityRow>
  );
}

function ToolRow({ use, state, end }: { use: ToolUse; state: StepState; end: TurnEnd }) {
  const meta = rowMeta(use);
  const row: ActivityState = state === "running" ? "running" : state === "error" ? "failed" : state;
  return (
    <ActivityRow
      state={row}
      verb={meta.verb}
      detail={
        <span className="flex min-w-0 items-baseline gap-1.5">
          {meta.arg && <Arg use={use} text={meta.arg} />}
          {meta.folder && <span className="shrink-0">in {meta.folder}</span>}
          <EditCounts use={use} />
          {state === "stopped" && <span className="shrink-0">stopped</span>}
        </span>
      }
    >
      <ToolDetail use={use} end={end} />
    </ActivityRow>
  );
}
