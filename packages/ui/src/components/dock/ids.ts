import type { TabId } from "../../state/workspace/layout";

const ids = new Map<TabId, string>();

/** A stable, attribute-safe id per tab (tab ids contain ":" and NUL), for aria-controls/labelledby. */
export function domId(tab: TabId): string {
  let id = ids.get(tab);
  if (!id) {
    id = `dock-${(ids.size + 1).toString(36)}`;
    ids.set(tab, id);
  }
  return id;
}
