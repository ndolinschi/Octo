import type { Project, ProjectSession, ProjectSummary } from "@octo/agent-client";
import { FolderGit2, GitBranch } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { focusSoon, visibleComposer } from "../../lib/focus";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { filterSections, type PickerRow, type PickerSection } from "../../lib/picker";
import { navigate } from "../../lib/route";
import { branchLabel, branchTitle } from "../../lib/branches";
import { canMoveToWorktree, isDefaultSession, sessionWorkspaceLabel } from "../../lib/sessions/current";
import { orchestratorGlyph } from "../../lib/stateGlyph";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { sessionTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Chip } from "../primitives/Chip";
import { Glyph } from "../primitives/Glyph";
import { Picker } from "../primitives/Picker";
import { Presence } from "../primitives/Presence";
import { StateGlyph } from "../primitives/StateGlyph";
import { clearDraft, stashCrossProjectDraft } from "./composerDraft";
import type { ComposerDraft } from "./useComposerText";
import { useBranchHead } from "./useBranchHead";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));
const BranchPicker = lazy(() => import("./BranchPicker").then((m) => ({ default: m.BranchPicker })));
const MoveToWorktreeDialog = lazy(() => import("../shared/MoveToWorktreeDialog").then((m) => ({ default: m.MoveToWorktreeDialog })));

const isUnusedEmptyMain = (s: ProjectSession): boolean =>
  s.kind === "main" && !s.archived && s.exchanges === 0 && s.children === 0 && s.state === "idle" && (s.queued ?? 0) === 0;

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
  const orchestrators = useOrchestrators(props.projects);
  const now = useNow(true, CLOCK_MINUTE_MS);

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

  const switchProject = async (targetId: string) => {
    if (targetId === props.project.id || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      const draftText = props.draft?.value ?? "";
      const list = bridge.listSessions ? await bridge.listSessions(targetId, { limit: 200, archived: "all" }).catch(() => null) : null;
      const unusedDefault = list?.find((s) => isDefaultSession(s) && isUnusedEmptyMain(s));
      const unusedAny = list?.find((s) => isUnusedEmptyMain(s));
      let targetSessionId: string | null = (unusedDefault ?? unusedAny)?.id ?? null;
      if (targetSessionId === null) {
        const { session } = await bridge.createSession(targetId, {});
        targetSessionId = session.id;
      }

      const canCleanOld =
        activeSession !== undefined && !isDefaultSession(activeSession) && isUnusedEmptyMain(activeSession) && bridge.deleteSession !== undefined;
      if (props.draft && draftText !== "") {
        clearDraft(props.draft);
      }
      if (canCleanOld && bridge.deleteSession) {
        ws?.dropTab(sessionTab(activeSession.id));
        await bridge.deleteSession(props.project.id, activeSession.id).catch(() => undefined);
      }
      if (draftText !== "") {
        stashCrossProjectDraft(targetId, targetSessionId, draftText);
      }
      activity.refreshSessions();
      const prevComposer = visibleComposer();
      navigate(targetId, null, targetSessionId);
      focusSoon(
        () => {
          const el = visibleComposer();
          return el && el !== prevComposer ? el : null;
        },
        { timeout: 3000 },
      );
    } catch {
      // Keep the current session and typed draft intact if creating or loading the target session fails.
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  const sections = (query: string): PickerSection[] => {
    const rows: PickerRow[] = orderedProjects.map((p) => {
      const st = orchestrators.get(p.id) ?? { kind: "idle" as const, at: p.updated_at };
      const isCurrent = p.id === props.project.id;
      const desc = p.description.trim();
      return {
        id: p.id,
        label: p.name,
        ...(desc ? { detail: desc } : {}),
        hint: st.kind === "working" ? "working" : formatRelative(p.updated_at, now),
        lead: <StateGlyph state={orchestratorGlyph(st.kind, false)} size={12} box={16} />,
        checked: isCurrent,
        disabled: switching,
        run: () => void switchProject(p.id),
      };
    });
    return filterSections([{ title: "", rows }], query);
  };

  const wsLabel = activeSession ? sessionWorkspaceLabel(activeSession) : null;
  const canMove = Boolean(bridge.moveSessionToWorktree && activeSession && canMoveToWorktree(activeSession) && props.project.folders.length > 0);
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
          <Picker
            anchor={projectBtn}
            label="Switch project"
            placeholder="Switch project…"
            sections={sections}
            empty="No matching projects"
            side="bottom"
            align="start"
            gap={4}
            onClose={() => setProjectPickerOpen(false)}
          />
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
