import { createContext, useContext } from "react";

/**
 * The window chrome a panel may need: whether the sidebar shows, its toggle (shown in the first panel's strip while hidden),
 * and the connect sheet of a provider (decision 53: a model picker's "Connect" row opens it without leaving the picker's screen;
 * `useAnyway`, when the picker can use an unverified agent, adds that button to the sheet).
 */
export type ShellValue = { sidebarOpen: boolean; toggleSidebar(): void; openConnect(providerId: string, useAnyway?: () => void): void };

export const ShellContext = createContext<ShellValue>({ sidebarOpen: true, toggleSidebar: () => undefined, openConnect: () => undefined });

export function useShell(): ShellValue {
  return useContext(ShellContext);
}
