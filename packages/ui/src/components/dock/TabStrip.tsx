import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { flushSync } from "react-dom";
import { useOptionalComments } from "../../state/comments";
import { useScrollFade } from "../../lib/hooks";
import { useCode } from "../../state/code";
import { useProject } from "../../state/project";
import { closable, type TabId } from "../../state/workspace/layout";
import { slotShift, tabSizing } from "../../state/workspace/tabStrip";
import { MOD, useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { dragStep, pressTab, takeSettle, useDrag } from "./drag";
import { tabButton } from "../../state/workspace/ids";
import { tabInfo } from "./tabInfo";
import { Tab } from "./Tab";
import { SidebarToggle } from "../shell/SidebarToggle";
import { type FileKey } from "../../lib/files";
import { ChevronDown, Plus } from "lucide-react";
import { IconButton } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { StateGlyph } from "../primitives/StateGlyph";
/** The "+" picker and the all-tabs list load when first opened (their own chunks). */
const TabPicker = lazy(() => import("./TabPicker").then((m) => ({ default: m.TabPicker })));
const AllTabsPicker = lazy(() => import("./AllTabsPicker").then((m) => ({ default: m.AllTabsPicker })));

/** Room the "+" takes after the tabs (28 + the 4px gap), and the "all tabs" button when the strip scrolls (24 + 4). */
const PLUS_ROOM = 32;
const ALL_TABS_ROOM = 28;
/** Clear of the 20px edge fade, so the selected tab's label and close button are never under it. */
const SCROLL_MARGIN = 24;

/**
 * One group's tab strip (or, when narrow, every tab in one strip): 36px, the tabs 8px from the panel's top and sides,
 * 4 apart. Decision 25: tabs share the strip (up to 200px, evenly down to 96, then icon-only beside a 96px active
 * tab, then the strip scrolls with the wheel and faded edges, the active tab kept in view); drag to reorder with live
 * displacement, to another strip or a group body (`drag.ts`); middle-click closes. The first strip starts with "Show
 * sidebar" while the sidebar is hidden; the last ends with the project's global actions. Roving focus: ←/→/Home/End
 * move and select, Delete closes, Shift+F10 or the context-menu key opens the tab menu.
 */
export function TabStrip(props: { label: string; groupId: string; tabs: TabId[]; active: TabId; focused: boolean; first: boolean; last: boolean }) {
  const ws = useWorkspace();
  const code = useCode();
  const { state, project } = useProject();
  const list = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const measure = () => setRoom(w.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(w);
    measure();
    return () => ro.disconnect();
  }, []);
  const [menu, setMenu] = useState<{ tab: TabId; x: number; y: number } | null>(null);
  const drag = useDrag();
  const counts = useOptionalComments()?.counts;
  const ctx = { state, orchestratorId: project?.orchestrator_agent_id, file: code.file, comments: (key: FileKey) => counts?.get(key) ?? 0 };

  const activeIndex = props.tabs.indexOf(props.active);
  // Tab count and the active tab do not change during a drag, so sizes hold still under the pointer. The tabs get the
  // strip minus the "+" (decision 25: it follows the last tab) and, once they scroll, the "all tabs" button.
  const fits = tabSizing(room - PLUS_ROOM, props.tabs.length, activeIndex);
  const overflow = room > 0 && fits.overflow;
  const size = overflow ? tabSizing(room - PLUS_ROOM - ALL_TABS_ROOM, props.tabs.length, activeIndex) : fits;
  const listWidth = room > 0 ? room - PLUS_ROOM - (overflow ? ALL_TABS_ROOM : 0) : 0;
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
  }, [props.active, props.tabs, updateFade, size.widths]);
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
      ws.activate(next);
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

  const menuItems = (tab: TabId): MenuItem[] => {
    const items: MenuItem[] = [];
    const at = props.tabs.indexOf(tab);
    if (!ws.narrow) {
      items.push(
        { id: "move", label: "Move to the other side", shortcut: `${MOD}\\`, disabled: !ws.canMoveToOtherSide(tab), run: () => ws.moveToOtherSide(tab) },
        { id: "split", label: "Split right", disabled: !ws.canSplitRight(tab), run: () => ws.splitRight(tab) },
        { id: "sep", separator: true },
      );
    }
    items.push(
      { id: "close", label: "Close", shortcut: `${MOD}W`, disabled: !closable(tab), run: () => ws.requestClose([tab]) },
      { id: "others", label: "Close others", disabled: props.tabs.filter((t) => t !== tab && closable(t)).length === 0, run: () => ws.closeOthers(tab) },
      { id: "right", label: "Close tabs to the right", disabled: !props.tabs.slice(at + 1).some(closable), run: () => ws.closeRight(tab) },
      { id: "sep2", separator: true },
      { id: "reopen", label: "Reopen closed tab", shortcut: `${MOD}Shift+T`, disabled: !ws.canReopen, run: () => ws.reopenClosed() },
    );
    return items;
  };

  const shiftOf = (tab: TabId, i: number): number => {
    if (!drag) return 0;
    if (drag.tab === tab) return drag.attached ? drag.dx : 0;
    if (drag.slot?.group !== props.groupId) return 0;
    return slotShift(i, drag.fromGroup === props.groupId ? drag.fromIndex : -1, drag.slot.index, dragStep(drag));
  };

  return (
    <div data-strip className="relative flex shrink-0 items-center gap-1 px-pane pt-pane">
      {props.first && <SidebarToggle />}
      <div ref={wrap} className="flex min-w-0 flex-1 items-center gap-1">
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
          {props.tabs.map((tab, i) => {
            const info = tabInfo(tab, ctx);
            const iconOnly = (size.iconOnly[i] ?? false) && tab !== props.active;
            return (
              <Tab
                key={tab}
                tab={tab}
                info={info}
                selected={tab === props.active}
                focusedGroup={props.focused}
                width={room > 0 ? (size.widths[i] ?? null) : null}
                iconOnly={iconOnly}
                shift={shiftOf(tab, i)}
                dragging={!drag ? null : drag.tab === tab ? (drag.attached ? "self-attached" : "self-detached") : "other"}
                onPress={(e) => {
                  if (e.button !== 0) return;
                  // Rendered before the drag measures anything: activating can widen an icon-only tab.
                  flushSync(() => ws.activate(tab));
                  pressTab(e, ws, tab, info.label);
                }}
                onClose={() => ws.requestClose([tab])}
                onMenu={(x, y) => openMenuAt(tab, x, y)}
                onKeyDown={(e) => onKeyDown(e, i)}
              />
            );
          })}
        </div>
        <IconButton
          ref={plus}
          icon={Plus}
          label="Open a tab"
          title={`Open a tool, file or agent (${MOD}T)`}
          data-tab-plus
          aria-haspopup="dialog"
          aria-expanded={pickerHere}
          className={cn("shrink-0", pickerHere && "bg-active text-fg")}
          onClick={() => (pickerHere ? ws.closePicker() : ws.openPicker(props.groupId))}
        />
        {overflow && (
          <button
            ref={allButton}
            type="button"
            data-all-tabs
            aria-label={`All tabs (${props.tabs.length})`}
            title={`All tabs (${props.tabs.length})`}
            aria-haspopup="dialog"
            aria-expanded={allOpen}
            onClick={() => setAllOpen((o) => !o)}
            className={cn(
              "ml-auto grid h-chip w-6 shrink-0 press place-items-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg",
              allOpen && "bg-active text-fg",
            )}
          >
            <Glyph icon={ChevronDown} size={14} />
          </button>
        )}
      </div>
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
        {menu && <Menu label="Tab actions" x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />}
      </Presence>
    </div>
  );
}
