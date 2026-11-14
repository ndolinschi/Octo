import { useEffect, useMemo, useState } from "react";
import { cn } from "../../../lib/cn";
import { locateInProject } from "../../../lib/toolsMore";
import { firstChangedLine, placeRows, turnIdAt, type EditView } from "../../../lib/toolView";
import { useApp } from "../../../state/app";
import { useOptionalCode } from "../../../state/code";
import { useProject } from "../../../state/project";
import { Button } from "../../primitives/Button";
import { DiffPreview } from "./DiffPreview";
import { Counts, FRAME, INSET, TextAction, useOpenAt, useOpenChanges, useShownPath } from "./parts";

/**
 * retest3 G1/G2: an edit as a compact inline diff — the file, "+N −M", the first changed lines with +/− gutters and the file's line
 * numbers, "Show all" in place, "Open diff" (the Changes tab on this turn and file) and "Go to line". A snippet edit (old → new
 * string) finds where it sits in the file once, when it is opened.
 */
export function EditBody({ view, start, failed }: { view: EditView; start: string | null; failed: string | null }) {
  const open = useOpenAt();
  const openChanges = useOpenChanges();
  const { project, state } = useProject();
  const code = useOptionalCode();
  const shown = useShownPath(view.path, view.folder);
  const at = useSnippetLine(view);
  const rows = useMemo(() => (view.placed ? view.rows : at !== null ? placeRows(view.rows, at) : view.rows), [view, at]);
  const numbered = view.placed || at !== null;
  const line = numbered ? firstChangedLine(rows) : null;
  const orchestrator = project?.orchestrator_agent_id ? state.messages[project.orchestrator_agent_id] : undefined;
  const turnId = orchestrator ? turnIdAt(orchestrator, start) : null;
  const file = useMemo(() => {
    const abs = view.path.startsWith("/") ? (code ? locateInProject(code.folders, view.path) : null) : null;
    if (abs) return abs;
    const folder = view.folder || code?.folders[0]?.label || "";
    return folder ? { folder, path: view.path.replace(/^\.\//, "") } : null;
  }, [view, code]);
  const goto = open ? (n: number) => open(view.path, view.folder, { line: n }) : undefined;
  return (
    <div data-tool-body="edit" className={FRAME}>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", INSET)}>
        {open ? (
          <Button
            variant="link"
            tone="quiet"
            mono
            size="xs"
            className="min-w-0 shrink truncate"
            title={`Open ${shown}${line ? ` at line ${line}` : ""}`}
            onClick={() => open(view.path, view.folder, line ? { line } : undefined)}
          >
            <span className="truncate">{shown}</span>
          </Button>
        ) : (
          <span className="min-w-0 truncate font-mono text-fg-2">{shown}</span>
        )}
        <Counts added={view.added} removed={view.removed} />
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {openChanges && turnId !== null && file && !failed && <TextAction onClick={() => openChanges(turnId, file)}>Open diff</TextAction>}
          {goto && line !== null && <TextAction onClick={() => goto(line)}>Go to line {line}</TextAction>}
        </span>
      </div>
      {failed && <p className="px-3 pb-2 text-err">Not applied: {failed}</p>}
      <div className="border-t border-line py-1">
        <DiffPreview rows={rows} numbered={numbered} onLine={goto} label={`Changes to ${shown}`} />
      </div>
    </div>
  );
}

/** Where a snippet edit sits in its file now: the file is read once (on open), the snippet's first changed line looked up. */
function useSnippetLine(view: EditView): number | null {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const code = useOptionalCode();
  const [found, setFound] = useState<{ key: string; line: number | null } | null>(null);
  const key = `${view.folder}\u0001${view.path}\u0001${view.needle}`;
  const target = useMemo(() => {
    if (view.placed || !view.needle.trim()) return null;
    if (view.path.startsWith("/")) return code ? locateInProject(code.folders, view.path) : null;
    const folder = view.folder || code?.folders[0]?.label;
    return folder ? { folder, path: view.path.replace(/^\.\//, "") } : null;
  }, [view, code]);
  useEffect(() => {
    if (!target) return;
    let alive = true;
    bridge.readFile(projectId, target.folder, target.path).then(
      (fc) => {
        if (!alive) return;
        const at = fc.content.split("\n").findIndex((l) => l === view.needle);
        // The snippet's changed row is `index` rows into it: its first row sits that many lines above.
        const index = view.rows.findIndex((r) => r.text === view.needle && r.kind !== "del");
        const row = index >= 0 ? view.rows[index]?.new : null;
        setFound({ key, line: at >= 0 && row ? at + 1 - (row - 1) : null });
      },
      // Unreadable (gone, moved): the diff shows without line numbers.
      () => alive && setFound({ key, line: null }),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, target, view, key]);
  return found?.key === key ? found.line : null;
}
