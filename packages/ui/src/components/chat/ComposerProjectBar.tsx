import type { Project, ProjectSummary } from "@octo/agent-client";
import { FolderGit2, GitBranch } from "lucide-react";
import { lazy, memo, Suspense, useRef } from "react";
import { branchLabel, branchTitle } from "../../lib/branches";
import { Chip } from "../primitives/Chip";
import { Glyph } from "../primitives/Glyph";
import { Presence } from "../primitives/Presence";
import { Segmented } from "../primitives/Segmented";
import { WORKSPACE_MODES, type WorkspaceMode } from "./projectBarState";
import { useComposerProjectBar } from "./useComposerProjectBar";
import type { ComposerDraft } from "./useComposerText";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));
const BranchPicker = lazy(() => import("./BranchPicker").then((m) => ({ default: m.BranchPicker })));
const MoveToWorktreeDialog = lazy(() => import("../shared/MoveToWorktreeDialog").then((m) => ({ default: m.MoveToWorktreeDialog })));
const ProjectSelectorPopover = lazy(() => import("./ProjectSelectorPopover").then((m) => ({ default: m.ProjectSelectorPopover })));

/**
 * Inline project and workspace/worktree bar attached above `.octo-composer` inside `.octo-composer-shell` on empty
 * sessions. Groups project + active branch/worktree on the left and anchors the compact `Regular | Worktree` toggle on
 * the right so controls align with the composer row beneath and never shift as project or branch names change.
 */
export const ComposerProjectBar = memo(function ComposerProjectBar(props: {
  project: Project;
  projects: readonly ProjectSummary[];
  draft: ComposerDraft | undefined;
  onOverlay?: ((open: boolean) => void) | undefined;
}) {
  const projectBtn = useRef<HTMLButtonElement>(null);
  const wsBtn = useRef<HTMLButtonElement>(null);
  const bar = useComposerProjectBar(props);
  const hasRef = bar.worktreeLabel !== null || Boolean(bar.repo) || (!bar.hasBranchesApi && bar.canMove);

  return (
    <>
      <div data-composer-project-bar className="flex min-h-ctl-md min-w-0 items-center gap-2 px-1.5 py-1 phone:min-h-ctl-lg phone:flex-wrap">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <Chip
            ref={projectBtn}
            size="xs"
            data-project-selector
            aria-haspopup="dialog"
            icon={FolderGit2}
            name="Project"
            label={props.project.name}
            tip={`Switch project (${props.project.name})`}
            cut="end"
            open={bar.projectPickerOpen}
            disabled={bar.switching}
            onClick={() => bar.setProjectPickerOpen((v) => !v)}
            className="shrink"
          />
          {hasRef && <span aria-hidden className="h-3 w-px shrink-0 bg-line" />}
          {bar.worktreeLabel !== null ? (
            <span
              data-workspace-label
              title={bar.repo ? branchTitle(bar.repo, "worktree") : `${bar.worktreeLabel} — worktree`}
              className="flex h-ctl-xs min-w-0 items-center gap-1.5 px-2 text-xs text-fg-3"
            >
              <Glyph icon={GitBranch} size={14} className="shrink-0" />
              <span className="min-w-0 truncate">{bar.worktreeLabel}</span>
            </span>
          ) : bar.repo ? (
            <Chip
              ref={wsBtn}
              size="xs"
              data-branch-selector
              aria-haspopup="dialog"
              icon={GitBranch}
              name="Branch"
              label={branchLabel(bar.repo)}
              tip={branchTitle(bar.repo, "shared")}
              open={bar.branchPicker}
              disabled={bar.switching}
              onClick={() => {
                if (!bar.branchPicker) bar.branchHead.refresh();
                bar.setBranchPicker((v) => !v);
              }}
              className="shrink"
            />
          ) : (
            !bar.hasBranchesApi &&
            bar.canMove && (
              <Chip
                ref={wsBtn}
                size="xs"
                data-workspace-selector
                aria-haspopup="menu"
                icon={GitBranch}
                name="Workspace"
                label="Main checkout"
                tip="Main checkout — move session to a git worktree"
                cut="end"
                open={bar.wsMenu !== null}
                disabled={bar.switching}
                onClick={() => {
                  if (bar.wsMenu) {
                    bar.setWsMenu(null);
                    return;
                  }
                  const r = wsBtn.current?.getBoundingClientRect();
                  bar.setWsMenu(r ? { x: r.left, y: r.bottom + 4 } : null);
                }}
                className="shrink"
              />
            )
          )}
        </div>
        {bar.canToggleWorkspace && (
          <Segmented<WorkspaceMode>
            size="xs"
            label="Workspace mode"
            options={WORKSPACE_MODES}
            value={bar.workspaceMode}
            disabled={bar.switching}
            onChange={(m) => void bar.switchWorkspaceMode(m)}
          />
        )}
      </div>
      {bar.actionError && (
        <p role="alert" className="px-2 pb-1 text-xs text-err">
          {bar.actionError}
        </p>
      )}
      <Presence show={bar.projectPickerOpen} exitMs={0}>
        {bar.projectPickerOpen && (
          <Suspense fallback={null}>
            <ProjectSelectorPopover
              anchor={projectBtn}
              projects={bar.orderedProjects}
              currentId={props.project.id}
              disabled={bar.switching}
              onSelect={(id) => void bar.switchProject(id)}
              onOpenSettings={bar.openProjectSettings}
              onClose={() => bar.setProjectPickerOpen(false)}
            />
          </Suspense>
        )}
      </Presence>
      <Presence show={bar.wsMenu !== null}>
        {bar.wsMenu && (
          <Suspense fallback={null}>
            <Menu
              label="Workspace"
              x={bar.wsMenu.x}
              y={bar.wsMenu.y}
              ignoreRef={wsBtn}
              onClose={() => bar.setWsMenu(null)}
              items={[
                { id: "shared", label: "Main checkout", checked: true, run: () => undefined },
                { id: "worktree", label: "Move to worktree…", icon: GitBranch, run: () => bar.setMovingWorktree(true) },
              ]}
            />
          </Suspense>
        )}
      </Presence>
      <Presence show={bar.branchPicker} exitMs={0}>
        {bar.branchPicker && (
          <Suspense fallback={null}>
            <BranchPicker
              anchor={wsBtn}
              projectId={props.project.id}
              canWorktree
              onClose={() => bar.setBranchPicker(false)}
              onSwitched={bar.branchHead.set}
              onWorktree={bar.startWorktree}
              onMoveToWorktree={bar.canMove ? () => bar.setMovingWorktree(true) : undefined}
            />
          </Suspense>
        )}
      </Presence>
      <Suspense fallback={null}>
        {bar.movingWorktree && bar.activeSession && (
          <MoveToWorktreeDialog
            projectId={props.project.id}
            session={bar.activeSession}
            onClose={() => bar.setMovingWorktree(false)}
            onMoved={bar.onMovedToWorktree}
          />
        )}
      </Suspense>
    </>
  );
});
