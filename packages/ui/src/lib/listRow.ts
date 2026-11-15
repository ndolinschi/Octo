import type { ControlSize } from "./controls";

/** Row heights of `ListRow`: 28, 32 and 40 (the `xs` 24 of the control scale is for controls, not rows). */
export type RowSize = Exclude<ControlSize, "xs">;

/**
 * The height classes of a row: a fixed height for one line, a minimum for two lines (the second line may wrap the
 * title); under the `touch:` variant every row is at least 40px (it has 16px text and finger targets there).
 */
export function rowHeight(size: RowSize, twoLine: boolean): string {
  if (twoLine) return "min-h-ctl-lg";
  const fixed: Record<RowSize, string> = { sm: "h-ctl-sm touch:h-ctl-lg", md: "h-ctl-md touch:h-ctl-lg", lg: "h-ctl-lg" };
  return fixed[size];
}

/**
 * The ARIA state a row carries for its selection, by the role it plays: an option or tree item uses `aria-selected`; a
 * plain row (a button or link in a nav list) uses `aria-current`; a toggle row uses `aria-pressed`. Nothing is written
 * for an unselected row, so the markup stays quiet.
 */
export function selectionAria(role: string | undefined, selected: boolean): Record<string, string> {
  if (!selected) return role === "option" || role === "treeitem" ? { "aria-selected": "false" } : {};
  if (role === "option" || role === "treeitem" || role === "tab") return { "aria-selected": "true" };
  if (role === "menuitemcheckbox" || role === "menuitemradio") return { "aria-checked": "true" };
  return { "aria-current": "true" };
}

/**
 * The plain text of a row's `meta` node, for its accessible name (6a): a string or number, the text children of elements
 * (a caller may wrap the meta in an `aria-hidden` span for its looks), nothing for a node with no text (a state dot).
 */
export function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    const props: unknown = node.props;
    if (props !== null && typeof props === "object" && "children" in props) return nodeText(props.children);
  }
  return "";
}

/**
 * 6c: a meta that would draw nothing — no node, an empty string, or a wrapper element whose children are empty (the
 * sidebar wraps a missing time in a span). A row then gives its title the whole width. An element with no `children`
 * prop (a state dot) is drawn, so it is not empty.
 */
export function emptyNode(node: unknown): boolean {
  if (node === undefined || node === null || node === false || node === "") return true;
  if (Array.isArray(node)) return node.every(emptyNode);
  if (typeof node === "object" && "props" in node) {
    const props: unknown = node.props;
    return props !== null && typeof props === "object" && "children" in props && emptyNode(props.children);
  }
  return false;
}
