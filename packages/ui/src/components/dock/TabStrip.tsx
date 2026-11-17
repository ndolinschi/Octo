import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { flushSync } from "react-dom";
import { useOptionalComments } from "../../state/comments";
import { getBrowserTabPins, getBrowserTabState, useBrowserTabsRevision } from "../../state/browserTabs";
import { getTerminalTabState, useTerminalTabsRevision } from "../../state/terminalTabs";
import { useLatest, useScrollFade } from "../../lib/hooks";
import { useCode } from "../../state/code";
import { useProject } from "../../state/project";
import { closable, toolTab, type TabId } from "../../state/workspace/layout";
import { SIDE_PAD, useChrome } from "../../state/chrome";
import { ProjectActions, ProjectTeamLine } from "../shell/ProjectBar";
import { endPlan, fitStrip, slotShift, TAB_MIN, tabFloor } from "../../state/workspace/tabStrip";
import { MOD, useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Presence } from "../primitives/Presence";
import { dragStep, pressTab, takeSettle, useDrag } from "./drag";
import { tabButton } from "../../state/workspace/ids";
import { tabInfo } from "./tabInfo";
import { Tab } from "./Tab";
import { useStripFit } from "./useStripFit";
import { type FileKey } from "../../lib/files";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Glyph } from "../primitives/Glyph";
import { StateGlyph } from "../primitives/StateGlyph";
/** The "+" picker and the all-tabs list load when first opened (their own chunks). */
const TabPicker = lazy(() => import("./TabPicker").then((m) => ({ default: m.TabPicker })));
/** The project's commands (decision 68): the pinned buttons and "Run" menu next to the project actions; loads after first paint. */
const ProjectCommands = lazy(() => import("../commands/ProjectCommands"));
/** The tab context menu builds on first use (its own chunk). */
const TabMenu = lazy(() => import("./TabMenu"));
const AllTabsPicker = lazy(() => import("./AllTabsPicker").then((m) => ({ default: m.AllTabsPicker })));

/**
 * Round 3: narrow — how far the strip's direct children (laid out at their widths now, the tabs box at its minimum) run past
 * the strip's content box; 0 when they fit. Summed from the children's own widths, not from `scrollWidth`, which also counts
 * absolutely placed and invisible parts and changes with the fold it is meant to decide.
 */
function stripShortfall(el: HTMLElement): number {
  const css = getComputedStyle(el);
  const gap = parseFloat(css.columnGap) || 0;
  const inner = el.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
  const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && getComputedStyle(c).position !== "absolute");
  const used = kids.reduce((sum, c) => sum + c.offsetWidth, 0) + gap * Math.max(0, kids.length - 1);
  return Math.max(0, Math.round(used - inner));
}

/** Room the "+" takes after the tabs (28 + the 4px gap), and the "All tabs" button ("+N ⌄": 53px with one digit, + the gap). */
const PLUS_ROOM = 32;
const ALL_TABS_ROOM = 58;
/** Its second digit (ten or more tabs in the strip). */
const ALL_TABS_DIGIT = 8;
/** Clear of the 20px edge fade, so the selected tab's label and close button are never under it. */
const SCROLL_MARGIN = 24;

/**
 * One group's tab strip (or, when narrow, every tab in one strip): the group's slice of the window's top row (decision 67),
 * 40px on the window's background above the content card, the tabs 8px from the sides, 4 apart. `startInset`: room the first
 * group leaves for the window buttons while the sidebar is closed. The strip holding the conversation shows its sub-agents
 * after the "+"; the last strip ends with the project's actions. Decision 25: tabs share the strip (up to 200px, evenly down to 96, then icon-only beside a 96px active
 * tab, then the strip scrolls with the wheel and faded edges, the active tab kept in view); drag to reorder with live
 * displacement, to another strip or a group body (`drag.ts`); middle-click closes. The first strip starts with "Show
 * sidebar" while the sidebar is hidden; the last ends with the project's global actions. Roving focus: ←/→/Home/End
 * move and select, Delete closes, Shift+F10 or the context-menu key opens the tab menu.
 */
export function TabStrip(props: {
  label: string;
  groupId: string;
  tabs: TabId[];
  active: TabId;
  focused: boolean;
  last: boolean;
  startInset: number;
  /** This group has the whole dock (decision 78): the strip offers "Restore". */ maximised: boolean;
}) {
  const ws = useWorkspace();
  const { insetEnd } = useChrome();
  const code = useCode();
  const { state, project, projectId } = useProject();
  useBrowserTabsRevision(projectId);
  useTerminalTabsRevision(projectId);
  const list = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [room, setRoom] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  // Round 3: narrow — the strip's own width too: its tabs box never measures below TAB_MIN + the "+", so `room` alone does not say that the end cluster pushed past the edge.
  const [stripWidth, setStripWidth] = useState(0);
  useLayoutEffect(() => {
    const w = wrap.current;
    const st = strip.current;
    if (!w) return;
    const measure = () => {
      setRoom(w.clientWidth);
      if (st) setStripWidth(st.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(w);
    if (st) ro.observe(st);
    measure();
    return () => ro.disconnect();
  }, []);
  // Decision 90, narrow strips: what "N agents" gives back when it folds, measured from the end of this strip.
  // `short`: how far the strip's content runs past its edge now (0 when it fits), taken off `room` before deciding.
  const [ends, setEnds] = useState({ agents: 0, short: 0 });
  const [compactAgents, setCompactAgents] = useState(false);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const label = el.querySelector<HTMLElement>("[data-team-label]");
    const next = {
      agents: label ? label.offsetWidth : 0,
      short: stripShortfall(el),
    };
    setEnds((e) => (e.agents === next.agents && e.short === next.short ? e : next));
    // The lazy commands arrive and the strip's width changes (`room`), a fold flips: measure again.
  }, [room, stripWidth, compactAgents, props.tabs.length]);
  const [menu, setMenu] = useState<{ tab: TabId; x: number; y: number } | null>(null);
  const drag = useDrag();
  const counts = useOptionalComments()?.counts;
  const ctx = {
    state,
    projectName: project?.name,
    orchestratorId: project?.orchestrator_agent_id,
    chatSessionId: ws.chatSessionId,
    file: code.file,
    comments: (key: FileKey) => counts?.get(key) ?? 0,
    runStatus: (name: string) => ws.runStatuses[name.toLowerCase()] ?? null,
    browser: (id: string) => {
      const b = getBrowserTabState(projectId, id);
      return { url: b.url, title: b.title, pins: getBrowserTabPins(projectId, id) };
    },
    terminal: (id: string) => getTerminalTabState(projectId, id),
  };

  // Tab count and the active tab do not change during a drag, so sizes hold still under the pointer. The tabs get the
  // strip minus the "+" (decision 25: it follows the last tab) and, once some are hidden, the "All tabs" button.
  const reserved = PLUS_ROOM;
  const infos = new Map(props.tabs.map((t) => [t, tabInfo(t, ctx)]));
  const signature = props.tabs
    .map((t) => {
      const i = infos.get(t);
      return `${t}|${i?.label}|${i?.detail ?? ""}|${i?.comments}`;
    })
    .join("\n");
  const fit = useStripFit(list, room - reserved, signature, props.tabs);
  // C2 (V3): only whole tabs. A tab keeps its close place unless the strip is short (decision 90); the active and the pinned
  // Orchestrator tab always show; the rest show by recency while they fit at their floor, and "All tabs" (+N) lists the others.
  const allRoom = ALL_TABS_ROOM + (props.tabs.length > 10 ? ALL_TABS_DIGIT : 0);
  const keepsClose = (t: TabId) => !fit.overlay || t === props.active || infos.get(t)?.status === "modified";
  const { shown, hidden } = fitStrip({
    room: room - reserved,
    tabs: props.tabs.map((t) => ({ id: t, natural: fit.naturals.get(t), close: keepsClose(t), keep: t === props.active || !closable(t) })),
    recent: ws.recentOf(props.tabs),
    allRoom,
  });
  const overflow = hidden > 0;
  const shownKey = shown.join("\n");
  const shownNow = useLatest(shown);
  const { stripShown } = ws;
  useLayoutEffect(() => {
    stripShown(props.groupId, overflow ? shownNow.current : null);
    return () => stripShown(props.groupId, null);
  }, [stripShown, props.groupId, overflow, shownKey, shownNow]);
  const end = endPlan({
    room: room - reserved - ends.short,
    tabs: props.tabs.length,
    agents: ends.agents,
    agentsCompact: compactAgents,
  });
  // Derived from measurements already in state: adjusted while rendering, not in an effect.
  if (end.agentsCompact !== compactAgents) setCompactAgents(end.agentsCompact);
  // Decision 90: the review's own header carries the commands (run in its worktree), so the top row does not repeat them.
  const reviewActive = ws.layout.groups.some((g) => g.active === toolTab("review"));
  const listWidth = room > 0 ? room - reserved - (overflow ? allRoom : 0) : 0;
  const pickerHere = ws.picker !== null && ws.picker.group === props.groupId;
  const button = (tab: TabId) => (list.current ? tabButton(list.current, tab) : null);

  /* Overflow: fade whichever end has more tabs, and keep the selected tab in view. */
  const updateFade = useScrollFade(list, "x");
  useLayoutEffect(() => {
    const el = list.current;
    const tab = button(props.active)?.parentElement;
    if (el && tab) {
      const left = tab.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft + SCROLL_MARGIN) el.scrollLeft = left - SCROLL_MARGIN;
      else if (left + tab.offsetWidth > el.scrollLeft + el.clientWidth - SCROLL_MARGIN) el.scrollLeft = left + tab.offsetWidth - el.clientWidth + SCROLL_MARGIN;
    }
    updateFade();
    // A dropped or cancelled tab settles from where it was drawn into its slot.
    for (const t of props.tabs) {
      const settle = takeSettle(t);
      const wrapper = button(t)?.parentElement;
      if (!settle || !wrapper || matchMedia("(prefers-reduced-motion: reduce)").matches) continue;
      const dx = settle.left - wrapper.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5)
        wrapper.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: settle.ms, easing: "cubic-bezier(0.2,0,0,1)" });
    }
  }, [props.active, props.tabs, updateFade, listWidth]);
  // Ctrl/Cmd+T opens the picker on the focused group's "+": it must exist before the popover anchors to it.
  useLayoutEffect(() => {
    if (pickerHere) plus.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pickerHere]);
  // After a keyboard move or close, the tab that now holds the selection takes focus.
  useEffect(() => {
    if (ws.focusRequest && props.tabs.includes(ws.focusRequest.tab)) button(ws.focusRequest.tab)?.focus();
  }, [ws.focusRequest, props.tabs]);

  const openMenuAt = (tab: TabId, x: number, y: number) => {
    ws.activate(tab);
    setMenu({ tab, x, y });
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const tab = props.tabs[i];
    if (tab === undefined) return;
    const go = (j: number) => {
      const next = props.tabs[(j + props.tabs.length) % props.tabs.length];
      if (next === undefined) return;
      // C2: the next tab may be one the strip hides; activating shows it, so render before focusing its button.
      flushSync(() => ws.activate(next));
      button(next)?.focus();
    };
    const keys: Record<string, () => void> = {
      ArrowRight: () => go(i + 1),
      ArrowLeft: () => go(i - 1),
      Home: () => go(0),
      End: () => go(props.tabs.length - 1),
      Delete: () => ws.requestClose([tab]),
    };
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(tab, r.left, r.bottom + 4);
      return;
    }
    const fn = e.ctrlKey || e.metaKey || e.altKey ? undefined : keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const shiftOf = (tab: TabId, i: number): number => {
    if (!drag) return 0;
    if (drag.tab === tab) return drag.attached ? drag.dx : 0;
    if (drag.slot?.group !== props.groupId) return 0;
    return slotShift(i, drag.fromGroup === props.groupId ? drag.fromIndex : -1, drag.slot.index, dragStep(drag));
  };

  return (
    <div
      ref={strip}
      data-strip
      data-drag-region
      className="relative flex h-bar shrink-0 items-center gap-1 px-pane"
      style={{
        ...(props.startInset > 0 ? { paddingInlineStart: props.startInset } : {}),
        ...(props.last && insetEnd > SIDE_PAD ? { paddingInlineEnd: insetEnd } : {}),
      }}
    >
      {/* Polish step 2 (F3): the tabs' box never measures 0 — at least one tab and the "+" — so a strip whose end cluster is
          wider than the strip still has a `room` to fold the cluster against (endPlan and useStripFit do nothing at 0). */}
      <div ref={wrap} className="flex min-w-0 flex-1 items-center gap-1" style={{ minWidth: TAB_MIN + PLUS_ROOM }}>
        <div
          ref={list}
          role="tablist"
          aria-label={props.label}
          data-tab-list
          onWheel={(e) => {
            if (list.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) list.current.scrollLeft += e.deltaY;
          }}
          style={listWidth > 0 ? { maxWidth: listWidth } : undefined}
          className="flex min-w-0 shrink items-center gap-1 overflow-x-auto fade-x"
        >
          {shown.map((tab, i) => {
            const info = infos.get(tab) ?? tabInfo(tab, ctx);
            const natural = fit.naturals.get(tab);
            return (
              <Tab
                key={tab}
                tab={tab}
                info={info}
                selected={tab === props.active}
                focusedGroup={props.focused}
                shift={shiftOf(tab, i)}
                overlayClose={fit.overlay}
                minWidth={natural === undefined ? TAB_MIN : tabFloor(natural, keepsClose(tab))}
                dragging={!drag ? null : drag.tab === tab ? (drag.attached ? "self-attached" : "self-detached") : "other"}
                onPress={(e) => {
                  if (e.button !== 0) return;
                  // Rendered before the drag measures anything: activating can widen an icon-only tab.
                  flushSync(() => ws.activate(tab));
                  pressTab(e, ws, tab, info.label);
                }}
                onClose={() => ws.requestClose([tab])}
                onMaximise={() => ws.toggleMaximise(tab)}
                onMenu={(x, y) => openMenuAt(tab, x, y)}
                onKeyDown={(e) => onKeyDown(e, props.tabs.indexOf(tab))}
              />
            );
          })}
        </div>
        <IconButton
          ref={plus}
          icon={Plus}
          label="Open a tab"
          title={`Open a tool, session, file or agent (${MOD}T)`}
          data-tab-plus
          aria-haspopup="dialog"
          aria-expanded={pickerHere}
          className={cn("shrink-0", pickerHere && "bg-active text-fg")}
          onClick={() => (pickerHere ? ws.closePicker() : ws.openPicker(props.groupId))}
        />
        {overflow && (
          // C2 (V3): how many tabs the strip does not show; the list has every tab of the strip.
          <Button
            ref={allButton}
            variant="quiet"
            size="sm"
            iconEnd={ChevronDown}
            aria-label={`All tabs (${hidden} more)`}
            title={`${hidden} more ${hidden === 1 ? "tab" : "tabs"}`}
            data-all-tabs
            aria-haspopup="dialog"
            aria-expanded={allOpen}
            onClick={() => setAllOpen((o) => !o)}
            className={cn("shrink-0 tabular-nums", allOpen && "bg-active text-fg")}
          >
            {`+${hidden}`}
          </Button>
        )}
      </div>
      {/* Decision 91g: the sub-agents are one quiet "N agents" button at the end of the strip, before the commands. Polish step 2
          (F3): it opens the window's one end cluster (agents, pinned commands, Run, "⋯") in the last strip, so with a side group it
          no longer floats alone at the end of the conversation's strip. */}
      {props.last && <ProjectTeamLine compact={compactAgents} />}
      {props.last && (
        <Suspense fallback={null}>
          {/* The "Restore" control of a maximised group lives in this chunk too (decision 78): the initial bundle has no room for it. */}
          <ProjectCommands
            onRestore={props.maximised ? () => ws.toggleMaximise(props.active, false) : null}
            hideCommands={reviewActive}
            collapsePinned={fit.collapse}
            onPinnedWidth={fit.setPinned}
          />
        </Suspense>
      )}
      {props.last && <ProjectActions />}
      <Presence show={pickerHere} exitMs={0}>
        {pickerHere && (
          <Suspense fallback={null}>
            <TabPicker key={ws.picker?.n} anchor={plus} onClose={ws.closePicker} />
          </Suspense>
        )}
      </Presence>
      <Presence show={allOpen} exitMs={0}>
        {allOpen && (
          <Suspense fallback={null}>
            <AllTabsPicker
              anchor={allButton}
              onClose={() => setAllOpen(false)}
              rows={props.tabs.map((t) => {
                const info = tabInfo(t, ctx);
                return {
                  id: t,
                  label: info.name ?? info.label,
                  title: info.title,
                  checked: t === props.active,
                  lead: info.glyph ? <StateGlyph state={info.glyph} /> : <Glyph icon={info.icon} size={14} />,
                  run: () => {
                    ws.activate(t);
                    requestAnimationFrame(() => button(t)?.focus());
                  },
                };
              })}
            />
          </Suspense>
        )}
      </Presence>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Suspense fallback={null}>
            <TabMenu
              tab={menu.tab}
              x={menu.x}
              y={menu.y}
              tabs={props.tabs}
              maximised={props.maximised && menu.tab === props.active}
              onClose={() => setMenu(null)}
            />
          </Suspense>
        )}
      </Presence>
    </div>
  );
}
