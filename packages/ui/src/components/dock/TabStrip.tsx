import { X } from "lucide-react";
import { useOptionalComments } from "../../state/comments";
import { CommentCount, commentsDescription } from "../files/CommentCount";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useCode } from "../../state/code";
import { useProject } from "../../state/project";
import { closable, type TabId } from "../../state/workspace/layout";
import { MOD, useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { pressTab, useDrag } from "./drag";
import { domId } from "./ids";
import { tabInfo } from "./tabInfo";


/**
 * One group's tab strip (or, when narrow, every tab in one strip). Compact text tabs with a kind
 * icon; overflow scrolls sideways with faded edges. Roving focus: ←/→/Home/End move and select,
 * Delete closes, Shift+F10 or the context-menu key opens the tab menu. Middle-click closes.
 */
export function TabStrip(props: { label: string; tabs: TabId[]; active: TabId; focused: boolean }) {
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
  const updateFade = useCallback(() => {
    const el = list.current;
    if (!el) return;
    const fade = [el.scrollLeft > 1 && "start", el.scrollLeft + el.clientWidth < el.scrollWidth - 1 && "end"].filter(Boolean).join(" ");
    if ((el.dataset.fade ?? "") !== fade) el.dataset.fade = fade;
  }, []);
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
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(updateFade);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFade]);

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
    const go = (j: number) => {
      const next = props.tabs[(j + props.tabs.length) % props.tabs.length];
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
    <div data-strip className="flex h-9 shrink-0 items-center px-1.5">
      <div
        ref={list}
        role="tablist"
        aria-label={props.label}
        onScroll={updateFade}
        onWheel={(e) => {
          if (list.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) list.current.scrollLeft += e.deltaY;
        }}
        className="fade-x flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
      >
        {props.tabs.map((tab, i) => {
          const info = tabInfo(tab, ctx);
          const selected = tab === props.active;
          const canClose = closable(tab);
          const Icon = info.icon;
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
                "group/tab press-row relative flex h-7 max-w-[220px] min-w-0 shrink-0 items-center rounded-sm",
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
                className="flex h-full min-w-0 items-center gap-1.5 rounded-sm pr-0.5 pl-2 text-sm focus-inset"
              >
                <Icon size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate" aria-hidden={info.name ? true : undefined}>
                  {info.label}
                </span>
                {info.name && <span className="sr-only">{info.name}</span>}
                {info.comments > 0 && <CommentCount count={info.comments} />}
                {info.status === "modified" && <span className="sr-only"> (unsaved)</span>}
                {info.status === "running" && <span className="sr-only"> (working)</span>}
              </button>
              <span className="relative mr-1 grid size-4 shrink-0 place-items-center">
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
                      "absolute inset-0 grid place-items-center rounded-xs text-fg-3 before:absolute before:-inset-1 before:content-[''] hover:bg-hover hover:text-fg",
                      selected && !info.status ? "" : "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100",
                    )}
                  >
                    <X size={12} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <Presence show={menu !== null} exitMs={0}>
        {menu && <Menu label="Tab actions" x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />}
      </Presence>
    </div>
  );
}
