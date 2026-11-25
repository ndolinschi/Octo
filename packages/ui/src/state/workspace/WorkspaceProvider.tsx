import { focusSoon, focusSurfaceSoon } from "../../lib/focus";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMediaQuery, useLatest } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { loadPref, numberCodec, PREFS, readPref, usePersistentState, writePref } from "../../lib/storage";
import { lastSessionCodec } from "../projectCache";
import { changedFileCount } from "../../lib/statusBar";
import { isTabEnabled, type TabFeatureFlags } from "../../lib/tabFlags";
import { useApp } from "../app";
import { useNav, type WorkspaceApi } from "../nav";
import { useProject } from "../project";
import { useTabFlags } from "../tabFlags";
import { sessionRoot } from "@octo/agent-client";
import { updateBrowserTabState } from "../browserTabs";
import { closeTerminalTab, getTerminalTabState, terminalTabName, updateTerminalTabState } from "../terminalTabs";
import { hasQueuedSession } from "./sessionsStart";
import * as L from "./layout";
import type { Layout, TabId, ToolTab } from "./layout";
import {
  DOCKED_QUERY,
  CHAT_MIN_WIDTH,
  EDITOR_MIN_GROUP,
  GROUP_GAP,
  TOOL_WIDTH,
  TOOL_GROUP_MAX_FRACTION,
  TOOL_GROUP_UNMEASURED_FRACTION,
  CHAT_SPLIT_DEFAULT,
  FILE_GROUP_MIN_FRACTION,
  PERSIST_LAYOUT_MS,
} from "../../lib/constants";
import { createRequiredContext } from "../../lib/context";
import { SIDE_PINNED, TabMemory, USAGE_VIEW } from "./tabMemory";
import {
  jumpIndex,
  mruOrder,
  mruTouch,
  pushClosed,
  recentPickerTabs,
  shownToLayoutIndex,
  takeClosed,
  toMoveIndex,
  type Closed,
  type RecentTabEntry,
} from "./tabStrip";
import { useTabKeys } from "./useTabKeys";
import { dockFits, dockNeeds, groupFloors } from "./floors";
import { TREE_MIN, useFileView } from "../fileView";
import { maximisedGroup, toggleMaximise } from "./maximise";
import { domId, tabButton } from "./ids";
import { DEFAULT_USAGE_VIEW } from "../../lib/usageView";
import { type FileKey, keyFolder } from "../../lib/files";

/** Modifier as shown in shortcut hints. */
export { MOD_LABEL as MOD } from "../../lib/keys";

/** Where a dragged tab lands. */
export type DropTarget =
  { kind: "strip"; group: string; index: number } | { kind: "into"; group: string } | { kind: "split"; group: string; side: "left" | "right" };

/** What the workspace needs from the open-files state (attached by a component inside CodeProvider). */
export type CodeLink = {
  modified(key: FileKey): boolean;
  name(key: FileKey): string;
  close(key: FileKey): void;
  restore(key: FileKey): void;
  select(key: FileKey): void;
  openFile?(folder: string, path: string, line?: number): void;
};

type Closing = { tabs: TabId[]; files: string[] };

export type WorkspaceValue = {
  projectId: string;
  layout: Layout;
  /** One strip for everything (narrow window or groups that don't fit). */
  narrow: boolean;
  /** Project has blocked memory (`auto_memory === "blocked"`): hide Memory tool from menus and prune open Memory tab. */
  memoryBlocked: boolean;
  /** Whether tool tab `tool` is enabled under current UI tab feature flags and project state (`memoryBlocked`). */
  toolEnabled(tool: ToolTab): boolean;
  /** A group's minimum width in the row (decision 67; 94a: a file group that shows its tree column also needs the column). */
  floorOf(groupId: string): number;
  /** The conversation tab whose live indicator may animate (the one being watched), if visible. */
  watched: TabId | null;
  /** Agent of the conversation last focused (for the agents tree selection). */
  currentAgentId: string | null;
  /**
   * Parallel sessions (decision 96): the main session the conversation tab (Chat) shows — the route's, else the one it showed
   * last, else null (the project's default session).
   */
  chatSessionId: string | null;
  /** The main session of the conversation focused last (Chat's or a session tab's): where the floating composer sends. */
  focusedSessionId: string | null;
  /** Shows main session `sessionId`: its own tab when one is open, else in the conversation tab. */
  showSession(sessionId: string): void;
  /** `/clear` in the conversation of session `from` made session `to`: the tab that showed `from` shows `to`. */
  followSession(from: string | null, to: string): void;
  /** Decision 68: the state of each project command's run tab, by lowercase name (only running and failed are listed). Set by the commands feature. */
  runStatuses: Readonly<Record<string, "running" | "failed">>;
  setRunStatuses(statuses: Readonly<Record<string, "running" | "failed">>): void;
  /** Decision 78: the group that has the whole dock (the others are hidden, not changed), or null. */
  maximised: string | null;
  /** Maximises the group of `tab` (default: the focused tab), or restores when it already is; `on` forces one way. */
  toggleMaximise(tab?: TabId, on?: boolean): void;
  /** A tab whose button should take focus (after a keyboard move or close). */
  focusRequest: { tab: TabId; n: number } | null;
  /** Per-tab view memory (scroll positions, composer draft) that survives remounts. */
  memory: TabMemory;
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
  /** The "+" tab picker (decision 25): open in `group`'s strip (default: the focused group), with a counter so a repeat re-opens. */
  picker: { group: string; n: number } | null;
  openPicker(group?: string): void;
  closePicker(): void;
  /** Opens a file's tab: in `where.group` (in place of `where.replace`) when given, else in the side group. */
  openFileTab(key: FileKey, where?: { group: string; replace?: TabId }): void;
  /** Opens (or focuses) a Browser tab beside the conversation, optionally navigating to `url` or opening a fresh instance. */
  openBrowser(options?: { url?: string; newTab?: boolean; group?: string; browserId?: string }): TabId;
  /** Opens (or focuses) a Terminal tab beside the conversation, optionally targeting `folder` or opening a fresh instance. */
  openTerminal(options?: { folder?: string; newTab?: boolean; group?: string; terminalId?: string }): TabId;
  /** Opens (or focuses) the "Run: name" tab of a project command beside the conversation (decision 68). */
  openRun(name: string): void;
  /** One session in a tab of its own, beside the tab it was opened from (two sessions side by side). */
  openSession(sessionId: string): void;
  /** Opens (or focuses) a tab in a given group. */
  openIn(tab: TabId, groupId: string): void;
  /** Removes a tab without asking (a restored file that no longer exists). */
  dropTab(tab: TabId): void;
  /** Whether `tab` can be closed now (Chat is closable whenever another main session tab is open). */
  canClose(tab: TabId): boolean;
  requestClose(tabs: TabId[]): void;
  confirmClose(): void;
  cancelClose(): void;
  closeOthers(tab: TabId): void;
  tabName(tab: TabId): string | undefined;
  canMoveToOtherSide(tab: TabId): boolean;
  moveToOtherSide(tab: TabId): void;
  canSplitRight(tab: TabId): boolean;
  splitRight(tab: TabId): void;
  canDrop(tab: TabId, target: DropTarget): boolean;
  drop(tab: TabId, target: DropTarget): void;
  /** Moves divider `index` (between group index and index+1) by `px`. */
  resize(index: number, px: number): void;
  equalize(): void;
  /** Activates the `step`-th tab of the focused group in most-recently-used order (Ctrl+Tab while Ctrl is held). */
  cycle(step: number, order: TabId[]): void;
  /** The focused group's tabs in most-recently-used order (taken when a Ctrl+Tab walk starts). */
  mruOrder(): TabId[];
  /** C2: `tabs` most recently used first (never-used ones after, in order): what a short strip keeps shown. */
  recentOf(tabs: readonly TabId[]): TabId[];
  /** C2: the tabs a group's strip shows (null: all), so a drop index measured over them lands in the group's own order. */
  stripShown(group: string, shown: readonly TabId[] | null): void;
  walkGroup(): string;
  /** Ends a Ctrl+Tab walk: the tab it stopped on becomes the most recent. */
  endCycle(): void;
  /** Ctrl/Cmd+1…8 by position, 9 the last (decision 25). */
  jump(digit: number): void;
  /** Moves a tab one slot left / right in its group (Ctrl/Cmd+Shift+PageUp/PageDown). */
  moveBy(tab: TabId, delta: -1 | 1): void;
  closeRight(tab: TabId): void;
  canReopen: boolean;
  /** Ctrl/Cmd+Shift+T: the last closed tab returns to its group and slot (a stack of 20 per project). */
  reopenClosed(): void;
  /** Recent tabs (newest closed first, then MRU open) for the "+" TabPicker. */
  recentTabs(): RecentTabEntry<TabId>[];
  /** Activates an open tab or restores a closed tab to its previous group and slot. */
  reopenTab(tab: TabId): void;
  attachCode(link: CodeLink | null): void;
};

/** The remembered conversation width beside a side group (px). */
const CHAT_SPLIT_CODEC = numberCodec(CHAT_MIN_WIDTH, 4000, CHAT_SPLIT_DEFAULT);

function tabAllowed(ref: L.TabRef | null, tabFlags: TabFeatureFlags, memoryBlocked: boolean): boolean {
  if (ref?.kind === "browser") return tabFlags.browser;
  if (ref?.kind === "terminal") return tabFlags.terminal;
  if (ref?.kind === "tool") return isTabEnabled(tabFlags, ref.tool, { memoryBlocked });
  return true;
}

export const {
  Provider: WorkspaceContextProvider,
  useRequired: useWorkspace,
  useOptional: useOptionalWorkspace,
} = createRequiredContext<WorkspaceValue>("useWorkspace");

/** A keyboard action on a focused tab keeps focus on that tab wherever it lands; this finds it. */
function focusedTab(): TabId | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.getAttribute("role") === "tab" ? L.parseTabId(el.dataset.tabId) : null;
}

/**
 * After a file tab opens from somewhere that may vanish (a tree row of a view the new tab hides, a row in Details),
 * the file's editor or preview takes focus — only if focus fell to nothing (v6.1 review: never `<body>`).
 */
function focusFileSoon(key: FileKey) {
  const panel = `${domId(L.fileTab(key))}-panel`;
  focusSoon(
    () => {
      const el = document.getElementById(panel);
      return el?.querySelector<HTMLElement>(".monaco-editor textarea") ?? el?.querySelector<HTMLElement>("[data-file-focus]");
    },
    // Monaco loads lazily: wait for it a while (only while focus is still on nothing, or on the new tab holding it).
    { onlyIfLost: true, timeout: 5000, holder: () => tabButton(document, L.fileTab(key)) },
  );
}

function conversationOf(tab: TabId): string | null | undefined {
  const ref = L.parseTab(tab);
  if (ref?.kind === "chat") return null;
  if (ref?.kind === "agent") return ref.agentId;
  return undefined;
}

/** The session of a conversation tab: Chat's (`chat`), a session tab's id; undefined for any other tab. */
function sessionOf(tab: TabId, chat: string | null): string | null | undefined {
  const ref = L.parseTab(tab);
  if (ref?.kind === "chat") return chat;
  if (ref?.kind === "session") return ref.sessionId;
  return undefined;
}

/**
 * The dock of one project: tab groups, what is open where, persistence, routing and the
 * keyboard shortcuts. Layout operations are the pure functions in `layout.ts`.
 */
export function WorkspaceProvider({
  routeAgentId,
  routeSessionId = null,
  onSettings,
  children,
}: {
  routeAgentId: string | null;
  routeSessionId?: string | null;
  onSettings(): void;
  children: ReactNode;
}) {
  const nav = useNav();
  const tabFlags = useTabFlags();
  const { projectId, project, state, clearSide, synced } = useProject();
  // Decision 96: `#/p/<pid>/s/<sid>` shows that session; `#/p/<pid>` the one shown last here, else the default.
  const [picked, setChatSessionState] = useState<{ id: string | null; stored: boolean }>(() =>
    routeSessionId !== null ? { id: routeSessionId, stored: false } : { id: loadPref(PREFS.lastSession(projectId), lastSessionCodec), stored: true },
  );
  // A session shown from storage (not asked for by the route) that no longer exists: the default session instead.
  const storedGone = picked.stored && picked.id !== null && synced > 0 && !state.sessions.list.some((x) => x.id === picked.id);
  const chatSession = storedGone ? null : picked.id;
  const chatSessionRef = useLatest(chatSession);
  const effectiveChatId = chatSession ?? state.sessions.defaultId;
  const effectiveChatRef = useLatest(effectiveChatId);
  const sessionsRef = useLatest(state.sessions.list);
  const setChatSession = useCallback(
    (sid: string | null) => {
      chatSessionRef.current = sid;
      effectiveChatRef.current = sid ?? state.sessions.defaultId;
      setChatSessionState({ id: sid, stored: false });
      writePref(PREFS.lastSession(projectId), lastSessionCodec.stringify(sid));
    },
    [projectId, chatSessionRef, effectiveChatRef, state.sessions.defaultId],
  );
  // C3: read before the layout below saves its first value — no saved layout means this is the project's first open here.
  const [firstOpen] = useState(() => readPref(PREFS.layout(projectId)) === null);
  const [layout, setLayout] = usePersistentState(PREFS.layout(projectId), L.layoutCodec, { debounceMs: PERSIST_LAYOUT_MS });
  const layoutRef = useRef(layout);
  const [dockWidth, setDockWidth] = useState(0);
  const docked = useMediaQuery(DOCKED_QUERY);
  const [lastConversation, setLastConversation] = useState<TabId>(L.CHAT);
  const [focusRequest, setFocusRequest] = useState<{ tab: TabId; n: number } | null>(null);
  const [closing, setClosing] = useState<Closing | null>(null);
  const [picker, setPicker] = useState<{ group: string; n: number } | null>(null);
  const [memory] = useState(() => new TabMemory());
  const code = useRef<CodeLink | null>(null);
  const mru = useRef<TabId[]>([]);
  const shownByStrip = useRef(new Map<string, readonly TabId[]>());
  const cycling = useRef(false);
  const [closedTabs, setClosedTabs] = useState<Closed<TabId>[]>([]);
  const selfNav = useRef<string | null>(null);
  const graceTabs = useRef(new Map<string, number>());
  const [maxGroup, setMaxGroup] = useState<string | null>(null);
  const maxRef = useRef<string | null>(null);
  const [runStatuses, setRunStatuses] = useState<WorkspaceValue["runStatuses"]>({});

  const narrow = !docked || !dockFits(layout.groups, dockWidth);
  const { column: treeColumn, focusTree } = useFileView();
  const floors = useMemo(
    () =>
      groupFloors(layout.groups, dockWidth, (id) => {
        const c = treeColumn(id);
        return c.open ? Math.max(TREE_MIN, c.width) : 0;
      }),
    [layout.groups, dockWidth, treeColumn],
  );
  const floorsRef = useLatest(floors);
  const narrowRef = useLatest(narrow);
  const widthRef = useLatest(dockWidth);
  const maximised = maximisedGroup(layout, maxGroup, narrow);

  /** Applies a layout; when the focused tab is a conversation its route goes into the URL. */
  const commit = useCallback(
    (next: Layout, options: { route?: boolean; focusTab?: TabId; force?: boolean } = {}) => {
      if (next === layoutRef.current && !options.focusTab && !options.force) return;
      layoutRef.current = next;
      setLayout(next);
      // Focus leaving the maximised group (a tool opened elsewhere) or the group going away ends it, for good.
      if (maxRef.current !== null && maximisedGroup(next, maxRef.current, false) === null) {
        maxRef.current = null;
        setMaxGroup(null);
      }
      const { focusTab } = options;
      if (focusTab) setFocusRequest((r) => ({ tab: focusTab, n: (r?.n ?? 0) + 1 }));
      const active = L.focusedGroup(next).active;
      if (!cycling.current) mru.current = mruTouch(mru.current, active);
      const agent = conversationOf(active);
      const session = sessionOf(active, chatSessionRef.current);
      if (agent === undefined && session === undefined) return;
      setLastConversation(active);
      if (options.route === false) return;
      const hash = agent ? hrefFor(projectId, agent) : hrefFor(projectId, null, session ?? null);
      if (window.location.hash !== hash) {
        selfNav.current = agent ? `a:${agent}` : session ? `s:${session}` : "";
        window.location.hash = hash;
      }
    },
    [projectId, setLayout, chatSessionRef],
  );

  /** Opens a tab in the side group, creating it right of Chat's group (`fraction` of the row) when there is none. */
  const openSide = useCallback(
    (tab: TabId, fraction?: number) => {
      const current = layoutRef.current;
      const side = L.sideGroup(current);
      const home = L.chatGroupOf(current);
      const target: L.Target = side ? { group: side.id } : { newAfter: home.id, size: fraction ?? home.size / 2 };
      commit(L.open(current, tab, target));
    },
    [commit],
  );

  const toolFraction = useCallback(
    () => (widthRef.current > 0 ? Math.min(TOOL_GROUP_MAX_FRACTION, (TOOL_WIDTH + GROUP_GAP) / widthRef.current) : TOOL_GROUP_UNMEASURED_FRACTION),
    [widthRef],
  );

  /**
   * The share of the row a new file group takes (decision 60): the conversation keeps its remembered width (default 420px)
   * and the file view gets the rest, so opening a file moves the divider once, to where it will stay. Not yet measured: half.
   */
  const fileFraction = useCallback(() => {
    const inner = widthRef.current - GROUP_GAP;
    if (inner <= 0) return undefined;
    const chat = loadPref(PREFS.chatSplit, CHAT_SPLIT_CODEC);
    return Math.min(1 - EDITOR_MIN_GROUP / inner, Math.max(FILE_GROUP_MIN_FRACTION, 1 - chat / inner));
  }, [widthRef]);

  const isMainSessionTab = useCallback(
    (t: TabId): boolean => {
      const r = L.parseTab(t);
      if (r?.kind !== "session") return false;
      const known = sessionsRef.current.find((x) => x.id === r.sessionId);
      return !known || known.kind === "main";
    },
    [sessionsRef],
  );

  const canCloseTab = useCallback(
    (current: Layout, tab: TabId): boolean => {
      if (tab !== L.CHAT) return L.closable(tab);
      return L.allTabs(current).some(isMainSessionTab);
    },
    [isMainSessionTab],
  );

  const doClose = useCallback(
    (tabs: TabId[]) => {
      const current = layoutRef.current;
      const closingChat = tabs.includes(L.CHAT);
      const chatGroup = L.groupOf(current, L.CHAT);
      const survivor = closingChat
        ? (chatGroup?.tabs.find((t) => isMainSessionTab(t) && !tabs.includes(t)) ??
          L.allTabs(current).find((t) => isMainSessionTab(t) && !tabs.includes(t)) ??
          null)
        : null;
      const survivorRef = survivor ? L.parseTab(survivor) : null;
      const survivorSid = survivorRef?.kind === "session" ? survivorRef.sessionId : null;
      const entries = tabs.flatMap((t) => {
        const g = L.groupOf(current, t);
        if (!g) return [];
        if (t === L.CHAT) {
          const oldSid = effectiveChatRef.current;
          return survivorSid && oldSid ? [{ tab: L.sessionTab(oldSid), group: g.id, index: g.tabs.indexOf(t) }] : [];
        }
        return L.closable(t) ? [{ tab: t, group: g.id, index: g.tabs.indexOf(t) }] : [];
      });
      for (const t of tabs) {
        const ref = L.parseTab(t);
        if (ref?.kind === "file") code.current?.close(ref.key);
        else if (ref?.kind === "terminal") closeTerminalTab(projectId, ref.terminalId);
        else if (t === L.toolTab("terminal")) closeTerminalTab(projectId, "default");
      }
      setClosedTabs((stack) => pushClosed(stack, entries));
      // Decision 40: closing the side question clears it unless it was pinned ("Keep").
      if (tabs.includes(L.toolTab("side")) && !memory.get(L.toolTab("side"), SIDE_PINNED)) void clearSide().catch(() => undefined);
      if (survivor && survivorSid) {
        const sGroup = L.groupOf(current, survivor);
        const keepActive = L.focusedGroup(current).active === L.CHAT || L.focusedGroup(current).active === survivor;
        setChatSession(survivorSid);
        let base = sGroup && chatGroup && sGroup.id !== chatGroup.id ? L.move(current, L.CHAT, sGroup.id) : current;
        base = L.close(base, [...tabs.filter((t) => t !== L.CHAT), survivor]);
        if (keepActive) base = L.activate(base, L.CHAT);
        commit(base, { focusTab: L.focusedGroup(base).active, force: true });
        return;
      }
      const next = L.close(current, tabs);
      // Decision 35: focus never falls to the page — the tab that becomes active takes it (also after a pointer close).
      commit(next, { focusTab: L.focusedGroup(next).active });
    },
    [commit, memory, clearSide, projectId, isMainSessionTab, effectiveChatRef, setChatSession],
  );

  const requestClose = useCallback(
    (tabs: TabId[]) => {
      const closableTabs = tabs.filter((t) => canCloseTab(layoutRef.current, t));
      if (!closableTabs.length) return;
      const files = closableTabs.flatMap((t) => {
        const ref = L.parseTab(t);
        return ref?.kind === "file" && code.current?.modified(ref.key) ? [code.current.name(ref.key)] : [];
      });
      if (files.length) setClosing({ tabs: closableTabs, files });
      else doClose(closableTabs);
    },
    [doClose, canCloseTab],
  );

  // Decision 34: an agent opens in a split to the right of the orchestrator, never over it (in one strip when narrow).
  const openAgent = useCallback(
    (agentId: string, options: { otherSide?: boolean; route?: boolean } = {}) => {
      const current = layoutRef.current;
      const tab = L.agentTab(agentId);
      const home = L.chatGroupOf(current);
      const where = L.groupOf(current, tab);
      const route = options.route === undefined ? {} : { route: options.route };
      if (narrowRef.current) return commit(L.open(current, tab, { group: home.id }), route);
      if (where && where.id !== home.id) return commit(L.activate(current, tab), route);
      const target = L.besideChat(current);
      if (where) return commit("group" in target ? L.move(current, tab, target.group) : L.split(current, tab, home.id, "right"), route);
      commit(L.open(current, tab, options.otherSide ? (L.otherSide(current, home.id) ?? target) : target), route);
    },
    [commit, narrowRef],
  );

  const chatRoot = chatSession ? sessionRoot(state, chatSession) : "";
  // C3: on a project's first open, once its recorded changes are known and the dock is measured, a wide window shows
  // Changes beside the conversation (`firstLayout`). Once, then the saved layout decides.
  const { bridge } = useApp();
  const [firstChanges, setFirstChanges] = useState<number | null>(null);
  useEffect(() => {
    if (!firstOpen || !tabFlags.changes || !bridge.listChanges) return;
    let live = true;
    bridge.listChanges(projectId).then(
      (turns) => live && setFirstChanges(changedFileCount(turns)),
      // No readable changes: the project opens without the panel, as it always did; the Changes tab says why when opened.
      () => live && setFirstChanges(0),
    );
    return () => {
      live = false;
    };
  }, [firstOpen, tabFlags.changes, bridge, projectId]);
  const firstDone = useRef(false);
  useEffect(() => {
    if (firstDone.current || firstChanges === null || dockWidth <= 0) return;
    firstDone.current = true;
    if (!tabFlags.changes) return;
    const next = docked
      ? L.firstLayout({ saved: false, window: window.innerWidth, inner: dockWidth - GROUP_GAP, changedFiles: firstChanges, layout: layoutRef.current })
      : null;
    if (next) commit(next, { route: false });
  }, [firstChanges, dockWidth, docked, tabFlags.changes, commit, layoutRef]);

  const value = useMemo<WorkspaceValue>(() => {
    const memoryBlocked = project?.memory?.auto_memory === "blocked";
    const toolEnabled = (tool: ToolTab) => isTabEnabled(tabFlags, tool, { memoryBlocked });
    const ensureRoomy = (tab: TabId) => {
      const g = L.groupOf(layoutRef.current, tab);
      if (g && !g.tabs.includes(L.CHAT) && g.size < FILE_GROUP_MIN_FRACTION)
        commit(L.ensureSize(layoutRef.current, g.id, FILE_GROUP_MIN_FRACTION), { route: false });
    };
    const openMulti = (
      tool: "browser" | "terminal",
      prefix: "b" | "t",
      id: string | undefined,
      newTab: boolean | undefined,
      group: string | undefined,
      makeTab: (id: string) => TabId,
      getId: (r: L.TabRef | null) => string | undefined,
      onMeta?: (id: string) => void,
    ): TabId => {
      if (!tabFlags[tool]) return L.CHAT;
      const cur = layoutRef.current;
      const found =
        !id && !newTab
          ? L.allTabs(cur).find((t) => {
              const r = L.parseTab(t);
              return getId(r) !== undefined || (r?.kind === "tool" && r.tool === tool);
            })
          : undefined;
      const resolved =
        id ?? (newTab ? `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` : (found && getId(L.parseTab(found))) || "default");
      const tab = id || newTab ? makeTab(resolved) : (found ?? L.toolTab(tool));
      onMeta?.(resolved);
      if (group) commit(L.open(cur, tab, { group }));
      else openSide(tab, fileFraction());
      ensureRoomy(tab);
      focusSurfaceSoon(() => document.getElementById(`${domId(tab)}-panel`));
      return tab;
    };
    const isVisible = (tab: TabId) => {
      const g = L.groupOf(layout, tab);
      return !!g && g.active === tab && (maximised !== null ? g.id === maximised : !narrow || g.id === layout.focused);
    };
    const agentOf = conversationOf(lastConversation);
    return {
      projectId,
      layout,
      narrow,
      memoryBlocked,
      toolEnabled,
      floorOf: (groupId) => floors[layout.groups.findIndex((g) => g.id === groupId)] ?? 0,
      watched: isVisible(lastConversation) ? lastConversation : null,
      // Chat's agent is its session's root (decision 96), else the project's default orchestrator.
      currentAgentId: agentOf === undefined ? null : (agentOf ?? (chatRoot || (project?.orchestrator_agent_id ?? null))),
      chatSessionId: chatSession,
      focusedSessionId: sessionOf(lastConversation, chatSession) ?? chatSession,
      showSession: (sessionId) => {
        const current = layoutRef.current;
        if (sessionId === effectiveChatRef.current) return commit(L.activate(current, L.CHAT));
        const tab = L.sessionTab(sessionId);
        if (L.groupOf(current, tab)) return commit(L.activate(current, tab));
        setChatSession(sessionId);
        // Chat may be active already: the route changes all the same (it names the session).
        commit(L.activate(current, L.CHAT), { force: true });
      },
      followSession: (from, to) => {
        const current = layoutRef.current;
        const tab = from === null ? null : L.sessionTab(from);
        if (tab && L.groupOf(current, tab)) {
          if (to === effectiveChatRef.current) return commit(L.activate(L.close(current, [tab]), L.CHAT), { force: true });
          return commit(L.replace(current, tab, L.sessionTab(to)));
        }
        setChatSession(to);
        commit(L.activate(current, L.CHAT), { force: true });
      },
      focusRequest,
      maximised,
      runStatuses,
      setRunStatuses,
      toggleMaximise: (tab, on) => {
        const current = layoutRef.current;
        if (narrowRef.current) return;
        const next = toggleMaximise(current, maxRef.current, tab ?? L.focusedGroup(current).active, on);
        maxRef.current = next.maximised;
        setMaxGroup(next.maximised);
        commit(next.layout, { route: false });
      },
      memory,
      closing,
      picker,
      openPicker: (group) => {
        const current = layoutRef.current;
        // Narrow: only the active group renders the merged strip, so anchor the picker there.
        const target = narrowRef.current ? L.focusedGroup(current).id : (group ?? current.focused);
        setPicker((p) => ({ group: target, n: (p?.n ?? 0) + 1 }));
      },
      closePicker: () => setPicker(null),
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
      // The Files tab is a file view (editor + tree column) and Changes is a list beside a diff: both open at the width of a
      // file (the rest of the row after the conversation), not at a tool's 366px where the diff is cramped.
      openTool: (tool) => {
        if (!toolEnabled(tool)) return;
        const tab = L.toolTab(tool);
        // Decision 35: the opened tool takes focus (the header button that opened it may re-mount in another strip).
        // The side question's input takes the caret (Ctrl/Cmd+; means "ask now"); Files, its tree's filter (a focus request).
        if (tool === "side") focusSoon(() => document.getElementById("octo-side-input"), { timeout: 3000 });
        else if (tool === "files") focusTree();
        else focusSurfaceSoon(() => document.getElementById(`${domId(tab)}-panel`));
        const roomy = tool === "files" || tool === "changes" || tool === "browser" || tool === "terminal" || tool === "processes";
        openSide(tab, roomy ? fileFraction() : toolFraction());
        if (roomy) ensureRoomy(tab);
      },
      // A file needs room: a side group sized for a tool widens to half the row.
      openFileTab: (key, where) => {
        focusFileSoon(key);
        // Decision 35: until the (lazy) file view and its editor are in, the new tab's button holds focus, so it never
        // falls to the page when the row that opened the file goes away with its panel.
        focusSoon(() => tabButton(document, L.fileTab(key)), { onlyIfLost: true, timeout: 1500 });
        if (where) {
          const current = layoutRef.current;
          if (where.replace && L.groupOf(current, where.replace)) return commit(L.replace(current, where.replace, L.fileTab(key)));
          return commit(L.open(current, L.fileTab(key), { group: where.group }));
        }
        openSide(L.fileTab(key), fileFraction());
        ensureRoomy(L.fileTab(key));
      },
      openBrowser: (o) => {
        const url = o?.url;
        return openMulti(
          "browser",
          "b",
          o?.browserId,
          o?.newTab,
          o?.group,
          L.browserTab,
          (r) => (r?.kind === "browser" ? r.browserId : undefined),
          url !== undefined ? (bid) => updateBrowserTabState(projectId, bid, { url }) : undefined,
        );
      },
      openTerminal: (o) => {
        const folder = o?.folder;
        return openMulti(
          "terminal",
          "t",
          o?.terminalId,
          o?.newTab,
          o?.group,
          L.terminalTab,
          (r) => (r?.kind === "terminal" ? r.terminalId : undefined),
          folder !== undefined ? (tid) => updateTerminalTabState(projectId, tid, { folder }) : undefined,
        );
      },
      openRun: (name) => openSide(L.runTab(name), fileFraction()),
      openSession: (sessionId) => {
        const current = layoutRef.current;
        const tab = L.sessionTab(sessionId);
        graceTabs.current.set(sessionId, Date.now() + 15_000);
        if (L.groupOf(current, tab)) return commit(L.activate(current, tab));
        const known = state.sessions.list.find((x) => x.id === sessionId);
        if (known?.kind === "agent") {
          const from = L.groupOf(current, L.toolTab("sessions")) ?? L.chatGroupOf(current);
          const room = !narrowRef.current && current.groups.length === 1 && widthRef.current >= dockNeeds([...current.groups, { tabs: [] }]);
          if (room) return commit(L.open(current, tab, { newAfter: from.id, size: from.size / 2 }));
          return commit(L.open(current, tab, { group: from.id }));
        }
        const curChat = effectiveChatRef.current;
        if (curChat === sessionId || (curChat === null && !L.allTabs(current).some(isMainSessionTab))) {
          if (chatSessionRef.current !== sessionId) setChatSession(sessionId);
          return commit(L.activate(current, L.CHAT), { force: true });
        }
        if (chatSessionRef.current === null && curChat !== null) {
          setChatSession(curChat);
        }
        // Main sessions open as tabs in Chat's group so multiple sessions can be open concurrently.
        commit(L.open(current, tab, { group: L.chatGroupOf(current).id }));
      },
      openIn: (tab, groupId) => {
        const r = L.parseTab(tab);
        if (r?.kind === "session" && r.sessionId === effectiveChatRef.current) {
          return commit(L.activate(layoutRef.current, L.CHAT));
        }
        commit(L.open(layoutRef.current, tab, { group: groupId }));
      },
      dropTab: (tab) => commit(L.close(layoutRef.current, [tab])),
      canClose: (tab) => canCloseTab(layout, tab),
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
      tabName: (tab) => {
        const r = L.parseTab(tab);
        return r?.kind === "terminal" ? terminalTabName(getTerminalTabState(projectId, r.terminalId)) : r?.kind === "browser" ? "Browser" : undefined;
      },
      canMoveToOtherSide: (tab) => {
        const g = L.groupOf(layout, tab);
        return !narrow && !!g && (layout.groups.length > 1 || g.tabs.length > 1);
      },
      moveToOtherSide: (tab) => {
        if (narrowRef.current) return;
        commit(L.moveToOtherSide(layoutRef.current, tab), { focusTab: tab });
      },
      canSplitRight: (tab) => {
        const g = L.groupOf(layout, tab);
        return !narrow && !!g && L.canSplit(layout, tab, g.id) && widthRef.current >= dockNeeds([...layout.groups, { tabs: [] }]);
      },
      splitRight: (tab) => {
        const g = L.groupOf(layoutRef.current, tab);
        if (!g || narrowRef.current) return;
        // Decision 35: the moved tab keeps focus in its new group (a menu's opener is gone after the split).
        commit(L.split(layoutRef.current, tab, g.id, "right"), { focusTab: tab });
      },
      canDrop: (tab, target) => {
        const from = L.groupOf(layout, tab);
        if (!from) return false;
        if (target.kind === "into") return target.group !== from.id;
        if (target.kind === "strip") return true;
        return (
          L.canSplit(layout, tab, target.group) &&
          (from.tabs.length === 1 && from.id !== target.group ? true : widthRef.current >= dockNeeds([...layoutRef.current.groups, { tabs: [] }]))
        );
      },
      // A dropped tab keeps focus on its own button (the drag moved it: its old button is gone).
      drop: (tab, target) => {
        const current = layoutRef.current;
        if (target.kind === "strip") {
          // C2: the drag measured the shown tabs only; hidden ones ("All tabs") keep their places.
          const shown = shownByStrip.current.get(target.group);
          const groupTabs = current.groups.find((g) => g.id === target.group)?.tabs ?? [];
          const index = shown ? shownToLayoutIndex(shown, groupTabs, target.index) : target.index;
          commit(L.move(current, tab, target.group, index), { focusTab: tab });
        } else if (target.kind === "into") commit(L.move(current, tab, target.group), { focusTab: tab });
        else commit(L.split(current, tab, target.group, target.side), { focusTab: tab });
        // The drag ends after the move: if that left focus on nothing, the moved tab's button takes it.
        focusSoon(() => tabButton(document, tab), { onlyIfLost: true, delay: 80 });
      },
      resize: (index, px) => {
        const inner = widthRef.current - (layoutRef.current.groups.length - 1) * GROUP_GAP;
        if (inner <= 0) return;
        const next = L.resize(layoutRef.current, index, px / inner, (floorsRef.current[index] ?? 0) / inner, (floorsRef.current[index + 1] ?? 0) / inner);
        commit(next);
        // Decision 60: where the user puts the divider between the conversation and its one neighbour is where the next first split opens.
        const [first] = next.groups;
        if (next.groups.length === 2 && index === 0 && first && first.tabs.includes(L.CHAT))
          writePref(PREFS.chatSplit, CHAT_SPLIT_CODEC.stringify(first.size * inner));
      },
      equalize: () => commit(L.equalize(layoutRef.current)),
      walkGroup: () => (narrowRef.current ? "all" : L.focusedGroup(layoutRef.current).id),
      recentOf: (tabs) => mruOrder(mru.current, tabs),
      stripShown: (group, shown) => {
        if (shown) shownByStrip.current.set(group, shown);
        else shownByStrip.current.delete(group);
      },
      mruOrder: () => {
        const current = layoutRef.current;
        return mruOrder(mru.current, narrowRef.current ? L.allTabs(current) : L.focusedGroup(current).tabs);
      },
      cycle: (step, order) => {
        const next = order[((step % order.length) + order.length) % order.length];
        if (!next) return;
        cycling.current = true;
        commit(L.activate(layoutRef.current, next), focusedTab() ? { focusTab: next } : {});
      },
      endCycle: () => {
        if (!cycling.current) return;
        cycling.current = false;
        mru.current = mruTouch(mru.current, L.focusedGroup(layoutRef.current).active);
      },
      jump: (digit) => {
        const current = layoutRef.current;
        const tabs = narrowRef.current ? L.allTabs(current) : L.focusedGroup(current).tabs;
        const i = jumpIndex(digit, tabs.length);
        const next = i === null ? undefined : tabs[i];
        if (next) commit(L.activate(current, next), focusedTab() ? { focusTab: next } : {});
      },
      moveBy: (tab, delta) => {
        const current = layoutRef.current;
        const g = L.groupOf(current, tab);
        if (!g || !L.closable(tab)) return;
        const from = g.tabs.indexOf(tab);
        const to = Math.max(g.tabs.includes(L.CHAT) ? 1 : 0, Math.min(g.tabs.length - 1, from + delta));
        if (to !== from) commit(L.move(current, tab, g.id, toMoveIndex(from, to)), { focusTab: tab });
      },
      closeRight: (tab) => {
        const g = L.groupOf(layoutRef.current, tab);
        if (g) requestClose(g.tabs.slice(g.tabs.indexOf(tab) + 1));
      },
      canReopen: closedTabs.some((c) => {
        const r = L.parseTab(c.tab);
        if (r?.kind === "session" && r.sessionId === effectiveChatId) return false;
        return tabAllowed(r, tabFlags, memoryBlocked);
      }),
      reopenClosed: () => {
        const { entry, rest } = takeClosed(closedTabs, (t) => {
          const r = L.parseTab(t);
          if (r?.kind === "session" && r.sessionId === effectiveChatRef.current) return true;
          return !!L.groupOf(layoutRef.current, t) || !tabAllowed(r, tabFlags, memoryBlocked);
        });
        setClosedTabs(rest);
        if (!entry) return;
        const ref = L.parseTab(entry.tab);
        if (ref?.kind === "file") code.current?.restore(ref.key);
        const current = layoutRef.current;
        const group =
          L.groupOf(current, L.CHAT)?.id === entry.group || current.groups.some((g) => g.id === entry.group) ? entry.group : L.chatGroupOf(current).id;
        const opened = L.open(current, entry.tab, { group });
        commit(L.move(opened, entry.tab, group, entry.index), { focusTab: entry.tab });
      },
      recentTabs: () => {
        const current = layoutRef.current;
        const curChat = effectiveChatRef.current;
        return recentPickerTabs({
          closed: curChat ? closedTabs.filter((c) => c.tab !== L.sessionTab(curChat)) : closedTabs,
          mru: mru.current,
          open: new Set(L.allTabs(current)),
          active: L.focusedGroup(current).active,
        });
      },
      reopenTab: (tab) => {
        const ref = L.parseTab(tab);
        if (!tabAllowed(ref, tabFlags, memoryBlocked)) return;
        const current = layoutRef.current;
        if (ref?.kind === "session" && ref.sessionId === effectiveChatRef.current) {
          commit(L.activate(current, L.CHAT));
          return;
        }
        if (L.groupOf(current, tab)) {
          commit(L.activate(current, tab));
          return;
        }
        const idx = [...closedTabs].reverse().findIndex((c) => c.tab === tab);
        const entry = idx >= 0 ? closedTabs[closedTabs.length - 1 - idx] : undefined;
        if (entry) setClosedTabs((stack) => stack.filter((c) => c.tab !== tab));
        if (ref?.kind === "file") code.current?.restore(ref.key);
        const group =
          entry && (L.groupOf(current, L.CHAT)?.id === entry.group || current.groups.some((g) => g.id === entry.group))
            ? entry.group
            : L.focusedGroup(current).id;
        const opened = L.open(current, tab, { group });
        commit(entry ? L.move(opened, tab, group, entry.index) : opened, { focusTab: tab });
      },
      attachCode: (link) => {
        code.current = link;
      },
    };
  }, [
    fileFraction,
    projectId,
    project,
    tabFlags,
    chatRoot,
    chatSession,
    chatSessionRef,
    effectiveChatId,
    effectiveChatRef,
    isMainSessionTab,
    canCloseTab,
    setChatSession,
    state.sessions.list,
    layout,
    narrow,
    floors,
    floorsRef,
    lastConversation,
    focusRequest,
    maximised,
    runStatuses,
    memory,
    closing,
    picker,
    closedTabs,
    onSettings,
    commit,
    openAgent,
    openSide,
    focusTree,
    requestClose,
    doClose,
    narrowRef,
    toolFraction,
    widthRef,
  ]);

  /* ---------- routing ---------- */

  const agentsLoaded = project !== null && state.agentOrder.length > 0;
  // On mount without an agent route the stored layout's active tabs stand (a reload keeps what was showing);
  // a later navigation to the project's bare route shows the orchestrator.
  const routeKey = routeAgentId ? `a:${routeAgentId}` : routeSessionId ? `s:${routeSessionId}` : "";
  const handled = useRef<string | null>(routeAgentId === null && routeSessionId === null ? "" : null);
  const sessionsKnown = synced > 0 || state.sessions.list.length > 0;
  useEffect(() => {
    if (handled.current === routeKey) return;
    if (selfNav.current === routeKey) {
      selfNav.current = null;
      handled.current = routeKey;
      return;
    }
    if (routeSessionId) {
      const current = layoutRef.current;
      if (routeSessionId === effectiveChatRef.current) {
        handled.current = routeKey;
        return commit(L.activate(current, L.CHAT), { route: false });
      }
      const tab = L.sessionTab(routeSessionId);
      if (L.groupOf(current, tab)) {
        handled.current = routeKey;
        return commit(L.activate(current, tab), { route: false });
      }
      if (!sessionsKnown) return;
      handled.current = routeKey;
      const known = state.sessions.list.find((x) => x.id === routeSessionId);
      if (known?.kind === "agent") return value.openSession(routeSessionId);
      const shownInChat = effectiveChatRef.current;
      if (routeSessionId === shownInChat || shownInChat === null || (!known && state.sessions.list.length === 0)) {
        setChatSession(routeSessionId);
        commit(L.activate(current, L.CHAT), { route: false });
        return;
      }
      return value.openSession(routeSessionId);
    }
    if (!routeAgentId) {
      handled.current = routeKey;
      commit(L.activate(layoutRef.current, L.CHAT), { route: false });
      return;
    }
    if (!agentsLoaded) return;
    handled.current = routeKey;
    if (state.agents[routeAgentId]) openAgent(routeAgentId, { route: false });
    else window.location.replace(hrefFor(projectId));
  }, [
    routeKey,
    routeAgentId,
    routeSessionId,
    agentsLoaded,
    sessionsKnown,
    state.agents,
    state.sessions.list,
    effectiveChatRef,
    projectId,
    commit,
    openAgent,
    setChatSession,
    value,
  ]);

  /* ---------- ensure Chat and session:<id> never duplicate the same session ---------- */

  useEffect(() => {
    if (!effectiveChatId) return;
    const dup = L.sessionTab(effectiveChatId);
    if (!L.groupOf(layoutRef.current, dup)) return;
    const wasActive = L.focusedGroup(layoutRef.current).active === dup;
    let next = L.close(layoutRef.current, [dup]);
    if (wasActive) next = L.activate(next, L.CHAT);
    commit(next, { route: false });
  }, [effectiveChatId, layout, commit]);

  /* ---------- a tool asked for before this workspace mounted (Home → Usage) ---------- */

  const toolAsked = useRef(false);
  useEffect(() => {
    if (toolAsked.current) return;
    toolAsked.current = true;
    // The sidebar's session rows (and Memory) ask for the Sessions tab before this workspace mounted.
    if (hasQueuedSession(projectId) && tabFlags.sessions) value.openTool("sessions");
    const asked = nav.takePendingTool(projectId);
    if (!asked || !isTabEnabled(tabFlags, asked.tool)) return;
    memory.set(L.toolTab(asked.tool), USAGE_VIEW, { ...DEFAULT_USAGE_VIEW, scope: asked.scope });
    value.openTool(asked.tool);
  }, [nav, projectId, tabFlags, memory, value]);

  /* ---------- disabled & stale tabs ---------- */

  useEffect(() => {
    const memoryBlocked = project?.memory?.auto_memory === "blocked";
    const next = L.prune(layoutRef.current, (tab) => tabAllowed(L.parseTab(tab), tabFlags, memoryBlocked));
    if (next !== layoutRef.current) commit(next, { route: false });
  }, [tabFlags, project?.memory?.auto_memory, commit]);

  useEffect(() => {
    if (!agentsLoaded || !project) return;
    const folders = new Set(project.folders.map((f) => f.label));
    const commands = new Set((project.commands ?? []).map((c) => c.name.toLowerCase()));
    const knownSessions = synced > 0 ? new Set(state.sessions.list.map((s) => s.id)) : null;
    const memoryBlocked = project.memory?.auto_memory === "blocked";
    const now = Date.now();
    const next = L.prune(layoutRef.current, (tab) => {
      const ref = L.parseTab(tab);
      if (ref?.kind === "agent") return Boolean(state.agents[ref.agentId]);
      if (ref?.kind === "session" && knownSessions) {
        if (knownSessions.has(ref.sessionId)) {
          graceTabs.current.delete(ref.sessionId);
          return true;
        }
        return (graceTabs.current.get(ref.sessionId) ?? 0) > now;
      }
      if (ref?.kind === "file") return folders.has(keyFolder(ref.key));
      // A run tab of a command that was removed or renamed has nothing to show (its runs keep the old name).
      if (ref?.kind === "run") return commands.has(ref.name.toLowerCase());
      return tabAllowed(ref, tabFlags, memoryBlocked);
    });
    if (next !== layoutRef.current) commit(next, { route: false });
  }, [agentsLoaded, project, tabFlags, state.agents, state.sessions.list, synced, commit]);

  useEffect(() => {
    const onReset = (event: Event) => {
      const cleared = (event as CustomEvent<{ cleared?: boolean } | null>).detail?.cleared === true;
      if (!cleared) return;
      graceTabs.current.clear();
      setChatSession(null);
      commit(L.activate(layoutRef.current, L.CHAT), { route: false });
    };
    window.addEventListener("octo:sessions-reset", onReset);
    return () => window.removeEventListener("octo:sessions-reset", onReset);
  }, [setChatSession, commit]);

  /* ---------- keyboard (decision 25) ---------- */

  const valueRef = useLatest(value);
  const keyTarget = useCallback(() => focusedTab() ?? L.focusedGroup(layoutRef.current).active, []);
  useTabKeys(valueRef, keyTarget);

  /* ---------- palette ---------- */

  useEffect(() => {
    const api: WorkspaceApi = {
      openAgent: (id) => valueRef.current.openAgent(id),
      focusChat: () => valueRef.current.focusChat(),
      openTool: (tool) => valueRef.current.openTool(tool),
      openSession: (id) => valueRef.current.openSession(id),
      showSession: (id) => valueRef.current.showSession(id),
      dropTab: (tab) => valueRef.current.dropTab(tab),
      openFile: (folder, path, line) => code.current?.openFile?.(folder, path, line),
      current: () => valueRef.current,
    };
    nav.setWorkspace(api);
    return () => nav.setWorkspace(null);
  }, [nav, valueRef]);

  return <WorkspaceContextProvider value={value}>{children}</WorkspaceContextProvider>;
}
