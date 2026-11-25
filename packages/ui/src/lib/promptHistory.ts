/**
 * Multi-step composer prompt history (↑ / ↓): cycles through earlier user prompts in the session
 * while preserving an in-progress draft when stepping back down past the newest entry.
 */
export type PromptHistoryState = { index: number; draft: string };

export const INITIAL_HISTORY: PromptHistoryState = { index: -1, draft: "" };

export function stepHistory(
  history: readonly string[],
  state: PromptHistoryState,
  dir: -1 | 1,
  currentText = "",
): { state: PromptHistoryState; text: string } | null {
  if (!history.length) return null;
  if (dir === -1) {
    const draft = state.index < 0 ? currentText : state.draft;
    const idx = state.index < 0 ? history.length - 1 : Math.min(state.index, history.length) - 1;
    const text = history[idx];
    return idx < 0 || text === undefined ? null : { state: { index: idx, draft }, text };
  }
  if (state.index < 0) return null;
  const idx = state.index + 1;
  const text = history[idx];
  return idx >= history.length || text === undefined ? { state: INITIAL_HISTORY, text: state.draft } : { state: { index: idx, draft: state.draft }, text };
}
