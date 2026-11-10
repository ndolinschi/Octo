import { createContext, useContext } from "react";

/** What an embedding shell (e.g. an editor) can offer the UI. Every member is optional. */
export type HostCapabilities = {
  openFile?(path: string, folderLabel?: string): void;
  openProjectInEditor?(projectId: string): void;
  pickFolder?(): Promise<string | null>;
  theme?: "dark" | "light";
};

const HostContext = createContext<HostCapabilities>({});

export const HostProvider = HostContext.Provider;

export function useHost(): HostCapabilities {
  return useContext(HostContext);
}
