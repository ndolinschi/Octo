/**
 * Moves focus to an element that may not exist yet (a tab that is about to mount, a composer behind a
 * closing dialog): looks for it every frame until `timeout`. With `onlyIfLost`, it only acts while focus
 * sits on nothing (the body, or an element that was just removed), so it never steals focus the user moved.
 */
export function focusSoon(find: () => HTMLElement | null | undefined, options: { timeout?: number; delay?: number; onlyIfLost?: boolean } = {}): void {
  const { timeout = 1000, delay = 0, onlyIfLost = false } = options;
  const until = performance.now() + delay + timeout;
  const lost = () => {
    const a = document.activeElement;
    return !a || a === document.body || !a.isConnected;
  };
  const step = () => {
    if (onlyIfLost && !lost()) return;
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
