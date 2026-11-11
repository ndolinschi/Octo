import type { TabId } from "./layout";

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

/**
 * A tab's button under `root`, matched by its `data-tab-id` value (not a CSS selector: file tab ids hold a NUL, which
 * `CSS.escape` turns into U+FFFD, so a selector never matches them).
 */
export function tabButton(root: ParentNode, tab: TabId): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]')) if (el.dataset.tabId === tab) return el;
  return null;
}
