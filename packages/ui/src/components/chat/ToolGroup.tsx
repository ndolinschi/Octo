import { ChevronRight } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { resolveFolder } from "../../lib/files";
import { useOptionalCode } from "../../state/code";
import { useHost } from "../../state/host";
import { acpCall, locateInProject, toolMeta, toolPath } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { RunningDot } from "../primitives/Status";
import { toolState, useTranscript, type ToolState } from "./transcriptContext";

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
const isCodeLike = (text: string) => !/\s/.test(text.trim()) || /[/\\]/.test(text.split(" ")[0]);

function Arg({ use, text, className }: { use: ToolUse; text: string; className?: string }) {
  // An ACP "execute" title is a command line: mono, like the built-in bash row.
  const prose = acpCall(use.name, use.input) !== null && use.name !== "execute" && !isCodeLike(text);
  return <span className={cn("min-w-0 truncate", prose ? "font-sans text-sm" : "font-mono text-xs", className)}>{text}</span>;
}

function Summary({ uses }: { uses: ToolUse[] }) {
  if (uses.length !== 1) return <span className="truncate">{summarize(uses)}</span>;
  const meta = toolMeta(uses[0].name, uses[0].input);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{meta.verb}</span>
      {meta.arg && <Arg use={uses[0]} text={meta.arg} />}
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
    if (key === "other") return `called ${n} tool${n === 1 ? "" : "s"}`;
    const [verb, noun] = key.startsWith("acp:") ? ACP_PHRASES[key.slice(4)] : PHRASES[key];
    return `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`;
  });
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One muted line per run of tool calls; collapsed by default. */
export function ToolGroup({ uses }: { uses: ToolUse[] }) {
  const ctx = useTranscript();
  const states = uses.map((u) => toolState(ctx, u.id));
  const running = states.includes("running");
  const errors = states.filter((s) => s === "error").length;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const single = uses.length === 1;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="press-row group -mx-2 flex h-row max-w-[calc(100%+16px)] items-center gap-2 rounded-sm px-2 text-sm text-fg-3 hover:bg-hover hover:text-fg-2"
      >
        <Summary uses={uses} />
        {running && <RunningDot />}
        {errors > 0 && <span className="shrink-0 text-err">{single ? "failed" : `${errors} failed`}</span>}
        <Glyph icon={ChevronRight} size={14}
          className={cn("shrink-0 transition-[rotate] duration-150", open && "rotate-90")}/>
      </button>
      {open && (
        <div id={panelId} className="mt-1">
          {single ? <ToolDetail use={uses[0]} /> : uses.map((u, i) => <ToolRow key={u.id} use={u} state={states[i]} />)}
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
        className="press-row -mx-2 flex h-row w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-sm px-2 text-left font-mono text-xs hover:bg-hover"
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

function ToolDetail({ use }: { use: ToolUse }) {
  const ctx = useTranscript();
  const result = ctx.results.get(use.id);
  return (
    <div className="overflow-hidden rounded-md bg-code-bg text-xs">
      <ToolSection label="Input" body={formatInput(use)} action={acpCall(use.name, use.input) ? <AcpLocations use={use} /> : <PathLink use={use} />} />
      {result && <ToolSection label={result.is_error ? "Error" : "Result"} body={result.content} error={result.is_error} />}
    </div>
  );
}

/**
 * The path of a file tool call as a link: an embedding host's `openFile` wins; otherwise it
 * opens the file (or, for list_dir, reveals the folder) in the Files tab. Only shown when
 * there is somewhere to open it.
 */
function PathLink({ use }: { use: ToolUse }) {
  const { openFile } = useHost();
  const code = useOptionalCode();
  const path = toolPath(use.name, use.input);
  const folder = toolMeta(use.name, use.input).folder;
  if (!path) return null;
  const target = code ? resolveFolder(code.folders, folder || undefined) : null;
  if (!openFile && !target) return null;
  const dir = use.name === "list_dir";
  const open = () => {
    if (openFile) return openFile(path, folder || undefined);
    if (!code || !target) return;
    if (dir) code.revealDir(target, path);
    else code.openFile(target, path);
  };
  return (
    <button
      type="button"
      aria-label={dir && !openFile ? `Show ${path} in files` : `Open ${path} in editor`}
      title={target ? `${target}/${path.replace(/^\.\/?/, "")}` : path}
      onClick={open}
      className="min-w-0 truncate rounded-sm font-mono text-fg-2 underline-offset-2 hover:text-fg hover:underline focus-visible:underline"
    >
      {path}
    </button>
  );
}

/** An ACP call's file locations (absolute paths) as links into the project's files, with the line when given. */
function AcpLocations({ use }: { use: ToolUse }) {
  const { openFile } = useHost();
  const code = useOptionalCode();
  const acp = acpCall(use.name, use.input);
  if (!acp?.locations.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
      {acp.locations.map((l, i) => {
        const hit = code ? locateInProject(code.folders, l.path) : null;
        const label = hit ? `${hit.folder}/${hit.path}${l.line ? `:${l.line}` : ""}` : l.path;
        if (!openFile && !hit) return <span key={i} className="min-w-0 truncate font-mono text-fg-3">{label}</span>;
        return (
          <button
            key={i}
            type="button"
            aria-label={`Open ${label} in editor`}
            title={l.path}
            onClick={() => (openFile ? openFile(l.path) : hit && code?.openFile(hit.folder, hit.path, l.line ? { line: l.line } : undefined))}
            className="min-w-0 truncate rounded-sm font-mono text-fg-2 underline-offset-2 hover:text-fg hover:underline focus-visible:underline"
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}

function ToolSection({ label, body, error, action }: { label: string; body: string; error?: boolean; action?: ReactNode }) {
  return (
    <div className="border-line not-first:border-t">
      <div className={cn("flex items-baseline gap-2 px-3 pt-3", error ? "text-err" : "text-fg-3")}>
        {label}
        {action}
      </div>
      <pre className="max-h-64 overflow-auto px-3 pt-1 pb-3 font-mono text-xs leading-5 whitespace-pre-wrap text-fg-2">
        {body || "(empty)"}
      </pre>
    </div>
  );
}

function formatInput(use: ToolUse): string {
  const input = use.input as Record<string, unknown> | null;
  // ACP: the title is the row; what the agent passed is `raw_input`.
  if (acpCall(use.name, use.input)) return input?.raw_input === undefined ? use.name : JSON.stringify(input.raw_input, null, 2);
  if (use.name === "bash" && input && typeof input.command === "string") return input.command;
  return JSON.stringify(use.input, null, 2);
}
