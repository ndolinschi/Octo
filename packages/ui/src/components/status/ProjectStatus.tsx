import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { budgetState } from "../../lib/models";
import { changedFileCount, changedText } from "../../lib/statusBar";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useStatusSlots } from "../../state/statusSlots";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { STATUS_ITEM } from "./StatusItem";

/**
 * What the open project puts in the status bar (decision 73), portalled into the shell's row: its folder (opens Files), the
 * number of files its agents changed (opens Changes; shown only when there are some) and "$spent / $budget" when it has a
 * budget (opens Usage; amber from 80%, red at 100%). The branch is not in the project's data (only the folder picker reads
 * `.git/HEAD`), so the folder's name stands in.
 */
export function ProjectStatus() {
  const slots = useStatusSlots();
  if (!slots.start || !slots.end) return null;
  return (
    <>
      {createPortal(<Start />, slots.start)}
      {createPortal(<End />, slots.end)}
    </>
  );
}

function useChangedFiles(): number {
  const { bridge } = useApp();
  const { projectId, onEvent } = useProject();
  const [count, setCount] = useState(0);
  const [recorded, setRecorded] = useState(0);
  useEffect(() => onEvent((e) => (e.type === "change.recorded" ? setRecorded((n) => n + 1) : undefined)), [onEvent]);
  useEffect(() => {
    let alive = true;
    // A harness without recorded changes (or a failed read) shows no count: the Changes tab itself says why.
    bridge.listChanges?.(projectId).then(
      (turns) => alive && setCount(changedFileCount(turns)),
      () => alive && setCount(0),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, recorded]);
  return count;
}

function Start() {
  const { project } = useProject();
  const ws = useOptionalWorkspace();
  const changed = useChangedFiles();
  if (!project) return null;
  const first = project.folders[0];
  const more = project.folders.length - 1;
  return (
    <>
      {first && (
        <button
          type="button"
          className={cn(STATUS_ITEM, "min-w-0 shrink")}
          title={`${first.path}\nOpen the project's files`}
          onClick={() => ws?.openTool("files")}
        >
          <Glyph icon={GLYPH.files} size={14} />
          <span className="truncate">{first.label}</span>
          {more > 0 && <span className="tabular-nums">+{more}</span>}
        </button>
      )}
      {changed > 0 && (
        <button type="button" className={STATUS_ITEM} title="What the agents changed. Open Changes." onClick={() => ws?.openTool("changes")}>
          <Glyph icon={GLYPH.changes} size={14} />
          {changedText(changed)}
        </button>
      )}
    </>
  );
}

function End() {
  const { project } = useProject();
  const ws = useOptionalWorkspace();
  const budget = project ? budgetState(project.spent_usd, project.budget_usd) : null;
  if (!budget) return null;
  return (
    <button
      type="button"
      data-budget
      className={cn(STATUS_ITEM, "tabular-nums", budget.tone === "err" && "text-err", budget.tone === "warn" && "text-warn")}
      title={`${budget.reached ? "Project budget reached. Raise it in project settings to continue. " : ""}Spent ${budget.text} of the project's budget. Open Usage.`}
      onClick={() => ws?.openTool("usage")}
    >
      <span className="sr-only">Budget: </span>
      {budget.reached ? "Budget reached" : budget.text}
    </button>
  );
}
