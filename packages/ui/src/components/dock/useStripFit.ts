import { useLayoutEffect, useState, type RefObject } from "react";
import { stripPlan, TAB_GAP, tabWant } from "../../state/workspace/tabStrip";

/**
 * Each laid-out tab's parts and whole title, without the close place (`data-tab-label` is the truncating span of `Tab`; its
 * `::after` holds the title in the active weight). Independent of the width the tab has now, so hiding or squeezing tabs
 * cannot change the answer (C2: no measure → change → measure loop). Rounded up, plus 1, so a tab drawn at its measured
 * width never truncates its title by a sub-pixel.
 */
function measureNaturals(list: HTMLElement): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of list.querySelectorAll<HTMLElement>("[data-tab-wrapper]")) {
    const button = w.querySelector<HTMLElement>('[role="tab"]');
    const label = w.querySelector<HTMLElement>("[data-tab-label]");
    const id = button?.dataset.tabId;
    if (!button || !label || !id || button.offsetWidth === 0) continue;
    // Summed from the button's parts, not from its own width: the button stretches to the tab's minimum, and a natural width
    // read from a stretched button would hold that minimum in place.
    const css = getComputedStyle(button);
    const parts = [...button.children].filter((c): c is HTMLElement => c instanceof HTMLElement && getComputedStyle(c).position !== "absolute");
    const content = parts.reduce((sum, c) => sum + (c === label ? label.scrollWidth : c.getBoundingClientRect().width), 0);
    const gaps = (parseFloat(css.columnGap) || 0) * Math.max(0, parts.length - 1);
    out.set(id, Math.ceil((parseFloat(css.paddingLeft) || 0) + (parseFloat(css.paddingRight) || 0) + gaps + content) + 1);
  }
  return out;
}

/**
 * Decision 90 and C2: measures every shown tab's natural width (kept for tabs that are hidden later, so the strip can decide
 * what to show from numbers alone) and, from `room` (what the tabs have), says whether the pinned command buttons fold into
 * the "Run" menu and whether inactive tabs give up their reserved close place. `signature` changes with any title.
 */
export function useStripFit(list: RefObject<HTMLElement | null>, room: number, signature: string, tabs: readonly string[]) {
  const [naturals, setNaturals] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [pinned, setPinned] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const now = measureNaturals(el);
      setNaturals((prev) => {
        let changed = false;
        for (const [id, w] of now) if (prev.get(id) !== w) changed = true;
        if (!changed) return prev;
        const next = new Map(prev);
        for (const [id, w] of now) next.set(id, w);
        return next;
      });
    };
    // Natural widths depend on tab titles (`signature`) and loaded fonts, not the strip's container width.
    measure();
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) measure();
    });
    return () => {
      alive = false;
    };
  }, [list, signature]);
  // What every tab would take unconstrained (gaps included); 0 until each has been measured once.
  let wanted = 0;
  for (const t of tabs) {
    const n = naturals.get(t);
    if (n === undefined) {
      wanted = 0;
      break;
    }
    wanted += tabWant(n, true);
  }
  if (wanted > 0) wanted += TAB_GAP * Math.max(0, tabs.length - 1);
  const plan = stripPlan({ room, wanted, pinned, collapsed });
  // Derived from measurements already in state: adjusted while rendering, not in an effect.
  if (plan.collapse !== collapsed) setCollapsed(plan.collapse);
  return { collapse: plan.collapse, overlay: plan.overlay, setPinned, naturals };
}
