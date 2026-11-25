/**
 * Decision 78: a tab's group can take the whole dock. The layout (sizes, tabs, active tabs) is never touched by
 * maximising: the other groups are only hidden, so restoring brings back exactly what was there. The maximised group is a
 * plain group id kept next to the layout; these functions say when it still means something. Pure.
 */

import { activate, groupOf, type Layout, type TabId } from "./layout";

/** The group that is on the whole dock now, or null: it must exist, hold the focus, and the dock must not be in narrow mode. */
export function maximisedGroup(layout: Layout, id: string | null, narrow: boolean): string | null {
  if (id === null || narrow) return null;
  return layout.focused === id && layout.groups.some((g) => g.id === id) ? id : null;
}

/**
 * Maximises the group of `tab` (and makes the tab its active one), or restores when that group already is maximised.
 * `on` forces one way. A tab that is not open changes nothing.
 */
export function toggleMaximise(layout: Layout, current: string | null, tab: TabId, on?: boolean): { layout: Layout; maximised: string | null } {
  const g = groupOf(layout, tab);
  if (!g) return { layout, maximised: current };
  const want = on ?? current !== g.id;
  if (!want) return { layout, maximised: current === g.id ? null : current };
  return { layout: activate(layout, tab), maximised: g.id };
}
