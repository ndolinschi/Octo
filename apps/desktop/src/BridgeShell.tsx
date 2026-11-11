import { OctoApp } from "@octo/ui";
import { useMemo } from "react";
import { bridgeLabel, type BridgeChoice } from "./bridgeChoice";
import { useBridge } from "./useBridge";
import { useWindowChrome } from "./useWindowChrome";

/** The shared UI on the chosen bridge (the browser path and the Tauri path both end here). */
export function BridgeShell({ choice, onRestart }: { choice: BridgeChoice; onRestart?: () => void }) {
  const bridge = useBridge(choice);
  const chrome = useWindowChrome();
  const host = useMemo(() => (onRestart ? { restart: onRestart } : undefined), [onRestart]);
  if (!bridge) return null;
  return <OctoApp bridge={bridge} bridgeUrl={bridgeLabel(choice)} shell="desktop" demo={choice.kind === "demo"} chrome={chrome} {...(host ? { host } : {})} />;
}
