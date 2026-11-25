import { createContext, useContext } from "react";

/**
 * The status bar's two project-owned ends (decision 73): the open project fills `start` (folder, changed files) and `end`
 * (budget). The shell owns the row; the project's workspace portals into these elements, so what it shows reads the
 * project's state without the row sitting inside the project's providers.
 */
export type StatusSlots = { start: HTMLElement | null; end: HTMLElement | null };

export const StatusSlotsContext = createContext<StatusSlots>({ start: null, end: null });

export function useStatusSlots(): StatusSlots {
  return useContext(StatusSlotsContext);
}
