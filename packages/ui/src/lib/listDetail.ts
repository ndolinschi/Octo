/**
 * State of a list-and-detail view (decision 66). `selected` is the owner's remembered choice and survives going back;
 * `open` says whether the one-column layout (below the container floor) shows the detail instead of the list. The wide
 * layout ignores `open`: it always shows both.
 */
export type PaneState = { selected: string | null; open: boolean };

export type PaneAction =
  /** The user chose a row (also the row already chosen: after Back it opens the detail again). */
  | { type: "pick"; id: string }
  /** Back control or Esc in the detail: show the list, keep the selection. */
  | { type: "back" }
  /** The owner changed `selected` itself (a search hit, a jump): a new choice opens the detail. */
  | { type: "sync"; selected: string | null };

export const INITIAL_PANE: PaneState = { selected: null, open: false };

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
  switch (action.type) {
    case "pick":
      return state.selected === action.id && state.open ? state : { selected: action.id, open: true };
    case "back":
      return state.open ? { selected: state.selected, open: false } : state;
    case "sync":
      if (action.selected === state.selected) return state;
      return { selected: action.selected, open: action.selected !== null };
  }
}

/** The container width (px) below which the view is one column. Tailwind needs the literal `@min-[640px]/ld`; a test keeps them equal. */
export const LIST_DETAIL_FLOOR = 640;

/** What Esc does inside the detail: back to the list in one column; in two columns focus goes to the list, selection kept. */
export function escapeTarget(narrow: boolean): "back" | "list" {
  return narrow ? "back" : "list";
}

/** Whether a container of `width` px is narrower than the floor. */
export function isNarrow(width: number): boolean {
  return width < LIST_DETAIL_FLOOR;
}
