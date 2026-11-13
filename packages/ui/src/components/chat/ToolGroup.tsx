import { lazy, Suspense } from "react";

import { cn } from "../../lib/cn";
import { acpCall, toolMeta } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { toolState, useTranscript, type ToolState } from "./transcriptContext";

/** A tool call's input and result load with the first one opened (their own chunk: links, tables, diff colours). */
const ToolDetailLazy = lazy(() => import("./ToolDetail").then((m) => ({ default: m.ToolDetail })));
function ToolDetail({ use }: { use: ToolUse }) {
  return (
    <Suspense fallback={<div className="h-row rounded-md bg-code-bg" aria-busy />}>
      <ToolDetailLazy use={use} />
    </Suspense>
  );
}

const PHRASES: Record<string, [string, string]> = {
  read_file: ["read", "file"],
  list_dir: ["listed", "folder"],
  bash: ["ran", "command"],
  write_file: ["wrote", "file"],
  save_note: ["saved", "note"],
  delete_note: ["deleted", "note"],
};

/** ACP kinds as summary phrases (the title says the rest). */
const ACP_PHRASES: Record<string, [string, string]> = {
  read: ["read", "file"],
  edit: ["edited", "file"],
  delete: ["deleted", "file"],
  move: ["moved", "file"],
  execute: ["ran", "command"],
  search: ["ran", "search"],
  fetch: ["fetched", "page"],
};

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

function summarize(uses: ToolUse[]): string {
  const counts = new Map<string, number>();
  for (const u of uses) {
    const acp = acpCall(u.name, u.input) !== null;
    const key = acp ? (u.name in ACP_PHRASES ? `acp:${u.name}` : "other") : u.name in PHRASES ? u.name : "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([key, n]) => {
    const phrase = key.startsWith("acp:") ? ACP_PHRASES[key.slice(4)] : PHRASES[key];
    if (key === "other" || !phrase) return `called ${n} tool${n === 1 ? "" : "s"}`;
    const [verb, noun] = phrase;
    return `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`;
  });
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One activity row per run of tool calls (decision 91d); collapsed by default. */
export function ToolGroup({ uses }: { uses: ToolUse[] }) {
  const ctx = useTranscript();
  const rows = uses.map((use) => ({ use, state: toolState(ctx, use.id) }));
  const running = rows.some((r) => r.state === "running");
  const errors = rows.filter((r) => r.state === "error").length;
  const [only] = uses;
  const single = uses.length === 1 ? only : undefined;
  const meta = single ? toolMeta(single.name, single.input) : null;
  const state: ActivityState = running ? "running" : errors > 0 ? "failed" : rows.some((r) => r.state === "interrupted") ? "stopped" : "done";
  return (
    <ActivityRow
      state={state}
      verb={single && meta ? meta.verb : summarize(uses)}
      detail={
        single && meta ? (
          <span className="flex min-w-0 items-baseline gap-1.5">
            {meta.arg && <Arg use={single} text={meta.arg} />}
            {meta.folder && <span className="shrink-0">in {meta.folder}</span>}
            {errors > 0 && <span className="shrink-0">failed</span>}
          </span>
        ) : errors > 0 ? (
          `${errors} failed`
        ) : undefined
      }
    >
      {single ? <ToolDetail use={single} /> : rows.map((r) => <ToolRow key={r.use.id} use={r.use} state={r.state} />)}
    </ActivityRow>
  );
}

function ToolRow({ use, state }: { use: ToolUse; state: ToolState }) {
  const meta = toolMeta(use.name, use.input);
  const row: ActivityState = state === "running" ? "running" : state === "error" ? "failed" : state === "interrupted" ? "stopped" : "done";
  return (
    <ActivityRow
      state={row}
      verb={meta.verb}
      detail={
        <span className="flex min-w-0 items-baseline gap-1.5">
          {meta.arg && <Arg use={use} text={meta.arg} />}
          {meta.folder && <span className="shrink-0">in {meta.folder}</span>}
          {state === "interrupted" && <span className="shrink-0">no result</span>}
        </span>
      }
    >
      <ToolDetail use={use} />
    </ActivityRow>
  );
}
