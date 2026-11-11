import { createContext, useContext } from "react";

/**
 * The two ends of the title bar row that the open project fills (decision 54): its name and state after the navigation
 * buttons, and its actions at the far end. The shell owns the row; the project's workspace portals into these elements,
 * so what it shows reads the project, workspace and host state without the shell sitting inside those providers.
 */
export type TitleBarSlots = { start: HTMLElement | null; end: HTMLElement | null };

export const TitleBarSlotsContext = createContext<TitleBarSlots>({ start: null, end: null });

export function useTitleBarSlots(): TitleBarSlots {
  return useContext(TitleBarSlotsContext);
}
