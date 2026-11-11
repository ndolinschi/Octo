import { useCallback, useState } from "react";
import type { TabId } from "./layout";
import type { Slot } from "./tabMemory";
import { useOptionalWorkspace } from "./WorkspaceProvider";

/**
 * State that is kept in the workspace's tab memory under (`tab`, `slot`): initialised from it, and written back on every
 * change, so it survives the tab moving to another group. Outside a workspace it is plain state.
 */
export function useTabMemory<T>(tab: TabId, slot: Slot<T>, initial: T): [T, (next: T) => void] {
  const memory = useOptionalWorkspace()?.memory;
  const [value, setValue] = useState<T>(() => memory?.get(tab, slot) ?? initial);
  const set = useCallback(
    (next: T) => {
      memory?.set(tab, slot, next);
      setValue(next);
    },
    [memory, tab, slot],
  );
  return [value, set];
}
