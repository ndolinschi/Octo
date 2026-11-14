import { readyLazy } from "./readyLazy";

/**
 * The transcript (turns, the turn window, the activity rows) is its own chunk, fetched with the conversation's first render
 * and warmed after first paint (`AppShell`); once in, it renders without suspending (`readyLazy`). Its turns wait for the
 * Markdown chunk anyway (`Transcript`'s `TURN_PARTS`), so first paint loses nothing it showed.
 */
export const transcriptPart = readyLazy(() => import("./Transcript").then((m) => m.Transcript));
