/**
 * Item 15: two terminal tabs must not share a title. Pure; it lives with the terminal (its own chunk) so the app's first
 * load does not carry it: the session store writes each tab's number into its tab state (`state/terminalTabs`).
 *
 * Tabs that share a name (`terminalTabName`) are numbered in the order they were opened: the first keeps its name, the next
 * get 2, 3, … One entry per name given (in open order): its number, 0 when it needs none.
 */
export function terminalOrdinals(names: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n > 1 ? n : 0;
  });
}
