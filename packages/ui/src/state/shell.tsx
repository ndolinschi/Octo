import { createContext, useContext } from "react";

/** The window chrome a panel may need: whether the sidebar shows, and its toggle (shown in the first panel's strip while hidden). */
export type ShellValue = { sidebarOpen: boolean; toggleSidebar(): void };

export const ShellContext = createContext<ShellValue>({ sidebarOpen: true, toggleSidebar: () => undefined });

export function useShell(): ShellValue {
  return useContext(ShellContext);
}
