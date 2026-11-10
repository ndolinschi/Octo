import { X } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useOptionalComments } from "../../state/comments";
import { CommentCount, commentsDescription } from "../files/CommentCount";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useScrollFade } from "../../lib/hooks";
import { useCode } from "../../state/code";
import { useProject } from "../../state/project";
import { closable, type TabId } from "../../state/workspace/layout";
import { MOD, useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { pressTab, useDrag } from "./drag";
import { domId } from "./ids";
import { tabInfo } from "./tabInfo";
import { SidebarToggle } from "../shell/SidebarToggle";
import { WorkspaceActions } from "./WorkspaceActions";

/**
 * One group's tab strip (or, when narrow, every tab in one strip): 36px, the tabs 8px from the panel's
 * top and sides (the pane inset), 4 apart. Tab anatomy (28px, radius 6, 96–200px wide):
 * 8 [16px icon slot] 8 [label] 8 … [16px trailing slot] 8 — the same 8px at both ends, and every tab
 * reserves the trailing slot (close, unsaved or working dot; empty on an idle Chat tab), so a short label
 * never hugs an edge and all tabs share one anatomy. Overflow scrolls
 * sideways with faded edges. The first strip starts
 * with "Show sidebar" while the sidebar is hidden; the last ends with the project's global actions.
 * Roving focus: ←/→/Home/End move and select, Delete closes, Shift+F10 or the context-menu key opens
 * the tab menu. Middle-click closes.
 */
export function TabStrip(props: { label: string; tabs: TabId[]; active: TabId; focused: boolean; first: boolean; last: boolean }) {
  const ws = useWorkspace();
  const code = useCode();
  const { state, project } = useProject();
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ tab: TabId; x: number; y: number } | null>(null);
  const drag = useDrag();
  const counts = useOptionalComments()?.counts;
  const ctx = { state, orchestratorId: project?.orchestrator_agent_id, file: code.file, comments: (key: string) => counts?.get(key) ?? 0 };

  const button = (tab: TabId) => list.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(tab)}"]`) ?? null;

  /* Overflow: fade whichever end has more tabs, and keep the selected tab in view. */
  const updateFade = useScrollFade(list, "x");
  useLayoutEffect(() => {
    const el = list.current;
    const tab = button(props.active)?.parentElement;
    if (el && tab) {
      const left = tab.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft + 8) el.scrollLeft = left - 8;
      else if (left + tab.offsetWidth > el.scrollLeft + el.clientWidth - 8) el.scrollLeft = left + tab.offsetWidth - el.clientWidth + 8;
    }
    updateFade();
  }, [props.active, props.tabs, updateFade]);
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
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const menuItems = (tab: TabId): MenuItem[] => {
    const items: MenuItem[] = [];
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
    );
    return items;
  };

  return (
    <div data-strip className="flex shrink-0 items-center gap-1 px-pane pt-pane">
      {props.first && <SidebarToggle />}
      <div
        ref={list}
        role="tablist"
        aria-label={props.label}
        onWheel={(e) => {
          if (list.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) list.current.scrollLeft += e.deltaY;
        }}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto fade-x"
      >
        {props.tabs.map((tab, i) => {
          const info = tabInfo(tab, ctx);
          const selected = tab === props.active;
          const canClose = closable(tab);
          const Icon = info.icon;
          // Every tab reserves the trailing slot (close / state), so all tabs share one anatomy.
          const trailing = true;
          return (
            <div
              key={tab}
              data-tab-wrapper
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                ws.activate(tab);
                pressTab(e, ws, tab, info.label);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && canClose) {
                  e.preventDefault();
                  ws.requestClose([tab]);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenuAt(tab, e.clientX, e.clientY);
              }}
              className={cn(
                "group/tab relative flex h-row w-max max-w-[200px] min-w-24 shrink-0 items-center rounded-sm press-row",
                selected ? (props.focused ? "bg-active text-fg" : "bg-hover text-fg") : "text-fg-3 hover:bg-hover hover:text-fg-2",
                drag?.tab === tab && "opacity-50",
              )}
            >
              <button
                type="button"
                role="tab"
                id={`${domId(tab)}-tab`}
                data-tab-id={tab}
                data-label={info.name ?? info.label}
                aria-selected={selected}
                aria-controls={`${domId(tab)}-panel`}
                tabIndex={selected ? 0 : -1}
                title={info.title}
                aria-description={commentsDescription(info.comments)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-sm focus-inset"
              >
                <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                  <Glyph icon={Icon} size={14} />
                </span>
                <span className="min-w-0 truncate" aria-hidden={info.name ? true : undefined}>
                  {info.label}
                </span>
                {info.name && <span className="sr-only">{info.name}</span>}
                {info.comments > 0 && <CommentCount count={info.comments} />}
                {info.status === "modified" && <span className="sr-only"> (unsaved)</span>}
                {info.status === "running" && <span className="sr-only"> (working)</span>}
              </button>
              {/* Trailing slot: a 16px box 8px from the edge, mirroring the leading icon slot. */}
              {trailing && (
                <span className="relative mr-2 grid size-4 shrink-0 place-items-center">
                  {info.status && (
                    <span
                      aria-hidden
                      data-testid={info.status === "modified" ? "modified-dot" : undefined}
                      className={cn(
                        "size-1.5 rounded-full",
                        info.status === "running" ? "bg-accent" : "bg-fg-2",
                        canClose && "group-focus-within/tab:invisible group-hover/tab:invisible",
                      )}
                    />
                  )}
                  {canClose && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Close ${info.name ?? info.label}`}
                      title={`Close ${info.label}`}
                      data-shortcut={`${MOD}W`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => ws.requestClose([tab])}
                      className={cn(
                        // 16px glyph box, 24px hit area (the ::before overhangs by 4px).
                        "absolute inset-0 grid place-items-center rounded-sm text-fg-3 before:absolute before:-inset-1 before:content-[''] hover:bg-hover hover:text-fg",
                        selected && !info.status ? "" : "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100",
                      )}
                    >
                      <Glyph icon={X} size={14} />
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {props.last && <WorkspaceActions />}
      <Presence show={menu !== null} exitMs={0}>
        {menu && <Menu label="Tab actions" x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />}
      </Presence>
    </div>
  );
}
