import { createContext, useContext } from "react";
import { DEFAULT_TAB_FLAGS, type TabFeatureFlags, type TabFeatureOverrides } from "../lib/tabFlags";

export { DEFAULT_TAB_FLAGS, type TabFeatureFlags, type TabFeatureOverrides };

const TabFlagsContext = createContext<TabFeatureFlags>(DEFAULT_TAB_FLAGS);

export const TabFlagsProvider = TabFlagsContext.Provider;

export function useTabFlags(): TabFeatureFlags {
  return useContext(TabFlagsContext);
}
