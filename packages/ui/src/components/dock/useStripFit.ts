import { useLayoutEffect, useState, type RefObject } from "react";
import { stripPlan, TAB_CLOSE_ROOM, TAB_GAP, TAB_MAX, TAB_MIN } from "../../state/workspace/tabStrip";

/**
 * The width the tabs of `list` would take if nothing squeezed them (decision 90): per tab the non-title parts plus the whole
 * title (`data-tab-label` is the truncating span of `Tab`) plus the close place, between `TAB_MIN` and `TAB_MAX`. Independent of
 * the widths they have now, so choosing a narrower layout cannot change the answer. 0 while the list is not laid out.
 */
function tabsWanted(list: HTMLElement): number {
  const wrappers = [...list.querySelectorAll<HTMLElement>("[data-tab-wrapper]")];
  let sum = 0;
  for (const w of wrappers) {
    const button = w.querySelector<HTMLElement>('[role="tab"]');
    const label = w.querySelector<HTMLElement>("[data-tab-label]");
    if (!button || !label || button.offsetWidth === 0) return 0;
    const natural = button.offsetWidth - label.clientWidth + label.scrollWidth + TAB_CLOSE_ROOM;
    sum += Math.min(TAB_MAX, Math.max(TAB_MIN, natural));
  }
  return sum + TAB_GAP * Math.max(0, wrappers.length - 1);
}

/**
 * Decision 90: tabs before commands. Measures what the tabs want and, from `room` (what they have), says whether the pinned
 * command buttons fold into the "Run" menu and whether inactive tabs give up their reserved close place. `signature` changes
 * with any title.
 */
export function useStripFit(list: RefObject<HTMLElement | null>, room: number, signature: string) {
  const [wanted, setWanted] = useState(0);
  const [pinned, setPinned] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const w = tabsWanted(el);
      if (w > 0) setWanted(w);
    };
    // Also when the list's own box changes: fonts arriving and a tab's title changing both move the natural widths.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [list, signature]);
  const plan = stripPlan({ room, wanted, pinned, collapsed });
  // Derived from measurements already in state: adjusted while rendering, not in an effect.
  if (plan.collapse !== collapsed) setCollapsed(plan.collapse);
  return { collapse: plan.collapse, overlay: plan.overlay, setPinned };
}
