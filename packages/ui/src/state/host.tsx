import { createContext, useContext } from "react";
import type { RemoteDevice } from "../lib/remoteDevice";

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
  /** Direction 7: force the phone layout (the mobile web client) or keep the desktop one; omitted: `PHONE_QUERY` decides. */
  layout?: "phone" | "desktop";
  /**
   * Remote access: the UI runs on a paired device (the mobile web client). What the harness refuses to a device (project
   * changes, commands, local-only settings; sends when it is read-only) is hidden or disabled (`lib/remoteDevice`).
   */
  remoteDevice?: RemoteDevice;
};

const HostContext = createContext<HostCapabilities>({});

export const HostProvider = HostContext.Provider;

export function useHost(): HostCapabilities {
  return useContext(HostContext);
}
