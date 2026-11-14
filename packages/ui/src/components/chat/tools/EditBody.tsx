import { useEffect, useMemo, useState } from "react";
import { locateInProject } from "../../../lib/toolsMore";
import { firstChangedLine, placeRows, turnIdAt, type EditView } from "../../../lib/toolView";
import { useApp } from "../../../state/app";
import { useOptionalCode } from "../../../state/code";
import { useProject } from "../../../state/project";
import { DiffPreview, diffMore } from "./DiffPreview";
import { BodyFrame, Disclosure, TextAction, useOpenAt, useOpenChanges, useShownPath, type RawCall } from "./parts";

/**
 * retest3 G1/G2 (toolpolish): an edit (or a run of edits of one file) as its inline diff — no header of its own (the row above
 * says the file and +N −M once), the diff directly under it, then one action line: "Show all" on the left, "Open diff", "Go to
 * line N" and "Raw" on the right. A snippet edit (old → new string) finds where it sits in the file once, when it is opened.
 */
export function EditBody({ views, start, failed, raw }: { views: readonly EditView[]; start: string | null; failed: string | null; raw: RawCall }) {
  const open = useOpenAt();
  const openChanges = useOpenChanges();
  const { project, state } = useProject();
  const code = useOptionalCode();
  const [first] = views;
  const shown = useShownPath(first?.path ?? "", first?.folder ?? "");
  const lines = useSnippetLines(views);
  const [all, setAll] = useState(false);
  const sections = useMemo(
    () =>
      views
        .map((v, i) => {
          const at = lines[i] ?? null;
          return { rows: v.placed ? v.rows : at !== null ? placeRows(v.rows, at) : v.rows, numbered: v.placed || at !== null };
        })
        // Placed sections read top to bottom in the file.
        .sort((a, b) => (a.numbered && b.numbered ? (a.rows[0]?.new ?? a.rows[0]?.old ?? 0) - (b.rows[0]?.new ?? b.rows[0]?.old ?? 0) : 0)),
    [views, lines],
  );
  const numbered = sections.every((s) => s.numbered);
  const rows = useMemo(() => sections.map((s) => s.rows), [sections]);
  const line = numbered ? (rows.map((r) => firstChangedLine(r)).find((n) => n !== null) ?? null) : null;
  const more = useMemo(() => diffMore(rows), [rows]);
  const orchestrator = project?.orchestrator_agent_id ? state.messages[project.orchestrator_agent_id] : undefined;
  const turnId = orchestrator ? turnIdAt(orchestrator, start) : null;
  const file = useMemo(() => {
    if (!first) return null;
    const abs = first.path.startsWith("/") ? (code ? locateInProject(code.folders, first.path) : null) : null;
    if (abs) return abs;
    const folder = first.folder || code?.folders[0]?.label || "";
    return folder ? { folder, path: first.path.replace(/^\.\//, "") } : null;
  }, [first, code]);
  if (!first) return null;
  const goto = open ? (n: number) => open(first.path, first.folder, { line: n }) : undefined;
  return (
    <BodyFrame
      kind="edit"
      raw={raw}
      lead={
        more.more && (
          <Disclosure open={all} onToggle={() => setAll((x) => !x)}>
            {all ? "Show less" : more.rest > 0 ? `Show all (${more.rest} more changed line${more.rest === 1 ? "" : "s"})` : "Show all"}
          </Disclosure>
        )
      }
      actions={
        <>
          {openChanges && turnId !== null && file && !failed && <TextAction onClick={() => openChanges(turnId, file)}>Open diff</TextAction>}
          {goto && line !== null && <TextAction onClick={() => goto(line)}>Go to line {line}</TextAction>}
        </>
      }
    >
      {failed && <p className="px-3 pt-2 text-err">Not applied: {failed}</p>}
      <DiffPreview sections={rows} numbered={numbered} all={all} onLine={goto} label={`Changes to ${shown}`} />
    </BodyFrame>
  );
}

/** Where each snippet edit sits in its file now: the file is read once (on open), each snippet's first changed line looked up. */
function useSnippetLines(views: readonly EditView[]): readonly (number | null)[] {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const code = useOptionalCode();
  const [found, setFound] = useState<{ key: string; lines: (number | null)[] } | null>(null);
  const [first] = views;
  const key = views.map((v) => `${v.folder}\u0001${v.path}\u0001${v.needle}`).join("\u0002");
  const none = useMemo(() => views.map(() => null), [views]);
  const target = useMemo(() => {
    if (!first || views.every((v) => v.placed || !v.needle.trim())) return null;
    if (first.path.startsWith("/")) return code ? locateInProject(code.folders, first.path) : null;
    const folder = first.folder || code?.folders[0]?.label;
    return folder ? { folder, path: first.path.replace(/^\.\//, "") } : null;
  }, [first, views, code]);
  useEffect(() => {
    if (!target) return;
    let alive = true;
    bridge.readFile(projectId, target.folder, target.path).then(
      (fc) => {
        if (!alive) return;
        const text = fc.content.split("\n");
        const lines = views.map((view) => {
          if (view.placed || !view.needle.trim()) return null;
          const at = text.findIndex((l) => l === view.needle);
          // The snippet's changed row is `index` rows into it: its first row sits that many lines above.
          const index = view.rows.findIndex((r) => r.text === view.needle && r.kind !== "del");
          const row = index >= 0 ? view.rows[index]?.new : null;
          return at >= 0 && row ? at + 1 - (row - 1) : null;
        });
        setFound({ key, lines });
      },
      // Unreadable (gone, moved): the diff shows without line numbers.
      () => alive && setFound({ key, lines: views.map(() => null) }),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, target, views, key]);
  return found?.key === key ? found.lines : none;
}
