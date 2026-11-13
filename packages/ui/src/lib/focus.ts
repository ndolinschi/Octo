/**
 * Moves focus to an element that may not exist yet (a tab that is about to mount, a composer behind a
 * closing dialog): looks for it every frame until `timeout`. With `onlyIfLost`, it only acts while focus
 * sits on nothing (the body, or an element that was just removed or hidden), so it never steals focus the user moved.
 */
export function focusSoon(
  find: () => HTMLElement | null | undefined,
  options: {
    timeout?: number;
    delay?: number;
    onlyIfLost?: boolean;
    /** Focus here also counts as lost (a placeholder holder). */ holder?: () => Element | null;
  } = {},
): void {
  const { timeout = 1000, delay = 0, onlyIfLost = false, holder } = options;
  const until = performance.now() + delay + timeout;
  // Lost: nothing focused, or the focused element was removed or hidden (a tab panel that just went away).
  const lost = () => {
    const a = document.activeElement;
    return (
      !a ||
      a === document.body ||
      !a.isConnected ||
      (a instanceof HTMLElement && a.offsetParent === null && a.getClientRects().length === 0) ||
      (holder !== undefined && a === holder())
    );
  };
  const step = () => {
    // Focus still somewhere real: keep watching until the timeout (it may be lost a frame later), never take it.
    if (onlyIfLost && !lost()) {
      if (performance.now() < until) requestAnimationFrame(step);
      return;
    }
    const el = find();
    if (el && el.isConnected && el.offsetParent !== null) {
      el.focus({ preventScroll: true });
      return;
    }
    if (performance.now() < until) requestAnimationFrame(step);
  };
  if (delay) window.setTimeout(() => requestAnimationFrame(step), delay);
  else requestAnimationFrame(step);
}

/** The visible orchestrator composer: the Chat tab's, else the floating one. */
export function visibleComposer(): HTMLTextAreaElement | null {
  for (const id of ["octo-composer", "octo-composer-float"]) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

/** The index a list key moves to among `count` rows from `at` (↑/↓ clamp, Home/End); null for any other key. */
export function listKeyTarget(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  const to: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: count - 1 };
  const next = to[key];
  return next === undefined ? null : Math.max(0, Math.min(count - 1, next));
}

/**
 * ↑/↓/Home/End between the focusable rows (`[data-row]`) of a list container: a keydown handler for lists whose
 * rows are plain buttons or links (Home, Details).
 */
export function moveInList(e: { key: string; currentTarget: EventTarget | null; preventDefault(): void }): void {
  if (!(e.currentTarget instanceof HTMLElement)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
  const active = document.activeElement;
  const at = rows.findIndex((r) => r === active);
  const to = listKeyTarget(e.key, at < 0 ? 0 : at, rows.length);
  if (to === null || at < 0) return;
  e.preventDefault();
  rows[to]?.focus();
}

/**
 * Where an opened tool panel puts focus (one rule): a target the panel marks (`data-autofocus`), else its search field, else
 * its list — the chosen row, else the first — and never a header button or a view tab.
 */
const PANEL_TARGETS = ["[data-autofocus]", 'input[type="search"]', '[data-row][aria-current="true"], [data-row][aria-selected="true"]', "[data-row]"];

function panelTarget(root: ParentNode): HTMLElement | null {
  for (const selector of PANEL_TARGETS)
    for (const el of root.querySelectorAll<HTMLElement>(selector)) if (el.offsetParent !== null && !el.closest("[inert]")) return el;
  return null;
}

/**
 * Decision 35: a surface that just opened takes focus — its search field or list (`panelTarget`) once it has one (lazy panels
 * and their lists load a moment later), else, after `wait`, the container itself (`tabindex="-1"`). Never leaves focus on the page.
 */
export function focusSurfaceSoon(root: () => HTMLElement | null, wait = 1000): void {
  const start = performance.now();
  focusSoon(
    () => {
      const el = root();
      if (!el) return null;
      return panelTarget(el) ?? (performance.now() - start > wait ? el : null);
    },
    { timeout: wait + 1500 },
  );
}
