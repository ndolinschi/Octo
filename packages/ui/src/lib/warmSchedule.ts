import { warm } from "./warm";

/**
 * When the lazy surfaces' chunks are warmed (`lib/warm` holds what they are): on idle once the shell has settled, one per idle
 * slot and most likely first (`warmOnIdle`), and at once when the control that opens one is hovered, focused or pressed: it names
 * its key in `data-warm` (a picker row's `data-picker-row` id counts; `installIntentWarming`). Idle warming is skipped under
 * Save-Data. Its own chunk, loaded by the shell after the first paint.
 */

/** The person asked the browser to save data (`navigator.connection.saveData`): nothing is fetched ahead of use. */
export function saveData(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (typeof nav !== "object" || nav === null || !("connection" in nav)) return false;
  const c = nav.connection;
  return typeof c === "object" && c !== null && "saveData" in c && c.saveData === true;
}

/** Schedules `run` once the main thread is idle; returns a cancel. */
export type IdleScheduler = (run: () => void) => () => void;

export const browserIdle: IdleScheduler = (run) => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  // WebKit has no idle callback: a timer long enough to land after the first paint's work.
  const id = window.setTimeout(run, 300);
  return () => window.clearTimeout(id);
};

/**
 * Warms `keys` in order, one per idle slot, each after the previous one settled (so two chunks never compete with each other
 * or with the person's own input). Returns a cancel.
 */
export function warmOnIdle(keys: readonly string[], idle: IdleScheduler = browserIdle, skip = saveData()): () => void {
  if (skip) return () => undefined;
  let cancel: () => void = () => undefined;
  let stopped = false;
  const next = (i: number) => {
    const key = keys[i];
    if (stopped || key === undefined) return;
    cancel = idle(() => void warm(key).then(() => next(i + 1)));
  };
  next(0);
  return () => {
    stopped = true;
    cancel();
  };
}

/** The `data-warm` key of the control under an event's target; a picker row's id is its key too (the "+" picker's `tool:<id>`). */
function intentKey(target: EventTarget | null): string | undefined {
  if (typeof Element === "undefined" || !(target instanceof Element)) return undefined;
  const el = target.closest<HTMLElement>("[data-warm], [data-picker-row]");
  return el?.dataset.warm ?? el?.dataset.pickerRow;
}

/**
 * Hover, focus or a press on a control with `data-warm="<key>"` warms that key; holding Ctrl/Cmd warms the palette (Ctrl/Cmd+K).
 * One set of capture listeners for the whole app; returns their removal.
 */
export function installIntentWarming(doc: Document): () => void {
  const onIntent = (e: Event) => {
    const key = intentKey(e.target);
    if (key) void warm(key);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") void warm("palette");
  };
  const events = ["pointerover", "pointerdown", "focusin"] as const;
  for (const name of events) doc.addEventListener(name, onIntent, { capture: true, passive: true });
  doc.addEventListener("keydown", onKey, true);
  return () => {
    for (const name of events) doc.removeEventListener(name, onIntent, { capture: true });
    doc.removeEventListener("keydown", onKey, true);
  };
}
