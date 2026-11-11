import { ChevronRight } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { lazy, Suspense, useId, useState } from "react";

import { cn } from "../../lib/cn";
import { acpCall, toolMeta } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { RunningDot } from "../primitives/Status";
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

function Summary({ uses }: { uses: ToolUse[] }) {
  const [use] = uses;
  if (uses.length !== 1 || !use) return <span className="truncate">{summarize(uses)}</span>;
  const meta = toolMeta(use.name, use.input);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{meta.verb}</span>
      {meta.arg && <Arg use={use} text={meta.arg} />}
      {meta.folder && <span className="shrink-0">in {meta.folder}</span>}
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

/** One muted line per run of tool calls; collapsed by default. */
export function ToolGroup({ uses }: { uses: ToolUse[] }) {
  const ctx = useTranscript();
  const rows = uses.map((use) => ({ use, state: toolState(ctx, use.id) }));
  const running = rows.some((r) => r.state === "running");
  const errors = rows.filter((r) => r.state === "error").length;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [only] = uses;
  const single = uses.length === 1;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="group -mx-2 flex h-row max-w-[calc(100%+16px)] items-center gap-2 rounded-sm px-2 text-sm text-fg-3 press-row hover:bg-hover hover:text-fg-2"
      >
        <Summary uses={uses} />
        {running && <RunningDot />}
        {errors > 0 && <span className="shrink-0 text-err">{single ? "failed" : `${errors} failed`}</span>}
        <Glyph icon={ChevronRight} size={14} className={cn("shrink-0 transition-[rotate] duration-150", open && "rotate-90")} />
      </button>
      {open && (
        <div id={panelId} className="mt-1">
          {single && only ? <ToolDetail use={only} /> : rows.map((r) => <ToolRow key={r.use.id} use={r.use} state={r.state} />)}
        </div>
      )}
    </div>
  );
}

function ToolRow({ use, state }: { use: ToolUse; state: ToolState }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const meta = toolMeta(use.name, use.input);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex h-row w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-sm px-2 text-left font-mono text-xs press-row hover:bg-hover"
      >
        <span className="shrink-0 font-sans text-fg-2">{meta.verb}</span>
        {meta.arg && <Arg use={use} text={meta.arg} className="text-fg-3" />}
        {meta.folder && <span className="shrink-0 font-sans text-fg-3">in {meta.folder}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-sans">
          {state === "running" && <RunningDot />}
          {state === "error" && <span className="text-err">failed</span>}
          {state === "interrupted" && <span className="text-fg-3">no result</span>}
        </span>
      </button>
      {open && (
        <div id={panelId} className="mt-1 mb-2">
          <ToolDetail use={use} />
        </div>
      )}
    </div>
  );
}
