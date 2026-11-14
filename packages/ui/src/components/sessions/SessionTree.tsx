import type { GlobalSession, ProjectSummary } from "@octo/agent-client";
import { ChevronRight, Ellipsis, Plus } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { CLOCK_SIDEBAR_MS } from "../../lib/constants";
import { formatRelative } from "../../lib/format";
import { useNow, useScrollFade } from "../../lib/hooks";
import { projectRowLines, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor } from "../../lib/route";
import { useRovingRows } from "../../lib/rovingRows";
import { isRunning } from "../../lib/sessions/model";
import {
  isLive,
  isOpen,
  mainSessions,
  parseOpen,
  projectSummary,
  sessionGlyph,
  sessionMeta,
  sessionTitle,
  treeKey,
  TREE_ALL,
  visibleSessions,
  type KeyRow,
} from "../../lib/sessions/tree";
import { orchestratorGlyph, type GlyphState } from "../../lib/stateGlyph";
import { jsonCodec, PREFS, usePersistentState } from "../../lib/storage";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { useOrchestrators } from "../../state/orchestrators";
import { useSessionIndex } from "../../state/sessionIndex";
import { requestSession } from "../../state/workspace/sessionsStart";
import { IconButton } from "../primitives/IconButton";
import { ListRow } from "../primitives/ListRow";
import type { MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { SkeletonList } from "../primitives/Skeleton";
import { StateGlyph } from "../primitives/StateGlyph";
import { TextField } from "../primitives/TextField";
import { ConfirmDelete } from "./parts";
import { failureText } from "./useSessionActions";
import { deleteCopy } from "../../lib/sessions/model";

const Menu = lazy(() => import("../primitives/Menu").then((m) => ({ default: m.Menu })));
const NewSessionPopover = lazy(() => import("./NewSessionPopover").then((m) => ({ default: m.NewSessionPopover })));

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

type MenuAt = { session: GlobalSession; x: number; y: number };

/**
 * The sidebar's main navigation (UI decision 96): "Projects and sessions" — a `role="tree"` of project rows (32px, the
 * decision-29 glyph summing up their sessions) and, under an open project, its sessions one step in — or "Sessions", a flat
 * list across projects, newest activity first. One Tab stop (roving), ↑/↓/←/→/Home/End/Enter and a letter to jump; a row's
 * "⋯" (and its context menu) renames, makes default, opens in a new tab, stops, archives and deletes; a project's "+" makes a
 * session (`NewSessionPopover`). Open projects are remembered (`PREFS.sidebarOpen`).
 */
export function SessionTree(props: SessionTreeProps) {
  const { projects, health, bridge } = useApp();
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ projectId?: string; anchor: RefObject<HTMLElement | null> } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useScrollFade(list, "y");
  useRovingRows(list);

  // Stable order (newest project first by creation), so rows never jump under the pointer as activity moves.
  const ordered = useMemo(
    () => (projects ? [...projects].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id)) : null),
    [projects],
  );
  const flat = useMemo(() => mainSessions(index.all), [index.all]);
  const defaultOf = (pid: string) => index.byProject.get(pid)?.find((s) => s.default ?? s.current)?.id ?? null;
  const currentSession = props.agentRoute ? null : (props.activeSessionId ?? (props.activeProjectId ? defaultOf(props.activeProjectId) : null));

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
    if (s.state === "working" || s.state === "waiting")
      items.push({ id: "stop", label: "Stop", run: () => void act(() => bridge.stopSession(s.project_id, s.id)) });
    if (bridge.patchSession && !isDefault) {
      const patch = bridge.patchSession;
      items.push({ id: "archive", label: "Archive", run: () => void act(() => patch(s.project_id, s.id, { archived: true })) });
    }
    if (bridge.deleteSession && !isDefault && !isRunning(s))
      items.push({ id: "sep", separator: true }, { id: "delete", label: "Delete…", run: () => setDeleting(s) });
    return items;
  };
  const openMenu = (s: GlobalSession, e: MouseEvent | KeyboardEvent, el?: HTMLElement | null) => {
    e.preventDefault();
    const r = (el ?? (e.currentTarget instanceof HTMLElement ? e.currentTarget : null))?.getBoundingClientRect();
    const x = "clientX" in e && e.clientX > 0 ? e.clientX : (r?.right ?? 0);
    const y = "clientY" in e && e.clientY > 0 ? e.clientY : (r?.bottom ?? 0);
    setMenu({ session: s, x, y });
  };

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
    const { shown, hidden } = visibleSessions(sessions, showAll.has(p.id));
    keyRows.push({ id: rowId("p", p.id), level: 1, open, title: p.name });
    if (open) {
      for (const s of shown) keyRows.push({ id: rowId("s", s.id), level: 2, title: sessionTitle(s), session: s });
      if (hidden > 0) keyRows.push({ id: rowId("m", p.id), level: 2, title: "Show all" });
    }
    return { p, sessions, active, open, shown, hidden };
  });
  if (props.mode === "sessions") {
    keyRows.length = 0;
    for (const s of flat) keyRows.push({ id: rowId("s", s.id), level: 2, title: sessionTitle(s), session: s });
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
    const at = keyRows.findIndex((r) => r.id === (document.activeElement?.id ?? ""));
    if (at < 0) return;
    const row = keyRows[at];
    if (row?.session && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)))
      return openMenu(row.session, e, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const move = treeKey(e.key, props.mode === "sessions" ? keyRows.map((r) => ({ ...r, level: 1 as const, open: false })) : keyRows, at);
    if (!move) return;
    e.preventDefault();
    if ("toggle" in move) toggle(move.toggle.replace(/^tree-p-/, ""), move.open);
    else document.getElementById(keyRows[move.focus]?.id ?? "")?.focus();
  };

  const loading = projects === null && health !== "offline";
  const sessionRow = (s: GlobalSession, inTree: boolean) => {
    const selected = s.id === currentSession;
    const meta = sessionMeta(s, now);
    return (
      <li key={s.id} role="none" data-tree-row className={cn("group/r relative", inTree && "pl-4")} onContextMenu={(e) => openMenu(s, e)}>
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
                <span className="sr-only">
                  {inTree ? "" : `, ${s.project_name}`}
                  {(s.default ?? s.current) ? ", default" : ""}
                </span>
              </>
            }
            tip={inTree ? sessionTitle(s) : `${sessionTitle(s)} — ${[s.project_name, meta].filter(Boolean).join(" · ")}`}
            meta={
              <span aria-hidden data-tree-meta className="tabular-nums">
                {inTree ? meta : s.project_name}
              </span>
            }
          />
        )}
        {renaming !== s.id && (
          <span data-tree-actions className="absolute top-1 right-1 touch:top-2">
            <IconButton icon={Ellipsis} size="xs" tabIndex={-1} label={`Actions for ${sessionTitle(s)}`} aria-haspopup="menu" onClick={(e) => openMenu(s, e)} />
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(projects ? projects.length > 0 : health !== "offline") && (
        // The caption is a row of the same 32px, its text on the rows' text edge (8 inset + 16 glyph + 8).
        <div className="mt-4 flex h-row-nav shrink-0 items-center pr-0.5 pl-8">
          <h2 className="text-xs text-fg-3">{props.mode === "sessions" ? "Sessions" : "Projects"}</h2>
          {props.mode === "sessions" ? (
            <NewButton label="New session" disabled={!props.canCreate || !projects?.length} onOpen={(anchor) => setCreating({ anchor })} />
          ) : (
            <IconButton icon={Plus} label="Add project" onClick={props.onNewProject} disabled={!props.canCreate} className="ml-auto" />
          )}
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
        {loading && <SkeletonList count={3} size="lg" twoLine />}
        {props.mode === "sessions"
          ? flat.map((s) => sessionRow(s, false))
          : projectRows.map(({ p, sessions, active, open, shown, hidden }) => (
              <li key={p.id} role="none" className="flex flex-col">
                <ProjectRow
                  project={p}
                  sessions={sessions}
                  active={active && (!open || currentSession === null)}
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
                  onNew={(anchor) => setCreating({ projectId: p.id, anchor })}
                />
                {open && (shown.length > 0 || hidden > 0) && (
                  <ul role="group" className="flex flex-col">
                    {shown.map((s) => sessionRow(s, true))}
                    {hidden > 0 && (
                      <li role="none" data-tree-row className="pl-4">
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
            ))}
      </ul>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Suspense fallback={null}>
            <Menu label="Session actions" x={menu.x} y={menu.y} items={menuItems(menu.session)} onClose={() => setMenu(null)} />
          </Suspense>
        )}
      </Presence>
      <Presence show={creating !== null}>
        {creating && (
          <Suspense fallback={null}>
            <NewSessionPopover anchor={creating.anchor} {...(creating.projectId ? { projectId: creating.projectId } : {})} onClose={() => setCreating(null)} />
          </Suspense>
        )}
      </Presence>
      {deleting && (
        <ConfirmDelete
          {...deleteCopy(deleting)}
          busy={busy}
          error={error}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const del = bridge.deleteSession;
            if (del) void act(() => del(deleting.project_id, deleting.id)).then((ok) => ok && setDeleting(null));
          }}
        />
      )}
    </div>
  );
}

/** A row's DOM id: what the keyboard focuses. */
function rowId(kind: "p" | "s" | "m", id: string): string {
  return `tree-${kind}-${id}`;
}

function NewButton(props: { label: string; disabled: boolean; onOpen(anchor: RefObject<HTMLElement | null>): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return <IconButton ref={ref} icon={Plus} label={props.label} disabled={props.disabled} className="ml-auto" onClick={() => props.onOpen(ref)} />;
}

/** The project's glyph from its sessions (needs you > failed > working > queued > idle), else its orchestrator's (no sessions known). */
function projectGlyph(sessions: readonly GlobalSession[], state: OrchestratorState, unseen: boolean): GlyphState {
  const sum = projectSummary(sessions).glyph;
  if (sum === null) return orchestratorGlyph(state.kind, unseen);
  return sum === "idle" && unseen ? "unseen" : sum;
}

/** A project row of the tree: glyph, name, meta ("2 running", or the time since its last activity); "+" and the chevron on hover. */
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
  onNew(anchor: RefObject<HTMLElement | null>): void;
}) {
  const plus = useRef<HTMLButtonElement>(null);
  const { running } = projectSummary(props.sessions);
  const latest = mainSessions(props.sessions)[0];
  const lines = projectRowLines(props.state, props.now, props.project.updated_at);
  const meta = running > 1 ? `${running} running` : running === 1 ? null : latest ? formatRelative(latest.last_activity_at, props.now) : lines.meta;
  const glyph = projectGlyph(props.sessions, props.state, props.unseen);
  return (
    <div data-tree-row data-tree-project className="group/r relative">
      <ListRow
        role="treeitem"
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
      <span data-tree-actions className="absolute top-1 right-1 flex touch:top-2">
        <IconButton
          ref={plus}
          icon={Plus}
          size="xs"
          tabIndex={-1}
          label={`New session in ${props.project.name}`}
          disabled={!props.canCreate}
          onClick={() => props.onNew(plus)}
        />
        <IconButton
          icon={ChevronRight}
          size="xs"
          tabIndex={-1}
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
