import { createContext, useContext } from "react";

export type PanelTab = "agents" | "notes" | "files";

/** What the project workspace offers its content: opening the side pane on a tab. */
type PaneValue = { openPane(tab: PanelTab): void; /** The tab on show, or null while the pane is closed. */ shown: PanelTab | null };

const PaneContext = createContext<PaneValue | null>(null);

export const PaneProvider = PaneContext.Provider;

/** Null outside a project workspace. */
export function useOptionalPane(): PaneValue | null {
  return useContext(PaneContext);
}
