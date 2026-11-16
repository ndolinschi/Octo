import { CHAT_MIN_WIDTH, EDITOR_MIN_GROUP, GROUP_GAP, MIN_GROUP } from "../../lib/constants";
import { parseTab, type TabId } from "./layout";

/**
 * Decision 67, width floors. A group holding the conversation is at least `CHAT_MIN_WIDTH` wide, one holding a file or the
 * Files tool `EDITOR_MIN_GROUP`, anything else (lists) `MIN_GROUP`. The widest requirement among a group's tabs wins, so a
 * tab that moves in never makes its group narrower than that tab can read.
 */
export function groupFloor(tabs: readonly TabId[], treeColumn = 0): number {
  let floor = MIN_GROUP;
  for (const tab of tabs) {
    const ref = parseTab(tab);
    if (!ref) continue;
    if (ref.kind === "chat") return CHAT_MIN_WIDTH;
    if (ref.kind === "file" || (ref.kind === "tool" && ref.tool === "files")) floor = Math.max(floor, EDITOR_MIN_GROUP + treeColumn);
    if (ref.kind === "browser" || (ref.kind === "tool" && ref.tool === "browser")) floor = Math.max(floor, EDITOR_MIN_GROUP);
  }
  return floor;
}

/**
 * Decision 94a: a file group that shows its tree column needs the column plus the editor's `EDITOR_MIN_GROUP`
 * (`treeColumn(id)` is the column's width, 0 when hidden). The dock honours those floors while all of them fit in `width`
 * (the divider stops there); when they do not, the groups fall back to the plain floors and the file views show their tree
 * as a page instead. Not measured yet (width 0): the plain floors.
 */
export function groupFloors(groups: readonly { id: string; tabs: readonly TabId[] }[], width: number, treeColumn: (groupId: string) => number): number[] {
  const withTree = groups.map((g) => groupFloor(g.tabs, treeColumn(g.id)));
  const need = withTree.reduce((a, b) => a + b, 0) + Math.max(0, groups.length - 1) * GROUP_GAP;
  return width > 0 && need <= width ? withTree : groups.map((g) => groupFloor(g.tabs));
}

/** The width the groups need side by side (their floors and the gaps between them). */
export function dockNeeds(groups: readonly { tabs: readonly TabId[] }[]): number {
  return groups.reduce((sum, g) => sum + groupFloor(g.tabs), 0) + Math.max(0, groups.length - 1) * GROUP_GAP;
}

/** Whether the groups all get their floor in `width` px (an unmeasured dock, width 0, fits). */
export function dockFits(groups: readonly { tabs: readonly TabId[] }[], width: number): boolean {
  return groups.length < 2 || width <= 0 || width >= dockNeeds(groups);
}
