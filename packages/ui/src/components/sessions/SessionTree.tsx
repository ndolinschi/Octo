import type { GlobalSession, ProjectSummary } from "@octo/agent-client";
import { ChevronRight, Ellipsis, GitBranch, Plus } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { usePhone } from "../../lib/phone";
import { CLOCK_SIDEBAR_MS } from "../../lib/constants";
import { formatRelative } from "../../lib/format";
import { useNow, useScrollFade } from "../../lib/hooks";
import { projectRowLines, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor, navigate } from "../../lib/route";
import { useRovingRows } from "../../lib/rovingRows";
import { createAndOpenSession } from "../../lib/sessions/createSession";
import { deleteSessionCleanly } from "../../lib/sessions/deleteSession";
import { canMoveToWorktree, deleteCopy, failureText, sessionWorkspaceLabel } from "../../lib/sessions/model";
import { isLive, mainSessions, sessionGlyph, sessionMeta, sessionTitle } from "../../lib/sessions/tree";
import { isOpen, parseOpen, projectSummary, treeKey, TREE_ALL, type KeyRow } from "../../lib/sessions/treeRows";
import { flatSessions, treeSessions } from "../../lib/sessions/flat";
import { orchestratorGlyph, type GlyphState } from "../../lib/stateGlyph";
import { jsonCodec, PREFS, usePersistentState } from "../../lib/storage";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useNav } from "../../state/nav";
import { useOrchestrators } from "../../state/orchestrators";
import { useSessionIndex } from "../../state/sessionIndex";
import { useTabFlags } from "../../state/tabFlags";
import { sessionTab } from "../../state/workspace/layout";
import { requestSession } from "../../state/workspace/sessionsStart";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { ListRow } from "../primitives/ListRow";
import type { MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { SkeletonList } from "../primitives/Skeleton";
import { StateGlyph } from "../primitives/StateGlyph";
import { TextField } from "../primitives/TextField";
import { ConfirmDelete } from "./parts";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));
const MoveToWorktreeDialog = lazy(() => import("../shared/MoveToWorktreeDialog").then((m) => ({ default: m.MoveToWorktreeDialog })));
const DeleteProjectDialog = lazy(() => import("../shared/DeleteProjectDialog").then((m) => ({ default: m.DeleteProjectDialog })));

const openCodec = jsonCodec(parseOpen);

export type SessionTreeProps = {
  /** `tree`: projects with their sessions; `sessions`: one flat list across projects (decision 96). */
  mode: "tree" | "sessions";
  activeProjectId: string | null;
  /** The route's session; null: the project's default one (or none while an agent's tab is the route). */
  activeSessionId: string | null;
  /** An agent's tab is the route: no session row is the current one. */
  agentRoute: boolean;
  unseen: ReadonlySet<string>;
  canCreate: boolean;
  onNewProject(): void;
  /** A row was picked (closes the drawer). */
  onPick(): void;
};

type MenuAt = ({ session: GlobalSession } | { project: ProjectSummary; open: boolean; anchor: HTMLElement | null }) & { x: number; y: number };

/**
 * The sidebar's main navigation (UI decision 96): "Projects and sessions" — a `role="tree"` of project rows (32px, the
 * decision-29 glyph summing up their sessions) and, under an open project, its sessions one step in — or "Sessions", a flat
 * list across projects, newest activity first. One Tab stop (roving), ↑/↓/←/→/Home/End/Enter and a letter to jump; a row's
 * "⋯" (and its context menu) renames, makes default, opens in a new tab, stops, archives and deletes; "+" creates a new
 * session directly without a modal. Open projects are remembered (`PREFS.sidebarOpen`).
 */
export function SessionTree(props: SessionTreeProps) {
  const { projects, health, bridge } = useApp();
  const device = useHost().remoteDevice !== undefined;
  const activity = useActivity();
  const nav = useNav();
  const now = useNow(true, CLOCK_SIDEBAR_MS);
  const index = useSessionIndex(projects);
  const orchestrators = useOrchestrators(projects);
  const [stored, setStored] = usePersistentState(PREFS.sidebarOpen, openCodec);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<GlobalSession | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(null);
  const [moving, setMoving] = useState<GlobalSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  useScrollFade(list, "y");
  useRovingRows(list);
  const phone = usePhone();

  // Stable order (newest project first by creation), so rows never jump under the pointer as activity moves.
  const ordered = useMemo(
    () => (projects ? [...projects].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id)) : null),
    [projects],
  );
  const defaultOf = (pid: string) => index.byProject.get(pid)?.find((s) => s.default ?? s.current)?.id ?? null;
  const currentSession = props.agentRoute ? null : (props.activeSessionId ?? (props.activeProjectId ? defaultOf(props.activeProjectId) : null));
  const flat = useMemo(() => flatSessions(index.all, currentSession), [index.all, currentSession]);
  const loading = projects === null && health !== "offline";
  const sessionsLoading = props.mode === "sessions" && health !== "offline" && projects !== null && projects.length > 0 && !index.loaded && flat.length === 0;
  const unrepresented = useMemo(() => {
    if (props.mode !== "sessions" || loading || sessionsLoading) return [];
    const seen = new Set(flat.map((s) => s.project_id));
    return (ordered ?? []).filter((p) => !seen.has(p.id));
  }, [props.mode, loading, sessionsLoading, flat, ordered]);

  const toggle = (pid: string, open: boolean) => setStored((s) => ({ ...s, [pid]: open }));
  const act = async (call: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await call();
      activity.refreshSessions();
      return true;
    } catch (e) {
      setError(failureText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const menuItems = (s: GlobalSession): MenuItem[] => {
    const isDefault = s.default ?? s.current;
    const items: MenuItem[] = [{ id: "rename", label: "Rename", run: () => setRenaming(s.id) }];
    if (!isDefault) items.push({ id: "default", label: "Make default", run: () => void act(() => bridge.setDefaultSession(s.project_id, s.id)) });
    if (s.project_id === props.activeProjectId) items.push({ id: "tab", label: "Open in new tab", run: () => nav.workspace()?.openSession(s.id) });
    if (bridge.moveSessionToWorktree && canMoveToWorktree(s)) {
      items.push({ id: "worktree", label: "Move to worktree…", run: () => setMoving(s) });
    }
    if (s.state === "working" || s.state === "waiting")
      items.push({ id: "stop", label: "Stop", run: () => void act(() => bridge.stopSession(s.project_id, s.id)) });
    if (bridge.patchSession && !isDefault) {
      const patch = bridge.patchSession;
      items.push({ id: "archive", label: "Archive", run: () => void act(() => patch(s.project_id, s.id, { archived: true })) });
    }
    if (bridge.deleteSession) items.push({ id: "sep", separator: true }, { id: "delete", label: "Delete…", run: () => setDeleting(s) });
    return items;
  };
  const menuPoint = (e: MouseEvent | KeyboardEvent, el?: HTMLElement | null) => {
    e.preventDefault();
    const r = (el ?? (e.currentTarget instanceof HTMLElement ? e.currentTarget : null))?.getBoundingClientRect();
    const x = "clientX" in e && e.clientX > 0 ? e.clientX : (r?.right ?? 0);
    const y = "clientY" in e && e.clientY > 0 ? e.clientY : (r?.bottom ?? 0);
    return { x, y };
  };
  const openMenu = (s: GlobalSession, e: MouseEvent | KeyboardEvent, el?: HTMLElement | null) => setMenu({ session: s, ...menuPoint(e, el) });
  // 11a / A6: a project row's menu (Shift+F10, the ContextMenu key, a right click, a long press on the phone): the "+" and the
  // chevron of the row, for the keyboard and for the phone (which shows the chevron only).
  const openProjectMenu = (p: ProjectSummary, open: boolean, e: MouseEvent | KeyboardEvent, el?: HTMLElement | null) => {
    const anchor = el ?? (e.currentTarget instanceof HTMLElement ? e.currentTarget : null);
    setMenu({ project: p, open, anchor, ...menuPoint(e, anchor) });
  };
  const createSession = (projectId: string) => {
    void act(async () => {
      const ws = projectId === props.activeProjectId ? nav.workspace() : null;
      await createAndOpenSession(bridge, projectId, {
        openInWorkspace: ws ? (id) => ws.openSession(id) : undefined,
      });
      props.onPick();
    });
  };
  const projectMenuItems = (m: { project: ProjectSummary; open: boolean; anchor: HTMLElement | null }): MenuItem[] => [
    {
      id: "new",
      label: "New session",
      disabled: !props.canCreate,
      run: () => createSession(m.project.id),
    },
    { id: "toggle", label: m.open ? "Hide sessions" : "Show sessions", run: () => toggle(m.project.id, !m.open) },
    ...(!device
      ? [
          { id: "sep-del", separator: true as const },
          { id: "delete", label: "Delete project…", run: () => setDeletingProject(m.project) },
        ]
      : []),
  ];

  const tabFlags = useTabFlags();
  // The rows in screen order, for the keyboard (each row's main element has `id` = its key).
  const keyRows: (KeyRow & { session?: GlobalSession })[] = [];
  const projectRows = (ordered ?? []).map((p) => {
    const sessions = index.byProject.get(p.id) ?? [];
    const active = p.id === props.activeProjectId;
    const open = isOpen(
      stored,
      p.id,
      active,
      sessions.some((s) => !s.archived && isLive(s)),
    );
    const { shown, hidden } = treeSessions(sessions, showAll.has(p.id), active ? currentSession : null);
    const showMore = hidden > 0 && (!showAll.has(p.id) || shown.length < TREE_ALL || tabFlags.sessions);
    keyRows.push({ id: rowId("p", p.id), level: 1, open, title: p.name });
    if (open) {
      for (const s of shown) keyRows.push({ id: rowId("s", s.id), level: 2, title: sessionTitle(s), session: s });
      if (showMore) keyRows.push({ id: rowId("m", p.id), level: 2, title: "Show all" });
    }
    return { p, sessions, active, open, shown, hidden, showMore };
  });
  if (props.mode === "sessions") {
    keyRows.length = 0;
    for (const s of flat) keyRows.push({ id: rowId("s", s.id), level: 2, title: sessionTitle(s), session: s });
    for (const p of unrepresented) keyRows.push({ id: rowId("p", p.id), level: 1, open: false, title: p.name });
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
    const at = keyRows.findIndex((r) => r.id === (document.activeElement?.id ?? ""));
    if (at < 0) return;
    const row = keyRows[at];
    const menuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (row?.session && menuKey) return openMenu(row.session, e, focused);
    const project = menuKey && row?.level === 1 && !row.session ? ordered?.find((p) => rowId("p", p.id) === row.id) : undefined;
    if (project) return openProjectMenu(project, row?.open === true, e, focused);
    const move = treeKey(e.key, props.mode === "sessions" ? keyRows.map((r) => ({ ...r, level: 1 as const, open: false })) : keyRows, at);
    if (!move) return;
    e.preventDefault();
    if ("toggle" in move) toggle(move.toggle.replace(/^tree-p-/, ""), move.open);
    else document.getElementById(keyRows[move.focus]?.id ?? "")?.focus();
  };

  const sessionRow = (s: GlobalSession, inTree: boolean) => {
    const selected = s.id === currentSession;
    const meta = sessionMeta(s, now);
    const wsLabel = sessionWorkspaceLabel(s);
    return (
      <li key={s.id} role="none" data-tree-row data-tree-level={inTree ? 2 : 1} className="group/r relative" onContextMenu={(e) => openMenu(s, e)}>
        {renaming === s.id ? (
          <RenameRow
            initial={sessionTitle(s)}
            onDone={(title) => {
              setRenaming(null);
              const patch = bridge.patchSession;
              if (title !== null && patch) void act(() => patch(s.project_id, s.id, { title }));
            }}
          />
        ) : (
          <ListRow
            role="treeitem"
            aria-haspopup="menu"
            level={inTree ? 2 : 1}
            id={rowId("s", s.id)}
            size="md"
            tone={selected ? "default" : "quiet"}
            href={hrefFor(s.project_id, null, s.id)}
            onClick={props.onPick}
            selected={selected}
            leading={<StateGlyph state={sessionGlyph(s)} size={12} box={16} label />}
            title={
              <>
                {sessionTitle(s)}
                {(wsLabel || (s.default ?? s.current)) && (
                  <span className="sr-only">
                    {wsLabel ? `, worktree ${wsLabel}` : ""}
                    {(s.default ?? s.current) ? ", default" : ""}
                  </span>
                )}
              </>
            }
            tip={
              inTree
                ? wsLabel
                  ? `${sessionTitle(s)} — Worktree: ${wsLabel}`
                  : sessionTitle(s)
                : `${sessionTitle(s)} — ${[s.project_name, wsLabel ? `Worktree: ${wsLabel}` : "", meta].filter(Boolean).join(" · ")}`
            }
            meta={
              <span aria-hidden data-tree-meta className="flex min-w-0 items-center gap-1 tabular-nums">
                {wsLabel && <Glyph icon={GitBranch} size={14} className="shrink-0 text-fg-3" />}
                <span className="min-w-0 truncate">{inTree ? meta : s.project_name}</span>
              </span>
            }
          />
        )}
        {renaming !== s.id && (
          // The pointer's way to the row's menu; the keyboard's is Shift+F10 on the row (the button is out of the tree's a11y).
          <span data-tree-actions role="none" className="absolute top-1 right-1 touch:top-2">
            <IconButton
              icon={Ellipsis}
              size={phone ? "lg" : "xs"}
              tabIndex={-1}
              aria-hidden="true"
              label={`Actions for ${sessionTitle(s)}`}
              aria-haspopup="menu"
              onClick={(e) => openMenu(s, e)}
            />
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(projects ? projects.length > 0 : health !== "offline") && (
        // The section caption (one rule for both side columns): on the rows' glyph column (8 inset), a 20px line 16px under the
        // block above and 4px over its first row. "New project" is the row at the top, so the caption has no "+" of its own;
        // the flat Sessions list keeps "New session", its glyph's right edge on the rows' meta edge.
        <div data-side-caption className="mt-4 mb-1 flex h-5 shrink-0 items-center pr-0.5 pl-2">
          <h2 className="text-xs text-fg-3">{props.mode === "sessions" ? "Sessions" : "Projects"}</h2>
          <NewButton
            label="New session"
            disabled={!props.canCreate || !projects?.length}
            onClick={() => {
              const targetId = props.activeProjectId ?? ordered?.[0]?.id;
              if (targetId) createSession(targetId);
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="px-2 pb-1 text-xs text-err">
          {error}
        </p>
      )}
      <ul
        ref={list}
        role="tree"
        aria-label={props.mode === "sessions" ? "Sessions" : "Projects and sessions"}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain fade-y"
      >
        {(loading || sessionsLoading) && <SkeletonList count={3} size="md" />}
        {props.mode === "sessions" ? (
          <>
            {flat.map((s) => sessionRow(s, false))}
            {unrepresented.map((p) => (
              <li key={p.id} role="none" className="flex flex-col">
                <ProjectRow
                  project={p}
                  sessions={index.byProject.get(p.id) ?? []}
                  active={p.id === props.activeProjectId}
                  open={false}
                  unseen={props.unseen.has(p.id) && p.id !== props.activeProjectId}
                  state={orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }}
                  now={now}
                  canCreate={props.canCreate}
                  onToggle={() => toggle(p.id, true)}
                  onOpen={props.onPick}
                  onNew={() => createSession(p.id)}
                  onMenu={(e) => openProjectMenu(p, false, e)}
                />
              </li>
            ))}
          </>
        ) : (
          projectRows.map(({ p, sessions, active, open, shown, hidden, showMore }) => (
            <li key={p.id} role="none" className="flex flex-col">
              <ProjectRow
                project={p}
                sessions={sessions}
                active={active && (!open || !shown.some((s) => s.id === currentSession))}
                open={open}
                unseen={props.unseen.has(p.id) && !active}
                state={orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }}
                now={now}
                canCreate={props.canCreate}
                onToggle={() => toggle(p.id, !open)}
                onOpen={() => {
                  if (!open) toggle(p.id, true);
                  props.onPick();
                }}
                onNew={() => createSession(p.id)}
                onMenu={(e) => openProjectMenu(p, open, e)}
              />
              {open && (shown.length > 0 || showMore) && (
                <ul role="group" className="flex flex-col">
                  {shown.map((s) => sessionRow(s, true))}
                  {showMore && (
                    <li role="none" data-tree-row data-tree-level={2}>
                      <ListRow
                        role="treeitem"
                        level={2}
                        id={rowId("m", p.id)}
                        size="md"
                        tone="quiet"
                        leading={<span />}
                        title={showAll.has(p.id) ? "Open Sessions" : `Show all (${shown.length + hidden})`}
                        onClick={() => {
                          if (!showAll.has(p.id) || shown.length < TREE_ALL) return setShowAll((all) => new Set(all).add(p.id));
                          requestSession(p.id, "");
                          const ws = nav.workspace();
                          if (active && ws) ws.openTool("sessions");
                          else window.location.hash = hrefFor(p.id);
                          props.onPick();
                        }}
                      />
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))
        )}
      </ul>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Suspense fallback={null}>
            <Menu
              label={"session" in menu ? "Session actions" : `${menu.project.name} actions`}
              x={menu.x}
              y={menu.y}
              items={"session" in menu ? menuItems(menu.session) : projectMenuItems(menu)}
              onClose={() => setMenu(null)}
            />
          </Suspense>
        )}
      </Presence>
      {deleting && (
        <ConfirmDelete
          {...deleteCopy(deleting)}
          busy={busy}
          error={deleteError}
          onClose={() => {
            setDeleting(null);
            setDeleteError(null);
          }}
          onConfirm={() => {
            if (!bridge.deleteSession) return;
            const target = deleting;
            setDeleteError(null);
            setBusy(true);
            void deleteSessionCleanly(bridge, target.project_id, target)
              .then(
                (res) => {
                  if (target.project_id === props.activeProjectId) {
                    nav.workspace()?.dropTab?.(sessionTab(target.id));
                    if (target.id === currentSession && res.replacementId) {
                      const ws = nav.workspace();
                      if (ws?.showSession) ws.showSession(res.replacementId);
                      else navigate(target.project_id, null, res.replacementId);
                    }
                  }
                  activity.refreshSessions();
                  setDeleting(null);
                },
                (e: unknown) => setDeleteError(failureText(e)),
              )
              .finally(() => setBusy(false));
          }}
        />
      )}
      <Suspense fallback={null}>
        {deletingProject && <DeleteProjectDialog project={deletingProject} activeProjectId={props.activeProjectId} onClose={() => setDeletingProject(null)} />}
      </Suspense>
      <Suspense fallback={null}>{moving && <MoveToWorktreeDialog projectId={moving.project_id} session={moving} onClose={() => setMoving(null)} />}</Suspense>
    </div>
  );
}

/** A row's DOM id: what the keyboard focuses. */
function rowId(kind: "p" | "s" | "m", id: string): string {
  return `tree-${kind}-${id}`;
}

function NewButton(props: { label: string; disabled: boolean; onClick(): void }) {
  return <IconButton icon={Plus} size="sm" label={props.label} disabled={props.disabled} className="-my-1 ml-auto" onClick={props.onClick} />;
}

/** The project's glyph from its sessions (needs you > failed > working > queued > idle), else its orchestrator's (no sessions known). */
function projectGlyph(sessions: readonly GlobalSession[], state: OrchestratorState, unseen: boolean): GlyphState {
  const sum = projectSummary(sessions).glyph;
  if (sum === null) return orchestratorGlyph(state.kind, unseen);
  return sum === "idle" && unseen ? "unseen" : sum;
}

/** A project row of the tree: glyph, name, meta ("2 running", or the time since its last activity); "+", "⋯" and the chevron on hover. */
function ProjectRow(props: {
  project: ProjectSummary;
  sessions: readonly GlobalSession[];
  active: boolean;
  open: boolean;
  unseen: boolean;
  state: OrchestratorState;
  now: number;
  canCreate: boolean;
  onToggle(): void;
  onOpen(): void;
  onNew(): void;
  onMenu(e: MouseEvent): void;
}) {
  const phone = usePhone();
  const { running } = projectSummary(props.sessions);
  const latest = mainSessions(props.sessions)[0];
  const lines = projectRowLines(props.state, props.now, props.project.updated_at);
  const meta = running > 1 ? `${running} running` : running === 1 ? null : latest ? formatRelative(latest.last_activity_at, props.now) : lines.meta;
  const glyph = projectGlyph(props.sessions, props.state, props.unseen);
  return (
    <div data-tree-row data-tree-project role="none" className="group/r relative" onContextMenu={props.onMenu}>
      <ListRow
        role="treeitem"
        aria-haspopup="menu"
        level={1}
        expanded={props.open}
        id={rowId("p", props.project.id)}
        size="md"
        href={hrefFor(props.project.id)}
        onClick={props.onOpen}
        selected={props.active}
        tip={props.project.name}
        leading={<StateGlyph state={glyph} size={14} box={16} label />}
        title={props.project.name}
        meta={
          <span aria-hidden data-tree-meta className="tabular-nums">
            {meta}
          </span>
        }
      />
      {/* The pointer's ways to these (the keyboard's: Shift+F10 on the row, ← / →): out of the tree's a11y. On the phone the
          chevron alone, a full 44px target; "New session" is in the row's menu (a long press) and in the header's "⋯". */}
      <span data-tree-actions role="none" className="absolute top-1 right-1 flex touch:top-2">
        {!phone && (
          <>
            <IconButton
              icon={Plus}
              size="xs"
              tabIndex={-1}
              aria-hidden="true"
              label={`New session in ${props.project.name}`}
              disabled={!props.canCreate}
              onClick={props.onNew}
            />
            <IconButton
              icon={Ellipsis}
              size="xs"
              tabIndex={-1}
              aria-hidden="true"
              label={`Actions for ${props.project.name}`}
              aria-haspopup="menu"
              onClick={(e) => props.onMenu(e)}
            />
          </>
        )}
        <IconButton
          icon={ChevronRight}
          size={phone ? "lg" : "xs"}
          tabIndex={-1}
          aria-hidden="true"
          label={props.open ? `Hide the sessions of ${props.project.name}` : `Show the sessions of ${props.project.name}`}
          className={cn(props.open && "[&_svg]:rotate-90")}
          onClick={props.onToggle}
        />
      </span>
    </div>
  );
}

/** Rename in place: Enter saves, Esc leaves it as it was (the row comes back). */
function RenameRow(props: { initial: string; onDone(title: string | null): void }) {
  const [value, setValue] = useState(props.initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(title !== null && title.trim() !== "" && title.trim() !== props.initial ? title.trim() : null);
  };
  return (
    <div className="flex h-ctl-md items-center px-1 touch:h-ctl-lg">
      <TextField
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just chose Rename: the field is what they asked for
        autoFocus
        aria-label="Session title"
        size="sm"
        value={value}
        maxLength={120}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(null);
          }
        }}
        onBlur={() => finish(value)}
      />
    </div>
  );
}
