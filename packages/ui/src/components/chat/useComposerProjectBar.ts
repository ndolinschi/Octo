import type { Project, ProjectSession, ProjectSummary } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { branchLabel } from "../../lib/branches";
import { focusSoon, visibleComposer } from "../../lib/focus";
import { errorMessage } from "../../lib/format";
import { navigate } from "../../lib/route";
import { canMoveToWorktree, isDefaultSession, sessionWorkspaceLabel } from "../../lib/sessions/current";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { sessionTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { clearDraft, stashCrossProjectDraft } from "./composerDraft";
import { findReusableSharedSession, isUnusedEmptyMain, sortProjectsByRecent, type WorkspaceMode } from "./composerProjectBar";
import { useBranchHead } from "./useBranchHead";
import type { ComposerDraft } from "./useComposerText";

export function useComposerProjectBar(props: {
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

  const switchingRef = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

  const orderedProjects = useMemo(() => sortProjectsByRecent(props.projects), [props.projects]);

  const wsLabel = activeSession ? sessionWorkspaceLabel(activeSession) : null;
  const workspaceMode: WorkspaceMode = wsLabel !== null ? "worktree" : "regular";
  const hasFolders = props.project.folders.length > 0;
  const canMove = Boolean(bridge.moveSessionToWorktree && activeSession && canMoveToWorktree(activeSession) && hasFolders);
  const canToggleWorkspace = hasFolders && (wsLabel !== null || canMove || Boolean(bridge.createSession));
  // Decision 98: the chip shows the branch the session's checkout is on, read from disk (first repository of the project).
  const workspaceId = activeSession?.workspace?.id ?? "shared";
  const branchHead = useBranchHead(props.project.id, workspaceId, hasFolders);
  const refreshBranchHead = branchHead.refresh;
  const repo = branchHead.result?.repos[0];
  const worktreeLabel = wsLabel !== null ? (repo ? branchLabel(repo) : wsLabel) : null;

  const handoffToSession = useCallback(
    async (targetProjectId: string, targetSessionId: string, focusNewComposer = false) => {
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
    },
    [activeSession, activity, bridge, props.draft, props.project.id, ws],
  );

  const switchProject = useCallback(
    async (targetId: string) => {
      if (targetId === props.project.id || switchingRef.current) return;
      switchingRef.current = true;
      setSwitching(true);
      setActionError(null);
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
      } catch (e) {
        setActionError(`Could not switch project: ${errorMessage(e)}. Try again.`);
      } finally {
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    [bridge, handoffToSession, props.project.id],
  );

  const openProjectSettings = useCallback(
    (targetId: string) => {
      if (targetId === props.project.id) {
        ws?.openSettings();
        return;
      }
      void switchProject(targetId);
    },
    [props.project.id, switchProject, ws],
  );

  // "Start in a worktree from <branch>": the empty session moves into a new worktree (nothing in the main checkout changes);
  // a session that cannot move gets a new session in one.
  const startWorktree = useCallback(
    async (branch: string) => {
      if (activeSession && canMove && bridge.moveSessionToWorktree) {
        const res = await bridge.moveSessionToWorktree(props.project.id, activeSession.id, { base_ref: branch, carry_changes: false });
        applySession({ kind: "upsert", session: res.session });
        return;
      }
      const { session } = await bridge.createSession(props.project.id, { workspace: { kind: "worktree", base_ref: branch } });
      activity.refreshSessions();
      navigate(props.project.id, null, session.id);
    },
    [activeSession, activity, applySession, bridge, canMove, props.project.id],
  );

  const switchWorkspaceMode = useCallback(
    async (mode: WorkspaceMode) => {
      if (mode === workspaceMode || switchingRef.current) return;
      switchingRef.current = true;
      setSwitching(true);
      setActionError(null);
      try {
        if (mode === "worktree") {
          if (activeSession && canMove && bridge.moveSessionToWorktree) {
            const res = await bridge.moveSessionToWorktree(props.project.id, activeSession.id, { carry_changes: false });
            applySession({ kind: "upsert", session: res.session });
            refreshBranchHead();
            return;
          }
          const { session } = await bridge.createSession(props.project.id, { workspace: { kind: "worktree" } });
          applySession({ kind: "upsert", session });
          await handoffToSession(props.project.id, session.id);
          return;
        }

        // Worktree -> Regular: switch to an existing unused empty shared session, or create one, carrying over the draft.
        const existing = findReusableSharedSession(state.sessions.list);
        let targetSessionId: string;
        if (existing) {
          targetSessionId = existing.id;
        } else {
          const { session } = await bridge.createSession(props.project.id, { workspace: { kind: "shared" } });
          applySession({ kind: "upsert", session });
          targetSessionId = session.id;
        }
        await handoffToSession(props.project.id, targetSessionId);
      } catch (e) {
        setActionError(`Could not switch to ${mode}: ${errorMessage(e)}. Try again.`);
      } finally {
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    [activeSession, applySession, refreshBranchHead, bridge, canMove, handoffToSession, props.project.id, state.sessions.list, workspaceMode],
  );

  const onMovedToWorktree = useCallback((res: { session: ProjectSession }) => applySession({ kind: "upsert", session: res.session }), [applySession]);

  return {
    activeSession,
    orderedProjects,
    switching,
    actionError,
    workspaceMode,
    canMove,
    canToggleWorkspace,
    hasBranchesApi: Boolean(bridge.listBranches),
    repo,
    worktreeLabel,
    branchHead,
    projectPickerOpen,
    setProjectPickerOpen,
    wsMenu,
    setWsMenu,
    movingWorktree,
    setMovingWorktree,
    branchPicker,
    setBranchPicker,
    switchProject,
    openProjectSettings,
    startWorktree,
    switchWorkspaceMode,
    onMovedToWorktree,
  };
}
