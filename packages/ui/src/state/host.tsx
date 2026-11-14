import { createContext, useContext } from "react";

/** What an embedding shell (e.g. an editor) can offer the UI. Every member is optional. */
export type HostCapabilities = {
  openFile?(path: string, folderLabel?: string): void;
  openProjectInEditor?(projectId: string): void;
  pickFolder?(): Promise<string | null>;
  /** The host's own image dialog (the composer's "+ → Image…"); without it the UI opens the platform's file dialog. */
  pickImages?(): Promise<File[]>;
  theme?: "dark" | "light";
  /** Restarts the harness (and the shell's other sidecars), for settings that apply after a restart (decision 59). */
  restart?(): void;
  /** The shell starts and stops the harness itself (the packaged app): the offline screen then has no developer commands. */
  managesHarness?: boolean;
};

const HostContext = createContext<HostCapabilities>({});

export const HostProvider = HostContext.Provider;

export function useHost(): HostCapabilities {
  return useContext(HostContext);
}
