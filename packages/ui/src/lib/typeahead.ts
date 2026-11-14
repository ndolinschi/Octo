/**
 * P2-7: what is typed between Ctrl/Cmd+K and the palette's field taking focus (its chunk, Suspense, the modal's focus
 * effect) is held here instead of going to whatever had focus (the composer would send it), then handed to the field.
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

let held: Typeahead | null = null;
let stop: (() => void) | null = null;

/** Starts holding the keys typed from now on (called with the key that opens the palette). */
export function holdTypeahead(): void {
  takeTypeahead();
  held = EMPTY;
  const onKey = (e: KeyboardEvent) => {
    if (held === null || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const next = typeaheadKey(held, e.key);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    held = next;
  };
  window.addEventListener("keydown", onKey, true);
  stop = () => window.removeEventListener("keydown", onKey, true);
}

/** Stops holding and returns what was typed (empty when nothing was held). */
export function takeTypeahead(): Typeahead {
  const taken = held ?? EMPTY;
  stop?.();
  stop = null;
  held = null;
  return taken;
}
