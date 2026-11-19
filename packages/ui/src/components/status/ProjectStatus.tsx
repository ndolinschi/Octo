import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { budgetState } from "../../lib/modelsMore";
import { modelName } from "../../lib/models";
import { settingsHref } from "../../lib/route";
import { topModelLines } from "../../lib/usage/modelLines";
import { changedFileCount, changedText } from "../../lib/statusBar";
import { runningRuns, runningText } from "../../lib/projectRuns";
import { useRunsSelector } from "../../state/projectRuns";
import { StateGlyph } from "../primitives/StateGlyph";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useStatusSlots } from "../../state/statusSlots";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";
import { MiddleText } from "../primitives/MiddleText";
import { GLYPH } from "../primitives/glyphs";
import { StatusButton } from "./StatusButton";

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
  const { folders } = project;
  const first = folders[0];
  return (
    <>
      {first && (!ws || ws.toolEnabled("files")) && (
        // One folder: its name, cut in the middle so its end stays. Several: how many ("2 folders"); a first name and "+1"
        // read as that folder alone, and the project's own name is the heading, the chip and the tab already. The tooltip
        // names each folder with its path.
        <StatusButton
          className="max-w-48 min-w-0 shrink"
          title={`${folders.map((f) => (folders.length > 1 ? `${f.label}: ${f.path}` : f.path)).join("\n")}\nOpen the project's files`}
          onClick={() => ws?.openTool("files")}
        >
          <Glyph icon={GLYPH.files} size={14} />
          {folders.length > 1 ? <span className="tabular-nums">{folders.length} folders</span> : <MiddleText text={first.label} />}
        </StatusButton>
      )}
      {changed > 0 && (!ws || ws.toolEnabled("changes")) && (
        <StatusButton title="What the agents changed. Open Changes." onClick={() => ws?.openTool("changes")}>
          <Glyph icon={GLYPH.changes} size={14} />
          {changedText(changed)}
        </StatusButton>
      )}
    </>
  );
}

function End() {
  const { project } = useProject();
  const ws = useOptionalWorkspace();
  const budget = project ? budgetState(project.spent_usd, project.budget_usd) : null;
  const running = useRunsSelector((s) => runningRuns(s).length);
  const text = runningText(running);
  return (
    <>
      {text && (!ws || ws.toolEnabled("processes")) && (
        <StatusButton data-running-commands title="Project processes are running. Open Processes." onClick={() => ws?.openTool("processes")}>
          <StateGlyph state="working" />
          {text}
        </StatusButton>
      )}
      {budget && <Budget budget={budget} spent={project?.spent_usd ?? null} />}
    </>
  );
}

function Budget({ budget, spent }: { budget: NonNullable<ReturnType<typeof budgetState>>; spent: number | null }) {
  const ws = useOptionalWorkspace();
  const { bridge } = useApp();
  const { projectId } = useProject();
  // Decision 86 d: the tooltip adds the project's top models by tokens, read on the first hover or focus (and again once the spend changed).
  const [lines, setLines] = useState<string[]>([]);
  const readAt = useRef<{ projectId: string; spent: number | null } | null>(null);
  const read = useCallback(() => {
    if (readAt.current?.projectId === projectId && readAt.current.spent === spent) return;
    readAt.current = { projectId, spent };
    bridge.getUsage({ group: "model", project: projectId }).then(
      (report) => setLines(topModelLines(report.buckets, (id) => modelName(id))),
      () => {
        readAt.current = null;
      },
    );
  }, [bridge, projectId, spent]);
  const usageEnabled = Boolean(ws?.toolEnabled("usage"));
  const actionText = usageEnabled ? "Open Usage." : "Open Usage settings.";
  const base = `${budget.reached ? "Project budget reached. Raise it in project settings to continue. " : ""}Spent ${budget.text} of the project's budget. ${actionText}`;
  return (
    <StatusButton
      data-budget
      className="tabular-nums"
      {...(budget.tone === "err" || budget.tone === "warn" ? { warning: budget.tone } : {})}
      // B40: one line each (the tooltip layer breaks on "\n"): the sentence, then the top models under a caption.
      title={lines.length ? `${base}\nMost tokens:\n${lines.join("\n")}` : base}
      onMouseEnter={read}
      onFocus={read}
      onClick={() => {
        if (usageEnabled) ws?.openTool("usage");
        else window.location.hash = settingsHref("usage");
      }}
    >
      <span className="sr-only">Budget: </span>
      {budget.reached ? "Budget reached" : budget.text}
    </StatusButton>
  );
}
