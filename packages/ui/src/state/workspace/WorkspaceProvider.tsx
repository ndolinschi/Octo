import { focusSoon, focusSurfaceSoon } from "../../lib/focus";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMediaQuery, useLatest } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { loadPref, numberCodec, PREFS, usePersistentState, writePref } from "../../lib/storage";
import { useNav, type WorkspaceApi, type WorkspaceCommand } from "../nav";
import { useProject } from "../project";
import * as L from "./layout";
import type { Layout, TabId, ToolTab } from "./layout";
import {
  DOCKED_QUERY,
  MIN_GROUP,
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
import { jumpIndex, mruOrder, mruTouch, pushClosed, takeClosed, toMoveIndex, type Closed } from "./tabStrip";
import { useTabKeys } from "./useTabKeys";
import { domId, tabButton } from "./ids";
import { DEFAULT_USAGE_VIEW } from "../../lib/usageView";
import { type FileKey, keyFolder } from "../../lib/files";

/** Modifier as shown in shortcut hints. */
export { MOD_LABEL as MOD } from "../../lib/keys";
import { MOD_LABEL } from "../../lib/keys";

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
};

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
  /** Activates the `step`-th tab of the focused group in most-recently-used order (Ctrl+Tab while Ctrl is held). */
  cycle(step: number, order: TabId[]): void;
  /** The focused group's tabs in most-recently-used order (taken when a Ctrl+Tab walk starts). */
  mruOrder(): TabId[];
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
  attachCode(link: CodeLink | null): void;
};

/** The remembered conversation width beside a side group (px). */
const CHAT_SPLIT_CODEC = numberCodec(MIN_GROUP, 4000, CHAT_SPLIT_DEFAULT);

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

/**
 * The dock of one project: tab groups, what is open where, persistence, routing and the
 * keyboard shortcuts. Layout operations are the pure functions in `layout.ts`.
 */
export function WorkspaceProvider({ routeAgentId, onSettings, children }: { routeAgentId: string | null; onSettings(): void; children: ReactNode }) {
  const nav = useNav();
  const { projectId, project, state, clearSide } = useProject();
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
  const cycling = useRef(false);
  const [closedTabs, setClosedTabs] = useState<Closed<TabId>[]>([]);
  const selfNav = useRef<string | null>(null);

  const n = layout.groups.length;
  const narrow = !docked || (n > 1 && dockWidth > 0 && dockWidth < n * MIN_GROUP + (n - 1) * GROUP_GAP);
  const narrowRef = useLatest(narrow);
  const widthRef = useLatest(dockWidth);

  /** Applies a layout; when the focused tab is a conversation its route goes into the URL. */
  const commit = useCallback(
    (next: Layout, options: { route?: boolean; focusTab?: TabId } = {}) => {
      if (next === layoutRef.current && !options.focusTab) return;
      layoutRef.current = next;
      setLayout(next);
      const { focusTab } = options;
      if (focusTab) setFocusRequest((r) => ({ tab: focusTab, n: (r?.n ?? 0) + 1 }));
      const active = L.focusedGroup(next).active;
      if (!cycling.current) mru.current = mruTouch(mru.current, active);
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
    [projectId, setLayout],
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
    return Math.min(1 - MIN_GROUP / inner, Math.max(FILE_GROUP_MIN_FRACTION, 1 - chat / inner));
  }, [widthRef]);

  const doClose = useCallback(
    (tabs: TabId[]) => {
      const current = layoutRef.current;
      const entries = tabs.flatMap((t) => {
        const g = L.groupOf(current, t);
        return g && L.closable(t) ? [{ tab: t, group: g.id, index: g.tabs.indexOf(t) }] : [];
      });
      for (const t of tabs) {
        const ref = L.parseTab(t);
        if (ref?.kind === "file") code.current?.close(ref.key);
      }
      setClosedTabs((stack) => pushClosed(stack, entries));
      // Decision 40: closing the side question clears it unless it was pinned ("Keep").
      if (tabs.includes(L.toolTab("side")) && !memory.get(L.toolTab("side"), SIDE_PINNED)) void clearSide().catch(() => undefined);
      const next = L.close(current, tabs);
      // Decision 35: focus never falls to the page — the tab that becomes active takes it (also after a pointer close).
      commit(next, { focusTab: L.focusedGroup(next).active });
    },
    [commit, memory, clearSide],
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
      picker,
      openPicker: (group) => {
        const current = layoutRef.current;
        // Narrow: one strip shows every tab, so the picker opens there whatever group is focused.
        const target = narrowRef.current ? (current.groups[0]?.id ?? current.focused) : (group ?? current.focused);
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
        const tab = L.toolTab(tool);
        // Decision 35: the opened tool takes focus (the header button that opened it may re-mount in another strip).
        // The side question's input takes the caret (Ctrl/Cmd+; means "ask now").
        if (tool === "side") focusSoon(() => document.getElementById("octo-side-input"), { timeout: 3000 });
        else if (tool !== "files") focusSurfaceSoon(() => document.getElementById(`${domId(tab)}-panel`));
        const roomy = tool === "files" || tool === "changes";
        openSide(tab, roomy ? fileFraction() : toolFraction());
        if (roomy) {
          const g = L.groupOf(layoutRef.current, tab);
          if (g && !g.tabs.includes(L.CHAT) && g.size < FILE_GROUP_MIN_FRACTION)
            commit(L.ensureSize(layoutRef.current, g.id, FILE_GROUP_MIN_FRACTION), { route: false });
        }
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
        const g = L.groupOf(layoutRef.current, L.fileTab(key));
        if (g && !g.tabs.includes(L.CHAT) && g.size < FILE_GROUP_MIN_FRACTION)
          commit(L.ensureSize(layoutRef.current, g.id, FILE_GROUP_MIN_FRACTION), { route: false });
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
        commit(L.moveToOtherSide(layoutRef.current, tab), { focusTab: tab });
      },
      canSplitRight: (tab) => {
        const g = L.groupOf(layout, tab);
        return !narrow && !!g && L.canSplit(layout, tab, g.id) && dockWidth >= (n + 1) * MIN_GROUP + n * GROUP_GAP;
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
          (from.tabs.length === 1 && from.id !== target.group ? true : dockWidth >= (n + 1) * MIN_GROUP + n * GROUP_GAP)
        );
      },
      // A dropped tab keeps focus on its own button (the drag moved it: its old button is gone).
      drop: (tab, target) => {
        const current = layoutRef.current;
        if (target.kind === "strip") commit(L.move(current, tab, target.group, target.index), { focusTab: tab });
        else if (target.kind === "into") commit(L.move(current, tab, target.group), { focusTab: tab });
        else commit(L.split(current, tab, target.group, target.side), { focusTab: tab });
        // The drag ends after the move: if that left focus on nothing, the moved tab's button takes it.
        focusSoon(() => tabButton(document, tab), { onlyIfLost: true, delay: 80 });
      },
      resize: (index, px) => {
        const inner = widthRef.current - (layoutRef.current.groups.length - 1) * GROUP_GAP;
        if (inner <= 0) return;
        const next = L.resize(layoutRef.current, index, px / inner, MIN_GROUP / inner);
        commit(next);
        // Decision 60: where the user puts the divider between the conversation and its one neighbour is where the next first split opens.
        const [first] = next.groups;
        if (next.groups.length === 2 && index === 0 && first && first.tabs.includes(L.CHAT))
          writePref(PREFS.chatSplit, CHAT_SPLIT_CODEC.stringify(first.size * inner));
      },
      equalize: () => commit(L.equalize(layoutRef.current)),
      walkGroup: () => (narrowRef.current ? "all" : L.focusedGroup(layoutRef.current).id),
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
      canReopen: closedTabs.length > 0,
      reopenClosed: () => {
        const { entry, rest } = takeClosed(closedTabs, (t) => Boolean(L.groupOf(layoutRef.current, t)));
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
      attachCode: (link) => {
        code.current = link;
      },
    };
  }, [
    fileFraction,
    projectId,
    project,
    layout,
    narrow,
    dockWidth,
    n,
    lastConversation,
    focusRequest,
    memory,
    closing,
    picker,
    closedTabs,
    onSettings,
    commit,
    openAgent,
    openSide,
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
  const handled = useRef<string | null>(routeAgentId === null ? "" : null);
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

  /* ---------- a tool asked for before this workspace mounted (Home → Usage) ---------- */

  const toolAsked = useRef(false);
  useEffect(() => {
    if (toolAsked.current) return;
    toolAsked.current = true;
    const asked = nav.takePendingTool(projectId);
    if (!asked) return;
    memory.set(L.toolTab(asked.tool), USAGE_VIEW, { ...DEFAULT_USAGE_VIEW, scope: asked.scope });
    value.openTool(asked.tool);
  }, [nav, projectId, memory, value]);

  /* ---------- stale tabs ---------- */

  useEffect(() => {
    if (!agentsLoaded || !project) return;
    const folders = new Set(project.folders.map((f) => f.label));
    const next = L.prune(layoutRef.current, (tab) => {
      const ref = L.parseTab(tab);
      if (ref?.kind === "agent") return Boolean(state.agents[ref.agentId]);
      if (ref?.kind === "file") return folders.has(keyFolder(ref.key));
      return true;
    });
    if (next !== layoutRef.current) commit(next, { route: false });
  }, [agentsLoaded, project, state.agents, commit]);

  /* ---------- keyboard (decision 25) ---------- */

  const valueRef = useLatest(value);
  const keyTarget = useCallback(() => focusedTab() ?? L.focusedGroup(layoutRef.current).active, []);
  useTabKeys(valueRef, keyTarget);

  /* ---------- palette ---------- */

  useEffect(() => {
    const label = (tab: TabId) => tabButton(document, tab)?.dataset.label ?? tab;
    const api: WorkspaceApi = {
      openAgent: (id) => valueRef.current.openAgent(id),
      focusChat: () => valueRef.current.focusChat(),
      openTool: (tool) => valueRef.current.openTool(tool),
      actions: () => {
        const ws = valueRef.current;
        const active = L.focusedGroup(layoutRef.current).active;
        const name = label(active);
        const out: WorkspaceCommand[] = [
          { id: "tool-agents", label: "Show agents", run: () => ws.openTool("agents") },
          { id: "tool-notes", label: "Show notes", run: () => ws.openTool("notes") },
          { id: "tool-files", label: "Show files", run: () => ws.openTool("files") },
          { id: "tool-details", label: "Show project details", run: () => ws.openTool("details") },
          { id: "tool-changes", label: "Show changes", detail: "what the agents changed", run: () => ws.openTool("changes") },
          { id: "tool-review", label: "Review a pull request", detail: "pick one, read it, comment, submit", run: () => ws.openTool("review") },
          { id: "tool-memory", label: "Show memory", detail: "what the project remembers", run: () => ws.openTool("memory") },
          { id: "tool-usage", label: "Show usage", detail: "tokens, cost, limits", run: () => ws.openTool("usage") },
          { id: "tool-side", label: "Ask a side question", detail: "not added to the conversation", shortcut: `${MOD_LABEL};`, run: () => ws.openTool("side") },
          { id: "new-tab", label: "Open a tab…", detail: "tools, files, agents", shortcut: `${MOD_LABEL}T`, run: () => ws.openPicker() },
        ];
        if (ws.canMoveToOtherSide(active))
          out.push({ id: "move", label: "Move tab to the other side", detail: name, shortcut: `${MOD_LABEL}\\`, run: () => ws.moveToOtherSide(active) });
        if (ws.canSplitRight(active)) out.push({ id: "split", label: "Split right", detail: name, run: () => ws.splitRight(active) });
        if (L.closable(active)) out.push({ id: "close", label: "Close tab", detail: name, shortcut: `${MOD_LABEL}W`, run: () => ws.requestClose([active]) });
        if (L.allTabs(layoutRef.current).length > 1)
          out.push({ id: "close-others", label: "Close other tabs", detail: name, run: () => ws.closeOthers(active) });
        if (layoutRef.current.groups.length > 1 && !ws.narrow) out.push({ id: "equalize", label: "Make groups equal width", run: () => ws.equalize() });
        return out;
      },
      tabs: () => {
        const groups = layoutRef.current.groups;
        const side = (i: number) => (groups.length === 1 ? undefined : i === 0 ? "left" : i === groups.length - 1 ? "right" : "middle");
        return groups.flatMap((g, i) => {
          const where = side(i);
          return g.tabs.map((t) => ({
            id: `tab:${t}`,
            label: label(t),
            ...(where === undefined ? {} : { detail: where }),
            run: () => valueRef.current.activate(t),
          }));
        });
      },
    };
    nav.setWorkspace(api);
    return () => nav.setWorkspace(null);
  }, [nav, valueRef]);

  return <WorkspaceContextProvider value={value}>{children}</WorkspaceContextProvider>;
}
