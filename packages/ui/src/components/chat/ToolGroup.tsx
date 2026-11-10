import { AlertCircle, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { toolMeta } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { toolState, useTranscript, type ToolState } from "./transcriptContext";

const PHRASES: Record<string, [string, string]> = {
  read_file: ["read", "file"],
  list_dir: ["listed", "folder"],
  bash: ["ran", "command"],
  write_file: ["wrote", "file"],
  save_note: ["saved", "note"],
  delete_note: ["deleted", "note"],
};

function summarize(uses: ToolUse[]): string {
  const counts = new Map<string, number>();
  for (const u of uses) {
    const key = u.name in PHRASES ? u.name : "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([key, n]) => {
    if (key === "other") return `called ${n} tool${n === 1 ? "" : "s"}`;
    const [verb, noun] = PHRASES[key];
    return `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`;
  });
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ToolGroup({ uses }: { uses: ToolUse[] }) {
  const ctx = useTranscript();
  const states = uses.map((u) => toolState(ctx, u.id));
  const anyRunning = states.includes("running");
  const errors = states.filter((s) => s === "error").length;
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (uses.length === 1) return <ToolRow use={uses[0]} state={states[0]} />;

  const expanded = open || anyRunning;
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setOpen(!expanded)}
        className="group -mx-2 flex h-7 max-w-full items-center gap-2 rounded-sm px-2 text-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg-2"
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          aria-hidden
          className={cn("shrink-0 transition-transform duration-150", expanded && "rotate-90")}
        />
        <span className={cn("truncate", anyRunning && "shimmer-text")}>{summarize(uses)}</span>
        {errors > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-err">
            <AlertCircle size={12} aria-hidden />
            {errors} failed
          </span>
        )}
      </button>
      {expanded && (
        <div id={panelId} className="mt-0.5 ml-[5px] border-l border-line pl-3">
          {uses.map((u, i) => (
            <ToolRow key={u.id} use={u} state={states[i]} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ use, state }: { use: ToolUse; state: ToolState }) {
  const ctx = useTranscript();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const meta = toolMeta(use.name, use.input);
  const Icon = meta.icon;
  const result = ctx.results.get(use.id);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="group -mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors hover:bg-hover"
      >
        <Icon
          size={13}
          strokeWidth={1.75}
          aria-hidden
          className={cn("shrink-0", state === "error" ? "text-err" : "text-fg-3")}
        />
        <span className={cn("shrink-0", state === "running" ? "shimmer-text" : "text-fg-2")}>{meta.verb}</span>
        {meta.arg && <span className="min-w-0 truncate font-mono text-xs text-fg-3">{meta.arg}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs">
          {state === "error" && <span className="text-err">Failed</span>}
          {state === "interrupted" && <span className="text-fg-3">No result</span>}
          <ChevronRight
            size={12}
            aria-hidden
            className={cn(
              "text-fg-3 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        </span>
      </button>
      {open && (
        <div id={panelId} className="mt-1 mb-2 overflow-hidden rounded-md border border-line bg-code-bg text-xs">
          <ToolSection label="Input" body={formatInput(use)} />
          {result && <ToolSection label={result.is_error ? "Error" : "Result"} body={result.content} error={result.is_error} />}
        </div>
      )}
    </div>
  );
}

function ToolSection({ label, body, error }: { label: string; body: string; error?: boolean }) {
  return (
    <div className="border-line not-first:border-t">
      <div className={cn("px-3 pt-2 text-2xs font-medium tracking-[0.04em] uppercase", error ? "text-err" : "text-fg-3")}>
        {label}
      </div>
      <pre className="max-h-64 overflow-auto px-3 pt-1 pb-2.5 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-fg-2">
        {body || "(empty)"}
      </pre>
    </div>
  );
}

function formatInput(use: ToolUse): string {
  const input = use.input as Record<string, unknown> | null;
  if (use.name === "bash" && input && typeof input.command === "string") return input.command;
  return JSON.stringify(use.input, null, 2);
}
