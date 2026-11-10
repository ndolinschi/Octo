import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { allTabs, focusedGroup, type Group } from "../../state/workspace/layout";
import { MIN_GROUP, useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { panelClass } from "../shell/Panel";
import { Divider } from "./Divider";
import { DragLayer } from "./DragLayer";
import { domId } from "./ids";
import { TabStrip } from "./TabStrip";
import { TabView } from "./TabView";

const SIDES = ["Left", "Middle", "Right"];

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
    const ro = new ResizeObserver(([entry]) => setDockWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [setDockWidth]);

  const { groups } = ws.layout;
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1">
      {groups.map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && !ws.narrow && <Divider index={i - 1} value={groups[i - 1].size} />}
          <GroupView group={g} name={groupName(i, groups.length)} />
        </Fragment>
      ))}
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

function GroupView({ group, name }: { group: Group; name: string }) {
  const ws = useWorkspace();
  const visited = useVisited(group);
  const focused = group.id === ws.layout.focused;
  const narrow = ws.narrow;
  const hidden = narrow && !focused;
  const strip = narrow ? { tabs: allTabs(ws.layout), active: focusedGroup(ws.layout).active } : { tabs: group.tabs, active: group.active };

  return (
    <section
      data-dock-group={group.id}
      aria-label={narrow ? "Workspace" : name === "Workspace" ? name : `${name} group`}
      hidden={hidden}
      style={narrow ? undefined : { flex: `${group.size} 1 0px`, minWidth: MIN_GROUP }}
      onPointerDownCapture={() => ws.focusGroup(group.id)}
      onFocusCapture={() => ws.focusGroup(group.id)}
      className={cn(panelClass, narrow && "flex-1")}
    >
      <TabStrip label={narrow || name === "Workspace" ? "Tabs" : `${name} group tabs`} tabs={strip.tabs} active={strip.active} focused={focused} />
      <div data-dock-body className="relative min-h-0 flex-1">
        {group.tabs
          .filter((t) => visited.has(t))
          .map((t) => (
            <div
              key={t}
              id={`${domId(t)}-panel`}
              role="tabpanel"
              aria-labelledby={`${domId(t)}-tab`}
              hidden={t !== group.active}
              className="absolute inset-0 flex flex-col"
            >
              <TabView tab={t} />
            </div>
          ))}
      </div>
    </section>
  );
}
