import type { Project, ProjectSession, ProjectSummary } from "@octo/agent-client";
import { FolderGit2, GitBranch } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { focusSoon, visibleComposer } from "../../lib/focus";
import { navigate } from "../../lib/route";
import { branchLabel, branchTitle } from "../../lib/branches";
import { canMoveToWorktree, isDefaultSession, sessionWorkspaceLabel } from "../../lib/sessions/current";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { sessionTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Chip } from "../primitives/Chip";
import { Glyph } from "../primitives/Glyph";
import { Presence } from "../primitives/Presence";
import { Segmented } from "../primitives/Segmented";
import { clearDraft, stashCrossProjectDraft } from "./composerDraft";
import type { ComposerDraft } from "./useComposerText";
import { useBranchHead } from "./useBranchHead";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));
const BranchPicker = lazy(() => import("./BranchPicker").then((m) => ({ default: m.BranchPicker })));
const MoveToWorktreeDialog = lazy(() => import("../shared/MoveToWorktreeDialog").then((m) => ({ default: m.MoveToWorktreeDialog })));
const ProjectSelectorPopover = lazy(() => import("./ProjectSelectorPopover").then((m) => ({ default: m.ProjectSelectorPopover })));

const isUnusedEmptyMain = (s: ProjectSession): boolean =>
  s.kind === "main" && !s.archived && s.exchanges === 0 && s.children === 0 && s.state === "idle" && (s.queued ?? 0) === 0;

type WorkspaceMode = "regular" | "worktree";

const WORKSPACE_MODES: readonly { id: WorkspaceMode; label: string; title: string }[] = [
  { id: "regular", label: "Regular", title: "Work directly in the main project checkout" },
  { id: "worktree", label: "Worktree", title: "Work in an isolated git worktree" },
];

/**
 * Agy-style inline project (and workspace/worktree) bar attached above `.octo-composer` inside `.octo-composer-shell`
 * on empty sessions. Allows switching projects in place without a pre-creation modal, carrying over typed text and
 * cleaning up any unused non-default empty session left behind.
 */
export function ComposerProjectBar(props: {
  project: Project;
  projects: readonly ProjectSummary[];
  draft: ComposerDraft | undefined;
  onOverlay?: ((open: boolean) => void) | undefined;
}) {
  const { bridge } = useApp();
  const activity = useActivity();
  const { state, applySession } = useProject();
  const scope = useSessionScope();
  const ws = useOptionalWorkspace();

  const projectBtn = useRef<HTMLButtonElement>(null);
  const wsBtn = useRef<HTMLButtonElement>(null);
  const switchingRef = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number } | null>(null);
  const [movingWorktree, setMovingWorktree] = useState(false);
  const [branchPicker, setBranchPicker] = useState(false);

  const activeSessionId = scope?.sessionId ?? ws?.chatSessionId ?? state.sessions.defaultId ?? null;
  const activeSession = scope?.session ?? (activeSessionId ? state.sessions.list.find((s) => s.id === activeSessionId) : undefined);

  const onOverlay = props.onOverlay;
  const overlay = projectPickerOpen || wsMenu !== null || movingWorktree || branchPicker;
  useEffect(() => onOverlay?.(overlay), [overlay, onOverlay]);
  useEffect(() => () => onOverlay?.(false), [onOverlay]);

  const orderedProjects = useMemo(
    () => [...props.projects].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id)),
    [props.projects],
  );

  const handoffToSession = async (targetProjectId: string, targetSessionId: string, focusNewComposer = false) => {
    const draftText = props.draft?.value ?? "";
    const canCleanOld =
      activeSession !== undefined && !isDefaultSession(activeSession) && isUnusedEmptyMain(activeSession) && bridge.deleteSession !== undefined;
    if (props.draft && draftText !== "") clearDraft(props.draft);
    if (canCleanOld && bridge.deleteSession) {
      ws?.dropTab(sessionTab(activeSession.id));
      await bridge.deleteSession(props.project.id, activeSession.id).catch(() => undefined);
    }
    if (draftText !== "") stashCrossProjectDraft(targetProjectId, targetSessionId, draftText);
    activity.refreshSessions();
    const prevComposer = focusNewComposer ? visibleComposer() : null;
    navigate(targetProjectId, null, targetSessionId);
    if (focusNewComposer) {
      focusSoon(
        () => {
          const el = visibleComposer();
          return el && el !== prevComposer ? el : null;
        },
        { timeout: 3000 },
      );
    }
  };

  const switchProject = async (targetId: string) => {
    if (targetId === props.project.id || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      const list = bridge.listSessions ? await bridge.listSessions(targetId, { limit: 200, archived: "all" }).catch(() => null) : null;
      const unusedDefault = list?.find((s) => isDefaultSession(s) && isUnusedEmptyMain(s));
      const unusedAny = list?.find((s) => isUnusedEmptyMain(s));
      let targetSessionId: string | null = (unusedDefault ?? unusedAny)?.id ?? null;
      if (targetSessionId === null) {
        const { session } = await bridge.createSession(targetId, {});
        targetSessionId = session.id;
      }
      await handoffToSession(targetId, targetSessionId, true);
    } catch {
      // Keep the current session and typed draft intact if creating or loading the target session fails.
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  const openProjectSettings = (targetId: string) => {
    if (targetId === props.project.id) {
      ws?.openSettings();
      return;
    }
    void switchProject(targetId);
  };

  const wsLabel = activeSession ? sessionWorkspaceLabel(activeSession) : null;
  const workspaceMode: WorkspaceMode = wsLabel !== null ? "worktree" : "regular";
  const canMove = Boolean(bridge.moveSessionToWorktree && activeSession && canMoveToWorktree(activeSession) && props.project.folders.length > 0);
  const canToggleWorkspace = props.project.folders.length > 0 && (wsLabel !== null || canMove || Boolean(bridge.createSession));
  // Decision 98: the chip shows the branch the session's checkout is on, read from disk (first repository of the project).
  const workspaceId = activeSession?.workspace?.id ?? "shared";
  const branchHead = useBranchHead(props.project.id, workspaceId, props.project.folders.length > 0);
  const repo = branchHead.result?.repos[0];
  const worktreeLabel = wsLabel !== null ? (repo ? branchLabel(repo) : wsLabel) : null;

  // "Start in a worktree from <branch>": the empty session moves into a new worktree (nothing in the main checkout changes);
  // a session that cannot move gets a new session in one.
  const startWorktree = async (branch: string) => {
    if (activeSession && canMove && bridge.moveSessionToWorktree) {
      const res = await bridge.moveSessionToWorktree(props.project.id, activeSession.id, { base_ref: branch, carry_changes: false });
      applySession({ kind: "upsert", session: res.session });
      return;
    }
    const { session } = await bridge.createSession(props.project.id, { workspace: { kind: "worktree", base_ref: branch } });
    activity.refreshSessions();
    navigate(props.project.id, null, session.id);
  };

  const switchWorkspaceMode = async (mode: WorkspaceMode) => {
    if (mode === workspaceMode || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      if (mode === "worktree") {
        if (activeSession && canMove && bridge.moveSessionToWorktree) {
          const res = await bridge.moveSessionToWorktree(props.project.id, activeSession.id, { carry_changes: false });
          applySession({ kind: "upsert", session: res.session });
          branchHead.refresh();
          return;
        }
        const { session } = await bridge.createSession(props.project.id, { workspace: { kind: "worktree" } });
        applySession({ kind: "upsert", session });
        await handoffToSession(props.project.id, session.id);
        return;
      }

      // Worktree -> Regular: switch to an existing unused empty shared session, or create one, carrying over the draft.
      const isUnusedShared = (s: ProjectSession) => isUnusedEmptyMain(s) && s.workspace?.kind !== "worktree";
      const existing = state.sessions.list.find((s) => isDefaultSession(s) && isUnusedShared(s)) ?? state.sessions.list.find(isUnusedShared);
      let targetSessionId: string;
      if (existing) {
        targetSessionId = existing.id;
      } else {
        const { session } = await bridge.createSession(props.project.id, { workspace: { kind: "shared" } });
        applySession({ kind: "upsert", session });
        targetSessionId = session.id;
      }
      await handoffToSession(props.project.id, targetSessionId);
    } catch {
      // Keep current session and draft intact if switching workspace mode fails.
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  return (
    <>
      <div data-composer-project-bar className="flex min-h-ctl-md min-w-0 items-center gap-1 px-1.5 phone:min-h-ctl-lg">
        <Chip
          ref={projectBtn}
          data-project-selector
          aria-haspopup="dialog"
          icon={FolderGit2}
          name="Project"
          label={props.project.name}
          tip={`Switch project (${props.project.name})`}
          cut="end"
          open={projectPickerOpen}
          disabled={switching}
          onClick={() => setProjectPickerOpen((v) => !v)}
        />
        {canToggleWorkspace && (
          <Segmented<WorkspaceMode>
            label="Workspace mode"
            options={WORKSPACE_MODES}
            value={workspaceMode}
            onChange={(m) => void switchWorkspaceMode(m)}
            {...(switching ? { className: "pointer-events-none opacity-60" } : {})}
          />
        )}
        {worktreeLabel !== null ? (
          <span
            data-workspace-label
            title={repo ? branchTitle(repo, "worktree") : `${worktreeLabel} — worktree`}
            className="flex h-ctl-sm min-w-0 items-center gap-1.5 px-2 text-sm text-fg-3"
          >
            <Glyph icon={GitBranch} size={14} className="shrink-0" />
            <span className="min-w-0 truncate">{worktreeLabel}</span>
          </span>
        ) : repo ? (
          <Chip
            ref={wsBtn}
            data-branch-selector
            aria-haspopup="dialog"
            icon={GitBranch}
            name="Branch"
            label={branchLabel(repo)}
            tip={branchTitle(repo, "shared")}
            open={branchPicker}
            disabled={switching}
            className="max-w-[45%]"
            onClick={() => {
              if (!branchPicker) branchHead.refresh();
              setBranchPicker((v) => !v);
            }}
          />
        ) : (
          !bridge.listBranches &&
          canMove && (
            <Chip
              ref={wsBtn}
              data-workspace-selector
              aria-haspopup="menu"
              icon={GitBranch}
              name="Workspace"
              label="Main checkout"
              tip="Main checkout — move session to a git worktree"
              cut="end"
              open={wsMenu !== null}
              disabled={switching}
              className="max-w-[45%]"
              onClick={() => {
                if (wsMenu) {
                  setWsMenu(null);
                  return;
                }
                const r = wsBtn.current?.getBoundingClientRect();
                setWsMenu(r ? { x: r.left, y: r.bottom + 4 } : null);
              }}
            />
          )
        )}
      </div>
      <Presence show={projectPickerOpen} exitMs={0}>
        {projectPickerOpen && (
          <Suspense fallback={null}>
            <ProjectSelectorPopover
              anchor={projectBtn}
              projects={orderedProjects}
              currentId={props.project.id}
              disabled={switching}
              onSelect={(id) => void switchProject(id)}
              onOpenSettings={openProjectSettings}
              onClose={() => setProjectPickerOpen(false)}
            />
          </Suspense>
        )}
      </Presence>
      <Presence show={wsMenu !== null}>
        {wsMenu && (
          <Suspense fallback={null}>
            <Menu
              label="Workspace"
              x={wsMenu.x}
              y={wsMenu.y}
              ignoreRef={wsBtn}
              onClose={() => setWsMenu(null)}
              items={[
                { id: "shared", label: "Main checkout", checked: true, run: () => undefined },
                { id: "worktree", label: "Move to worktree…", icon: GitBranch, run: () => setMovingWorktree(true) },
              ]}
            />
          </Suspense>
        )}
      </Presence>
      <Presence show={branchPicker} exitMs={0}>
        {branchPicker && (
          <Suspense fallback={null}>
            <BranchPicker
              anchor={wsBtn}
              projectId={props.project.id}
              canWorktree
              onClose={() => setBranchPicker(false)}
              onSwitched={branchHead.set}
              onWorktree={startWorktree}
              onMoveToWorktree={canMove ? () => setMovingWorktree(true) : undefined}
            />
          </Suspense>
        )}
      </Presence>
      <Suspense fallback={null}>
        {movingWorktree && activeSession && (
          <MoveToWorktreeDialog
            projectId={props.project.id}
            session={activeSession}
            onClose={() => setMovingWorktree(false)}
            onMoved={(res) => applySession({ kind: "upsert", session: res.session })}
          />
        )}
      </Suspense>
    </>
  );
}
