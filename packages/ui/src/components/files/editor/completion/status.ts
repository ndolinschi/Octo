/**
 * The completion state of each open file, for the status item in the file bar (design decision 7: off / ready /
 * thinking / paused, the reason on hover, never a toast). The editor's completion component writes it; the file bar
 * reads it. A tiny external store so the two need no shared React parent.
 */

export type CompletionState =
  { kind: "off"; reason: string } | { kind: "ready"; model: string } | { kind: "thinking"; model: string } | { kind: "paused"; reason: string; until: number };

type Listener = () => void;

export class StatusStore {
  private readonly states = new Map<string, CompletionState>();
  private readonly listeners = new Set<Listener>();

  get = (key: string): CompletionState | undefined => this.states.get(key);

  set(key: string, state: CompletionState | null): void {
    const prev = this.states.get(key);
    if (state === null) {
      if (!prev) return;
      this.states.delete(key);
    } else {
      if (prev && sameState(prev, state)) return;
      this.states.set(key, state);
    }
    for (const l of this.listeners) l();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function sameState(a: CompletionState, b: CompletionState): boolean {
  switch (a.kind) {
    case "off":
      return b.kind === "off" && a.reason === b.reason;
    case "ready":
    case "thinking":
      return b.kind === a.kind && a.model === b.model;
    case "paused":
      return b.kind === "paused" && a.reason === b.reason && a.until === b.until;
  }
}

export const completionStatus = new StatusStore();

/** How long completion rests after a failure before the next keystroke may ask again. */
export const PAUSE_ERROR_MS = 30_000;
export const PAUSE_BUDGET_MS = 10 * 60_000;

/**
 * What a failed request does to the feature. `completion_off` (the model was cleared since the project loaded) turns
 * it off; `budget_reached` pauses it for a while (decision 6: "completion stops quietly and the status item says so");
 * anything else pauses it briefly, so a broken upstream is not hammered on every keystroke.
 */
export function stateAfterError(error: unknown, now: number): CompletionState {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "completion_off") return { kind: "off", reason: "No completion model is set for this project" };
  if (code === "budget_reached") return { kind: "paused", reason: "The project's budget is reached", until: now + PAUSE_BUDGET_MS };
  const message = error instanceof Error && error.message ? error.message : "the request failed";
  return { kind: "paused", reason: `Completion failed: ${message}. It tries again in 30 s`, until: now + PAUSE_ERROR_MS };
}

/** The status item's words: a label (visible when there is room), and the hover text. */
export function statusText(state: CompletionState): { label: string; title: string } {
  switch (state.kind) {
    case "off":
      return { label: "Completion off", title: `Inline completion is off. ${state.reason}.` };
    case "ready":
      return { label: "Completion", title: `Inline completion with ${state.model}: Tab accepts, Ctrl/Cmd+→ accepts a word, Esc dismisses` };
    case "thinking":
      return { label: "Completion", title: `Inline completion with ${state.model}: asking…` };
    case "paused":
      return { label: "Completion paused", title: `Inline completion is paused. ${state.reason}.` };
  }
}
