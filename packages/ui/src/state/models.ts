import type { AcpName } from "../lib/models";
import { useApp } from "./app";

const NONE: readonly AcpName[] = [];

/** The ACP agents the bridge offers (their labels name `acp:` settings). */
export function useAcpNames(): readonly AcpName[] {
  return useApp().config?.acp_orchestrators ?? NONE;
}
