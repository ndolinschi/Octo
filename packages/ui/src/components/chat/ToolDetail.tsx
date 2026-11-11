import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { resolveFolder } from "../../lib/files";
import { structured } from "../../lib/table";
import { acpCall, locateInProject, looksLikeDiff, toolMeta, toolPath } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { useOptionalCode } from "../../state/code";
import { useHost } from "../../state/host";
import { HighlightedCode } from "../shared/Markdown";
import { useTranscript } from "./transcriptContext";

/** Tabular tool results load the table component with the first one (its own chunk). */
const DataTable = lazy(() => import("../shared/DataTable").then((m) => ({ default: m.DataTable })));
const Pairs = lazy(() => import("../shared/DataTable").then((m) => ({ default: m.Pairs })));

/** The opened tool call: its input (with a link to the file it names) and its result — a table when tabular (decision 44). */
export function ToolDetail({ use }: { use: ToolUse }) {
  const ctx = useTranscript();
  const result = ctx.results.get(use.id);
  return (
    <div className="overflow-hidden rounded-md bg-code-bg text-xs">
      <ToolSection label="Input" body={formatInput(use)} action={acpCall(use.name, use.input) ? <AcpLocations use={use} /> : <PathLink use={use} />} />
      {result && <ToolSection label={result.is_error ? "Error" : "Result"} body={result.content} error={result.is_error} structured={!result.is_error} />}
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
        if (!openFile && !hit)
          return (
            <span key={i} className="min-w-0 truncate font-mono text-fg-3">
              {label}
            </span>
          );
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

function ToolSection({
  label,
  body,
  error,
  action,
  structured: tryTable = false,
}: {
  label: string;
  body: string;
  error?: boolean;
  action?: ReactNode;
  structured?: boolean;
}) {
  // Decision 44: a tabular result (CSV, JSON rows) is a table and a short key–value result a list; "Raw" shows the text.
  const shape = useMemo(() => (tryTable ? structured(body) : null), [tryTable, body]);
  const [raw, setRaw] = useState(false);
  return (
    <div className="border-line not-first:border-t">
      <div className={cn("flex items-baseline gap-2 px-3 pt-3", error ? "text-err" : "text-fg-3")}>
        {label}
        {action}
        {shape && (
          <button
            type="button"
            aria-pressed={raw}
            onClick={() => setRaw((x) => !x)}
            className="-my-1 ml-auto h-chip rounded-sm px-1.5 hover:bg-hover hover:text-fg"
          >
            {raw ? "Table" : "Raw"}
          </button>
        )}
      </div>
      {shape && !raw ? (
        <div data-tool-table className="max-h-96 overflow-y-auto px-3 pt-1 pb-1">
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
      ) : (
        <pre className="max-h-64 overflow-auto px-3 pt-1 pb-3 font-mono text-xs leading-5 whitespace-pre-wrap text-fg-2">
          {/* A diff (an ACP edit's result, a patch) gets the chat's diff colours. */}
          {body ? <HighlightedCode code={body} lang={looksLikeDiff(body) ? "diff" : undefined} /> : "(empty)"}
        </pre>
      )}
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
