import { CHAT_MIN_WIDTH, EDITOR_MIN_GROUP, GROUP_GAP, MIN_GROUP } from "../../lib/constants";
import { parseTab, type TabId } from "./layout";

/**
 * Decision 67, width floors. A group holding the conversation is at least `CHAT_MIN_WIDTH` wide, one holding a file or the
 * Files tool `EDITOR_MIN_GROUP`, anything else (lists) `MIN_GROUP`. The widest requirement among a group's tabs wins, so a
 * tab that moves in never makes its group narrower than that tab can read.
 */
export function groupFloor(tabs: readonly TabId[]): number {
  let floor = MIN_GROUP;
  for (const tab of tabs) {
    const ref = parseTab(tab);
    if (!ref) continue;
    if (ref.kind === "chat") return CHAT_MIN_WIDTH;
    if (ref.kind === "file" || (ref.kind === "tool" && ref.tool === "files")) floor = Math.max(floor, EDITOR_MIN_GROUP);
  }
  return floor;
}

/** The width the groups need side by side (their floors and the gaps between them). */
export function dockNeeds(groups: readonly { tabs: readonly TabId[] }[]): number {
  return groups.reduce((sum, g) => sum + groupFloor(g.tabs), 0) + Math.max(0, groups.length - 1) * GROUP_GAP;
}

/** Whether the groups all get their floor in `width` px (an unmeasured dock, width 0, fits). */
export function dockFits(groups: readonly { tabs: readonly TabId[] }[], width: number): boolean {
  return groups.length < 2 || width <= 0 || width >= dockNeeds(groups);
}
