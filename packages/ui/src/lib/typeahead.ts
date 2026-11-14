/**
 * P2-7, NEW-7: the command palette's open/close as one small state machine, and what is typed between Ctrl/Cmd+K and the
 * palette's field taking focus (its chunk, Suspense, the modal's focus effect). Those keys are held here instead of going
 * to whatever had focus (the composer would send them) and are handed to that palette's field once.
 *
 * Phases: `closed` → `opening` (Ctrl/Cmd+K: a new palette, numbered `id`, keys are held) → `open` (its field took focus and
 * the held keys) → `closing` (its exit plays) → `closed`. Ctrl/Cmd+K while `closing` opens a new palette at once (the closing
 * one is replaced, not reused). A close names its palette: a late close of an earlier one (its Escape, its scrim) does not
 * touch the palette that is opening now, nor its held keys.
 */
export type Typeahead = { text: string; enter: boolean };

const EMPTY: Typeahead = { text: "", enter: false };

/** The held keys after `key`; `null` for a key that is not held (it goes where it would have gone). */
export function typeaheadKey(held: Typeahead, key: string): Typeahead | null {
  // After Enter nothing more is held for the field: the run of the first row decides what comes next.
  if (held.enter) return held;
  if (key === "Enter") return { ...held, enter: true };
  if (key === "Backspace") return { ...held, text: held.text.replace(/[\s\S]$/u, "") };
  // One character (one code point: an emoji too); named keys (Escape, ArrowDown, Shift…) are longer.
  return /^[\s\S]$/u.test(key) ? { ...held, text: held.text + key } : null;
}

export type PalettePhase = "closed" | "opening" | "open" | "closing";
/** `id`: the palette of this phase (each open makes a new one); `held`: the keys typed while it is `opening`. */
export type PaletteGate = { phase: PalettePhase; id: number; held: Typeahead };

export type PaletteEvent =
  | { type: "toggle" }
  | { type: "open" }
  | { type: "close"; id?: number }
  | { type: "ready"; id: number }
  | { type: "exited"; id: number }
  | { type: "key"; key: string };

export const CLOSED: PaletteGate = { phase: "closed", id: 0, held: EMPTY };

const showing = (g: PaletteGate) => g.phase === "opening" || g.phase === "open";

/**
 * The next gate after `e`, and the keys handed over (`ready` of the palette that is opening: once; later readies get none).
 * `key` returns `consumed: true` when the key was held (the caller then keeps it from its target).
 */
export function paletteStep(g: PaletteGate, e: PaletteEvent): { gate: PaletteGate; typed?: Typeahead; consumed?: boolean } {
  switch (e.type) {
    case "toggle":
      return paletteStep(g, showing(g) ? { type: "close", id: g.id } : { type: "open" });
    case "open":
      return showing(g) ? { gate: g } : { gate: { phase: "opening", id: g.id + 1, held: EMPTY } };
    case "close":
      if (!showing(g) || (e.id !== undefined && e.id !== g.id)) return { gate: g };
      // The closing palette's keys go with it.
      return { gate: { phase: "closing", id: g.id, held: EMPTY } };
    case "ready":
      if (e.id !== g.id || g.phase !== "opening") return { gate: g, typed: EMPTY };
      return { gate: { phase: "open", id: g.id, held: EMPTY }, typed: g.held };
    case "exited":
      return e.id === g.id && g.phase === "closing" ? { gate: { ...g, phase: "closed" } } : { gate: g };
    case "key": {
      if (g.phase !== "opening") return { gate: g };
      // Escape before the palette took focus cancels this open (its own Escape handling is not there yet).
      if (e.key === "Escape") return { gate: { phase: "closing", id: g.id, held: EMPTY }, consumed: true };
      const next = typeaheadKey(g.held, e.key);
      return next === null ? { gate: g } : { gate: { ...g, held: next }, consumed: true };
    }
  }
}

// --- the app's one palette gate -------------------------------------------------------------------------------------------

let gate: PaletteGate = CLOSED;
const listeners = new Set<() => void>();
let listening = false;

function dispatch(e: PaletteEvent): { typed?: Typeahead; consumed?: boolean } {
  const { gate: next, ...out } = paletteStep(gate, e);
  if (next !== gate) {
    gate = next;
    syncKeys();
    for (const l of listeners) l();
  }
  return out;
}

function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (!dispatch({ type: "key", key: e.key }).consumed) return;
  e.preventDefault();
  e.stopPropagation();
}

/** Keys are listened for only while a palette is opening. */
function syncKeys() {
  const want = gate.phase === "opening";
  if (want === listening) return;
  listening = want;
  if (want) window.addEventListener("keydown", onKey, true);
  else window.removeEventListener("keydown", onKey, true);
}

export const palette = {
  /** For `useSyncExternalStore`. */
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot: (): PaletteGate => gate,
  /** Ctrl/Cmd+K: opens a new palette (holding the keys typed from now on) or closes the one showing. */
  toggle: () => void dispatch({ type: "toggle" }),
  /** A button that opens the palette (no-op while one shows). */
  open: () => void dispatch({ type: "open" }),
  /** Closes palette `id` (only if it is the one showing); without an id, whichever shows. */
  close: (id?: number) => void dispatch(id === undefined ? { type: "close" } : { type: "close", id }),
  /** Palette `id`'s field has focus: the keys held for it, once (empty for any other palette or a second call). */
  ready: (id: number): Typeahead => dispatch({ type: "ready", id }).typed ?? EMPTY,
  /** Palette `id`'s exit has played. */
  exited: (id: number) => void dispatch({ type: "exited", id }),
};
