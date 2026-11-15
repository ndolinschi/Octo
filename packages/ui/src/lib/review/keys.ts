export type ReviewKeyAction = "next-change" | "prev-change" | "next-file" | "prev-file" | "viewed" | "comment" | "suggest" | "next-thread" | "prev-thread";

export type KeyInput = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };
/** Where the key was pressed: a text field the reader types in, or Monaco's (read-only) input, which still takes the review keys. */
export type KeyTarget = { editable: boolean; inMonaco: boolean };

const KEYS: Record<string, ReviewKeyAction> = {
  j: "next-change",
  k: "prev-change",
  "]": "next-file",
  "[": "prev-file",
  v: "viewed",
  c: "comment",
  s: "suggest",
  // The existing threads of the file, in line order (the accessible thread list opens on the one reached).
  n: "next-thread",
  p: "prev-thread",
};

/** The review key a keydown stands for, or null: never while typing, never with a modifier (those belong to the app). */
export function reviewKeyAction(e: KeyInput, target: KeyTarget): ReviewKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (target.editable && !target.inMonaco) return null;
  return KEYS[e.key] ?? null;
}
