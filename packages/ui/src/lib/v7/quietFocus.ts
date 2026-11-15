/**
 * 7g: focus an element for the keyboard without drawing its ring: a card that takes focus as it appears is where A / D /
 * Enter go, but a programmatic focus is not the person's, so the ring waits for their first key (or goes with the focus).
 * The element's focus style skips `[data-quiet-focus]`.
 */
export function quietFocus(el: HTMLElement): void {
  el.dataset.quietFocus = "";
  const clear = () => {
    delete el.dataset.quietFocus;
    el.removeEventListener("keydown", clear);
    el.removeEventListener("blur", clear);
  };
  el.addEventListener("keydown", clear);
  el.addEventListener("blur", clear);
  el.focus({ preventScroll: true });
}

/** The approvals that already took focus once in this window: a card that mounts again (a moved tab) does not take it again. */
export const FOCUSED_ONCE = new Set<string>();
