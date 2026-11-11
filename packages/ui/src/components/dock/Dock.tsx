import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../state/app";
import { BackdropProvider, type Backdrop } from "../primitives/backdrop";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_EMPTY } from "../../lib/streakPresets";
import { cn } from "../../lib/cn";
import { allTabs, focusedGroup, type Group } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { panelClass } from "../shell/Panel";
import { Divider } from "./Divider";
import { DragLayer } from "./DragLayer";
import { GroupProvider } from "../../state/workspace/group";
import { domId } from "../../state/workspace/ids";
import { TabStrip } from "./TabStrip";
import { TabView } from "./TabView";
import { MIN_GROUP } from "../../lib/constants";

const SIDES: readonly [string, string, string] = ["Left", "Middle", "Right"];

function groupName(index: number, count: number): string {
  if (count === 1) return "Workspace";
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
        return (
          <Fragment key={g.id}>
            {before && !ws.narrow && <Divider index={i - 1} value={before.size} />}
            <GroupView group={g} name={groupName(i, groups.length)} first={i === 0 || ws.narrow} last={i === groups.length - 1 || ws.narrow} />
          </Fragment>
        );
      })}
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

function GroupView({ group, name, first, last }: { group: Group; name: string; first: boolean; last: boolean }) {
  const ws = useWorkspace();
  const visited = useVisited(group);
  const focused = group.id === ws.layout.focused;
  const narrow = ws.narrow;
  const hidden = narrow && !focused;
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
    <section
      data-dock-group={group.id}
      aria-label={narrow ? "Workspace" : name === "Workspace" ? name : `${name} group`}
      hidden={hidden}
      style={narrow ? undefined : { flex: `${group.size} 1 0px`, minWidth: MIN_GROUP }}
      onPointerDownCapture={() => ws.focusGroup(group.id)}
      onFocusCapture={() => ws.focusGroup(group.id)}
      className={cn(panelClass, "relative", narrow && "flex-1")}
    >
      {backdrops.has(strip.active) && (
        <>
          {appBackdrop !== "off" && <StreakLayer preset={STREAK_EMPTY} theme={theme} mono={appBackdrop === "mono"} />}
          {/* Under the tab strip and the header the band fades behind a soft panel wash (no edge), so their text keeps
              ≥ 4.5:1 while the light still runs up to the panel's top edge. */}
          <div aria-hidden className="octo-streak-topfade pointer-events-none absolute inset-x-0 top-0" />
        </>
      )}
      <GroupProvider group={group}>
        <TabStrip
          label={narrow || name === "Workspace" ? "Tabs" : `${name} group tabs`}
          groupId={group.id}
          tabs={strip.tabs}
          active={strip.active}
          focused={focused}
          first={first}
          last={last}
        />
        <BackdropProvider value={backdrop}>
          <div data-dock-body className="relative min-h-0 flex-1">
            {group.tabs
              .filter((t) => visited.has(t))
              .map((t) => (
                <div
                  key={t}
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
      </GroupProvider>
    </section>
  );
}
