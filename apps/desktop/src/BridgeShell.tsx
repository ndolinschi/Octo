import { OctoApp } from "@octo/ui";
import { bridgeLabel, type BridgeChoice } from "./bridgeChoice";
import { useBridge } from "./useBridge";

/** The shared UI on the chosen bridge (the browser path and the Tauri path both end here). */
export function BridgeShell({ choice }: { choice: BridgeChoice }) {
  const bridge = useBridge(choice);
  if (!bridge) return null;
  return <OctoApp bridge={bridge} bridgeUrl={bridgeLabel(choice)} shell="desktop" demo={choice.kind === "demo"} />;
}
