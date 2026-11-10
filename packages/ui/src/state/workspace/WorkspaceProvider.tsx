import { focusSoon } from "../../lib/focus";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { readPref, writePref } from "../../lib/storage";
import { useNav, type WorkspaceApi, type WorkspaceCommand } from "../nav";
import { useProject } from "../project";
import * as L from "./layout";
import type { Layout, TabId, ToolTab } from "./layout";

/** Narrowest a group may get; below the sum of these the dock shows one strip. */
export const MIN_GROUP = 280;
/** Gap between groups = the window gutter (also the divider's hit area). */
export const GAP = 8;
/** Width a newly opened side group takes for a tool (Agents, Notes, Files). */
const TOOL_WIDTH = 360;
/** Below this window width the dock always shows a single strip. */
const DOCKED_QUERY = "(min-width: 1100px)";

/** Modifier as shown in shortcut hints. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** Where a dragged tab lands. */
export type DropTarget = { kind: "strip"; group: string; index: number } | { kind: "into"; group: string } | { kind: "split"; group: string; side: "left" | "right" };

/** What the workspace needs from the open-files state (attached by a component inside CodeProvider). */
export type CodeLink = { modified(key: string): boolean; name(key: string): string; close(key: string): void; restore(key: string): void; select(key: string): void };

type Closing = { tabs: TabId[]; files: string[] };

export type WorkspaceValue = {
  projectId: string;
  layout: Layout;
  /** One strip for everything (narrow window or groups that don't fit). */
  narrow: boolean;
  /** The conversation tab whose live indicator may animate (the one being watched), if visible. */
  watched: TabId | null;
  /** Agent of the conversation last focused (for the agents tree selection). */
  currentAgentId: string | null;
  /** A tab whose button should take focus (after a keyboard move or close). */
  focusRequest: { tab: TabId; n: number } | null;
  /** Per-tab view memory (scroll positions, composer draft) that survives remounts. */
  memory: Map<string, unknown>;
  closing: Closing | null;
  /** Opens the project settings dialog (e.g. from the Files tab's empty state). */
  openSettings(): void;
  isVisible(tab: TabId): boolean;
  setDockWidth(width: number): void;
  activate(tab: TabId): void;
  focusGroup(groupId: string): void;
  focusChat(): void;
  openAgent(agentId: string, options?: { otherSide?: boolean }): void;
  openTool(tool: ToolTab): void;
  /** Opens a file's tab: in `where.group` (in place of `where.replace`) when given, else in the side group. */
  openFileTab(key: string, where?: { group: string; replace?: TabId }): void;
  /** Opens (or focuses) a tab in a given group. */
  openIn(tab: TabId, groupId: string): void;
  /** Removes a tab without asking (a restored file that no longer exists). */
  dropTab(tab: TabId): void;
  requestClose(tabs: TabId[]): void;
  confirmClose(): void;
  cancelClose(): void;
  closeOthers(tab: TabId): void;
  canMoveToOtherSide(tab: TabId): boolean;
  moveToOtherSide(tab: TabId): void;
  canSplitRight(tab: TabId): boolean;
  splitRight(tab: TabId): void;
  canDrop(tab: TabId, target: DropTarget): boolean;
  drop(tab: TabId, target: DropTarget): void;
  /** Moves divider `index` (between group index and index+1) by `px`. */
  resize(index: number, px: number): void;
  equalize(): void;
  cycle(delta: 1 | -1): void;
  attachCode(link: CodeLink | null): void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

function initial(projectId: string): Layout {
  return L.deserialize(readPref(`layout.${projectId}`)) ?? L.initialLayout();
}

function conversationOf(tab: TabId): string | null | undefined {
  const ref = L.parseTab(tab);
  if (ref?.kind === "chat") return null;
  if (ref?.kind === "agent") return ref.agentId;
  return undefined;
}

/**
 * The dock of one project: tab groups, what is open where, persistence, routing and the
 * keyboard shortcuts. Layout operations are the pure functions in `layout.ts`.
 */
export function WorkspaceProvider({ routeAgentId, onSettings, children }: { routeAgentId: string | null; onSettings(): void; children: ReactNode }) {
  const nav = useNav();
  const { projectId, project, state } = useProject();
  const [layout, setLayout] = useState<Layout>(() => initial(projectId));
  const layoutRef = useRef(layout);
  const [dockWidth, setDockWidth] = useState(0);
  const docked = useMediaQuery(DOCKED_QUERY);
  const [lastConversation, setLastConversation] = useState<TabId>(L.CHAT);
  const [focusRequest, setFocusRequest] = useState<{ tab: TabId; n: number } | null>(null);
  const [closing, setClosing] = useState<Closing | null>(null);
  const [memory] = useState(() => new Map<string, unknown>());
  const code = useRef<CodeLink | null>(null);
  const selfNav = useRef<string | null>(null);

  const n = layout.groups.length;
  const narrow = !docked || (n > 1 && dockWidth > 0 && dockWidth < n * MIN_GROUP + (n - 1) * GAP);
  const narrowRef = useRef(narrow);
  const widthRef = useRef(dockWidth);
  useLayoutEffect(() => {
    narrowRef.current = narrow;
    widthRef.current = dockWidth;
  });

  /** Applies a layout; when the focused tab is a conversation its route goes into the URL. */
  const commit = useCallback(
    (next: Layout, options: { route?: boolean; focusTab?: TabId } = {}) => {
      if (next === layoutRef.current && !options.focusTab) return;
      layoutRef.current = next;
      setLayout(next);
      if (options.focusTab) setFocusRequest((r) => ({ tab: options.focusTab!, n: (r?.n ?? 0) + 1 }));
      const active = L.focusedGroup(next).active;
      const agent = conversationOf(active);
      if (agent === undefined) return;
      setLastConversation(active);
      if (options.route === false) return;
      const hash = hrefFor(projectId, agent);
      if (window.location.hash !== hash) {
        selfNav.current = agent ?? "";
        window.location.hash = hash;
      }
    },
    [projectId],
  );

  // A keyboard action on a focused tab keeps focus on that tab wherever it lands.
  const keepFocus = () => {
    const el = document.activeElement as HTMLElement | null;
    return el?.getAttribute("role") === "tab" ? el.dataset.tabId : undefined;
  };

  /** Opens a tab in the side group, creating it right of Chat's group (`fraction` of the row) when there is none. */
  const openSide = useCallback(
    (tab: TabId, fraction?: number) => {
      const current = layoutRef.current;
      const side = L.sideGroup(current);
      const target: L.Target = side ? { group: side.id } : { newAfter: L.groupOf(current, L.CHAT)!.id, size: fraction ?? L.groupOf(current, L.CHAT)!.size / 2 };
      commit(L.open(current, tab, target));
    },
    [commit],
  );

  const toolFraction = () => (widthRef.current > 0 ? Math.min(0.5, (TOOL_WIDTH + GAP) / widthRef.current) : 0.3);

  const doClose = useCallback(
    (tabs: TabId[]) => {
      const hadFocus = keepFocus() !== undefined;
      for (const t of tabs) {
        const ref = L.parseTab(t);
        if (ref?.kind === "file") code.current?.close(ref.key);
      }
      const next = L.close(layoutRef.current, tabs);
      commit(next, hadFocus ? { focusTab: L.focusedGroup(next).active } : {});
    },
    [commit],
  );

  const requestClose = useCallback(
    (tabs: TabId[]) => {
      const closable = tabs.filter(L.closable);
      if (!closable.length) return;
      const files = closable.flatMap((t) => {
        const ref = L.parseTab(t);
        return ref?.kind === "file" && code.current?.modified(ref.key) ? [code.current.name(ref.key)] : [];
      });
      if (files.length) setClosing({ tabs: closable, files });
      else doClose(closable);
    },
    [doClose],
  );

  const openAgent = useCallback(
    (agentId: string, options: { otherSide?: boolean; route?: boolean } = {}) => {
      const current = layoutRef.current;
      const tab = L.agentTab(agentId);
      const home = L.groupOf(current, L.CHAT)!;
      const target = options.otherSide && !L.groupOf(current, tab) ? L.otherSide(current, home.id) : null;
      commit(L.open(current, tab, target ?? { group: home.id }), { route: options.route });
    },
    [commit],
  );

  const value = useMemo<WorkspaceValue>(() => {
    const isVisible = (tab: TabId) => {
      const g = L.groupOf(layout, tab);
      return !!g && g.active === tab && (!narrow || g.id === layout.focused);
    };
    const agentOf = conversationOf(lastConversation);
    return {
      projectId,
      layout,
      narrow,
      watched: isVisible(lastConversation) ? lastConversation : null,
      currentAgentId: agentOf === undefined ? null : (agentOf ?? project?.orchestrator_agent_id ?? null),
      focusRequest,
      memory,
      closing,
      openSettings: onSettings,
      isVisible,
      setDockWidth,
      activate: (tab) => commit(L.activate(layoutRef.current, tab)),
      // Clicking into a group (not on a tab) moves focus without touching the URL.
      focusGroup: (id) => {
        const next = L.focusGroup(layoutRef.current, id);
        if (next !== layoutRef.current) commit(next, { route: false });
      },
      // Showing the conversation puts the caret in its composer (chips, palette, the Agents root row).
      focusChat: () => {
        commit(L.activate(layoutRef.current, L.CHAT));
        focusSoon(() => document.getElementById("octo-composer"));
      },
      openAgent,
      // The Files tab is a file view (editor + tree column): it opens at half the row like a file.
      openTool: (tool) => {
        openSide(tool, tool === "files" ? undefined : toolFraction());
        if (tool === "files") {
          const g = L.groupOf(layoutRef.current, tool);
          if (g && !g.tabs.includes(L.CHAT)) commit(L.ensureSize(layoutRef.current, g.id, 0.45), { route: false });
        }
      },
      // A file needs room: a side group sized for a tool widens to half the row.
      openFileTab: (key, where) => {
        if (where) {
          const current = layoutRef.current;
          if (where.replace && L.groupOf(current, where.replace)) return commit(L.replace(current, where.replace, L.fileTab(key)));
          return commit(L.open(current, L.fileTab(key), { group: where.group }));
        }
        openSide(L.fileTab(key));
        const g = L.groupOf(layoutRef.current, L.fileTab(key));
        if (g && !g.tabs.includes(L.CHAT)) commit(L.ensureSize(layoutRef.current, g.id, 0.45), { route: false });
      },
      openIn: (tab, groupId) => commit(L.open(layoutRef.current, tab, { group: groupId })),
      dropTab: (tab) => commit(L.close(layoutRef.current, [tab])),
      requestClose,
      confirmClose: () => {
        if (closing) doClose(closing.tabs);
        setClosing(null);
      },
      cancelClose: () => setClosing(null),
      closeOthers: (tab) => {
        const g = L.groupOf(layoutRef.current, tab);
        const pool = narrowRef.current ? L.allTabs(layoutRef.current) : (g?.tabs ?? []);
        commit(L.activate(layoutRef.current, tab));
        requestClose(pool.filter((t) => t !== tab));
      },
      canMoveToOtherSide: (tab) => {
        const g = L.groupOf(layout, tab);
        return !narrow && !!g && (layout.groups.length > 1 || g.tabs.length > 1);
      },
      moveToOtherSide: (tab) => {
        if (narrowRef.current) return;
        commit(L.moveToOtherSide(layoutRef.current, tab), { focusTab: keepFocus() ? tab : undefined });
      },
      canSplitRight: (tab) => {
        const g = L.groupOf(layout, tab);
        return !narrow && !!g && L.canSplit(layout, tab, g.id) && dockWidth >= (n + 1) * MIN_GROUP + n * GAP;
      },
      splitRight: (tab) => {
        const g = L.groupOf(layoutRef.current, tab);
        if (!g || narrowRef.current) return;
        commit(L.split(layoutRef.current, tab, g.id, "right"), { focusTab: keepFocus() ? tab : undefined });
      },
      canDrop: (tab, target) => {
        const from = L.groupOf(layout, tab);
        if (!from) return false;
        if (target.kind === "into") return target.group !== from.id;
        if (target.kind === "strip") return true;
        return L.canSplit(layout, tab, target.group) && (from.tabs.length === 1 && from.id !== target.group ? true : dockWidth >= (n + 1) * MIN_GROUP + n * GAP);
      },
      drop: (tab, target) => {
        const current = layoutRef.current;
        if (target.kind === "strip") commit(L.move(current, tab, target.group, target.index));
        else if (target.kind === "into") commit(L.move(current, tab, target.group));
        else commit(L.split(current, tab, target.group, target.side));
      },
      resize: (index, px) => {
        const inner = widthRef.current - (layoutRef.current.groups.length - 1) * GAP;
        if (inner <= 0) return;
        commit(L.resize(layoutRef.current, index, px / inner, MIN_GROUP / inner));
      },
      equalize: () => commit(L.equalize(layoutRef.current)),
      cycle: (delta) => {
        const current = layoutRef.current;
        const tabs = narrowRef.current ? L.allTabs(current) : L.focusedGroup(current).tabs;
        const i = tabs.indexOf(L.focusedGroup(current).active);
        const next = tabs[(i + delta + tabs.length) % tabs.length];
        if (next) commit(L.activate(current, next), { focusTab: keepFocus() ? next : undefined });
      },
      attachCode: (link) => {
        code.current = link;
      },
    };
  }, [projectId, project, layout, narrow, dockWidth, n, lastConversation, focusRequest, memory, closing, onSettings, commit, openAgent, openSide, requestClose, doClose]);

  /* ---------- routing ---------- */

  const agentsLoaded = project !== null && state.agentOrder.length > 0;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const key = routeAgentId ?? "";
    if (handled.current === key) return;
    if (selfNav.current === key) {
      selfNav.current = null;
      handled.current = key;
      return;
    }
    if (!routeAgentId) {
      handled.current = key;
      commit(L.activate(layoutRef.current, L.CHAT), { route: false });
      return;
    }
    if (!agentsLoaded) return;
    handled.current = key;
    if (state.agents[routeAgentId]) openAgent(routeAgentId, { route: false });
    else window.location.replace(hrefFor(projectId));
  }, [routeAgentId, agentsLoaded, state.agents, projectId, commit, openAgent]);

  /* ---------- stale tabs ---------- */

  useEffect(() => {
    if (!agentsLoaded || !project) return;
    const folders = new Set(project.folders.map((f) => f.label));
    const next = L.prune(layoutRef.current, (tab) => {
      const ref = L.parseTab(tab);
      if (ref?.kind === "agent") return Boolean(state.agents[ref.agentId]);
      if (ref?.kind === "file") return folders.has(ref.key.slice(0, ref.key.indexOf("\u0000")));
      return true;
    });
    if (next !== layoutRef.current) commit(next, { route: false });
  }, [agentsLoaded, project, state.agents, commit]);

  /* ---------- persistence ---------- */

  useEffect(() => {
    const id = window.setTimeout(() => writePref(`layout.${projectId}`, L.serialize(layout)), 250);
    return () => window.clearTimeout(id);
  }, [layout, projectId]);

  /* ---------- keyboard ---------- */

  const valueRef = useRef(value);
  useLayoutEffect(() => {
    valueRef.current = value;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const ws = valueRef.current;
      // A focused tab button is the tab the shortcut means; otherwise the focused group's active tab.
      const el = document.activeElement as HTMLElement | null;
      const active = (el?.getAttribute("role") === "tab" && el.dataset.tabId) || L.focusedGroup(layoutRef.current).active;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        ws.moveToOtherSide(active);
      } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        ws.requestClose([active]);
      } else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault();
        ws.cycle(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* ---------- palette ---------- */

  useEffect(() => {
    const label = (tab: TabId) => document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(tab)}"]`)?.dataset.label ?? tab;
    const api: WorkspaceApi = {
      openAgent: (id) => valueRef.current.openAgent(id),
      focusChat: () => valueRef.current.focusChat(),
      actions: () => {
        const ws = valueRef.current;
        const active = L.focusedGroup(layoutRef.current).active;
        const name = label(active);
        const out: WorkspaceCommand[] = [
          { id: "tool-agents", label: "Show agents", run: () => ws.openTool("agents") },
          { id: "tool-notes", label: "Show notes", run: () => ws.openTool("notes") },
          { id: "tool-files", label: "Show files", run: () => ws.openTool("files") },
          { id: "tool-details", label: "Show project details", run: () => ws.openTool("details") },
        ];
        if (ws.canMoveToOtherSide(active)) out.push({ id: "move", label: "Move tab to the other side", detail: name, shortcut: `${MOD}\\`, run: () => ws.moveToOtherSide(active) });
        if (ws.canSplitRight(active)) out.push({ id: "split", label: "Split right", detail: name, run: () => ws.splitRight(active) });
        if (L.closable(active)) out.push({ id: "close", label: "Close tab", detail: name, shortcut: `${MOD}W`, run: () => ws.requestClose([active]) });
        if (L.allTabs(layoutRef.current).length > 1) out.push({ id: "close-others", label: "Close other tabs", detail: name, run: () => ws.closeOthers(active) });
        if (layoutRef.current.groups.length > 1 && !ws.narrow) out.push({ id: "equalize", label: "Make groups equal width", run: () => ws.equalize() });
        return out;
      },
      tabs: () => {
        const groups = layoutRef.current.groups;
        const side = (i: number) => (groups.length === 1 ? undefined : i === 0 ? "left" : i === groups.length - 1 ? "right" : "middle");
        return groups.flatMap((g, i) =>
          g.tabs.map((t) => ({ id: `tab:${t}`, label: label(t), detail: side(i), run: () => valueRef.current.activate(t) })),
        );
      },
    };
    nav.setWorkspace(api);
    return () => nav.setWorkspace(null);
  }, [nav]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace outside WorkspaceProvider");
  return ctx;
}

/** Null outside a project workspace (e.g. a transcript embedded elsewhere). */
export function useOptionalWorkspace(): WorkspaceValue | null {
  return useContext(WorkspaceContext);
}
