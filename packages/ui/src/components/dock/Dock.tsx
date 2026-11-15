import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../state/app";
import { BackdropProvider, type Backdrop } from "../primitives/backdrop";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_EMPTY } from "../../lib/streakPresets";
import { cn } from "../../lib/cn";
import { allTabs, focusedGroup, parseTab, type Group, type TabId } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { panelClass } from "../shell/Panel";
import { DragLayer } from "./DragLayer";
import { GroupProvider } from "../../state/workspace/group";
import { domId } from "../../state/workspace/ids";
import { TabStrip } from "./TabStrip";
import { TabView } from "./TabView";
import { useShell } from "../../state/shell";
import { controlsWidth, useChrome } from "../../state/chrome";
import { DRAWER_QUERY } from "../../lib/constants";
import { useMediaQuery } from "../../lib/hooks";

/** The resize handle between groups loads when a second group exists; until then its 8px gap is an empty box, so nothing moves. */
const Divider = lazy(() => import("./Divider"));

/** Sidebar steps aside and Esc restores, only while a group is maximised (decision 78). */
const MaximiseEffects = lazy(() => import("./MaximiseEffects"));

const SIDES: readonly [string, string, string] = ["Left", "Middle", "Right"];

function groupName(index: number, count: number): string {
  if (count === 1) return "Panels";
  if (index === 0) return SIDES[0];
  return index === count - 1 ? SIDES[2] : count > 3 ? `Middle ${index}` : SIDES[1];
}

/** The area right of the sidebar: tab groups in one row with resize dividers between them. */
export function Dock() {
  const ws = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const { setDockWidth } = ws;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setDockWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setDockWidth]);

  const { groups } = ws.layout;
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1">
      {groups.map((g, i) => {
        const before = groups[i - 1];
        const alone = ws.narrow || ws.maximised !== null;
        return (
          <Fragment key={g.id}>
            {before && !alone && (
              <Suspense fallback={<div className="w-gutter shrink-0" />}>
                <Divider index={i - 1} value={before.size} />
              </Suspense>
            )}
            <GroupView
              group={g}
              name={groupName(i, groups.length)}
              first={i === 0 || alone}
              last={i === groups.length - 1 || alone}
              maximised={ws.maximised === g.id}
              stepAside={ws.maximised !== null && ws.maximised !== g.id}
            />
          </Fragment>
        );
      })}
      {ws.maximised !== null && (
        <Suspense fallback={null}>
          <MaximiseEffects />
        </Suspense>
      )}
      <DragLayer />
    </div>
  );
}

/** Tab views mount on first show and stay mounted (hidden) while the tab stays in this group. */
function useVisited(group: Group): Set<string> {
  const [visited, setVisited] = useState(() => new Set([group.active]));
  const stale = [...visited].some((t) => !group.tabs.includes(t));
  if (!visited.has(group.active) || stale) {
    const next = new Set([...visited].filter((t) => group.tabs.includes(t)));
    next.add(group.active);
    setVisited(next);
  }
  return visited;
}

const isFileTab = (t: TabId) => {
  const ref = parseTab(t);
  return ref?.kind === "file" || (ref?.kind === "tool" && ref.tool === "files");
};

/**
 * Decision 85: a group's file tabs (the Files tab and every File tab) share ONE mounted file view (breadcrumb row, editor, tree
 * column); only its `tab` prop changes. Opening a file therefore re-mounts nothing: the tree keeps its scroll, the overlay its
 * state, Monaco its instance. Returns the file tab the view shows now (the active one, else the one it showed last).
 */
function useFileShellTab(group: Group, visited: Set<string>): TabId | null {
  const [last, setLast] = useState<TabId | null>(null);
  const candidate = isFileTab(group.active)
    ? group.active
    : last !== null && group.tabs.includes(last)
      ? last
      : (group.tabs.find((t) => visited.has(t) && isFileTab(t)) ?? null);
  if (candidate !== last) setLast(candidate);
  return candidate;
}

/** `maximised`: this group has the whole dock; `stepAside`: another one has (hidden, not unmounted: scroll, drafts and widths stay). */
function GroupView(props: { group: Group; name: string; first: boolean; last: boolean; maximised: boolean; stepAside: boolean }) {
  const { group, name, first, last, maximised, stepAside } = props;
  const ws = useWorkspace();
  const { sidebarOpen } = useShell();
  // Round 3: narrow — in drawer mode the sidebar floats over the page, so the window buttons stay over the first strip whether or not the drawer is open.
  const drawer = useMediaQuery(DRAWER_QUERY);
  const { insetStart } = useChrome();
  const visited = useVisited(group);
  const fileShell = useFileShellTab(group, visited);
  const focused = group.id === ws.layout.focused;
  const narrow = ws.narrow;
  const hidden = (narrow && !focused) || stepAside;
  const strip = narrow ? { tabs: allTabs(ws.layout), active: focusedGroup(ws.layout).active } : { tabs: group.tabs, active: group.active };
  const { theme, backdrop: appBackdrop } = useApp();
  const [backdrops, setBackdrops] = useState<ReadonlySet<string>>(() => new Set());
  const backdrop = useMemo<Backdrop>(
    () => ({
      set: (tab, on) =>
        setBackdrops((cur) => {
          if (cur.has(tab) === on) return cur;
          const next = new Set(cur);
          if (on) next.add(tab);
          else next.delete(tab);
          return next;
        }),
    }),
    [],
  );

  return (
    // Decision 67: the group is its tab strip (a slice of the window's top row, on the window's own background) and, under it,
    // the card with the content. The strip of the first group starts after the window buttons while the sidebar is closed.
    <section
      data-dock-group={group.id}
      aria-label={narrow ? "Panels" : name === "Panels" ? name : `${name} panel`}
      hidden={hidden}
      style={narrow ? undefined : maximised ? { flex: "1 1 0px", minWidth: 0 } : { flex: `${group.size} 1 0px`, minWidth: ws.floorOf(group.id) }}
      onPointerDownCapture={() => ws.focusGroup(group.id)}
      onFocusCapture={() => ws.focusGroup(group.id)}
      className={cn("flex min-h-0 min-w-0 flex-col overflow-clip contain-inline-size", narrow && "flex-1")}
    >
      <GroupProvider group={group}>
        <TabStrip
          label={narrow || name === "Panels" ? "Tabs" : `${name} panel tabs`}
          groupId={group.id}
          tabs={strip.tabs}
          active={strip.active}
          focused={focused}
          last={last}
          maximised={maximised}
          startInset={first && (drawer || !sidebarOpen) ? controlsWidth(insetStart) : 0}
        />
        <div className={cn(panelClass, "relative flex-1")}>
          {backdrops.has(strip.active) && (
            <>
              {appBackdrop !== "off" && <StreakLayer preset={STREAK_EMPTY} theme={theme} mono={appBackdrop === "mono"} />}
              {/* Under the card's first row the band fades behind a soft panel wash (no edge), so its text keeps
                  ≥ 4.5:1 while the light still runs up to the card's top edge. */}
              <div aria-hidden className="octo-streak-topfade pointer-events-none absolute inset-x-0 top-0" />
            </>
          )}
          <BackdropProvider value={backdrop}>
            <div data-dock-body className="relative min-h-0 flex-1">
              {group.tabs
                .filter((t) => visited.has(t) && (!isFileTab(t) || t === fileShell))
                .map((t) => (
                  <div
                    key={isFileTab(t) ? "file-shell" : t}
                    id={`${domId(t)}-panel`}
                    role="tabpanel"
                    tabIndex={-1}
                    aria-labelledby={`${domId(t)}-tab`}
                    hidden={t !== group.active}
                    className="absolute inset-0 flex flex-col focus:outline-none focus-visible:shadow-none"
                  >
                    <TabView tab={t} />
                  </div>
                ))}
            </div>
          </BackdropProvider>
        </div>
      </GroupProvider>
    </section>
  );
}
