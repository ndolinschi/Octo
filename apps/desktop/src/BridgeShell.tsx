import { OctoApp } from "@octo/ui";
import { useMemo } from "react";
import { bridgeLabel, isTauri, type BridgeChoice } from "./bridgeChoice";
import { pickFolder } from "./pickFolder";
import { useBridge } from "./useBridge";
import { useChromeDebug, useWindowChrome } from "./useWindowChrome";

/** The shared UI on the chosen bridge (the browser path and the Tauri path both end here). */
export function BridgeShell({ choice, onRestart }: { choice: BridgeChoice; onRestart?: () => void }) {
  const bridge = useBridge(choice);
  const chrome = useWindowChrome();
  const guideY = useChromeDebug(chrome);
  const host = useMemo(() => {
    const h: { restart?: () => void; pickFolder?: () => Promise<string | null>; managesHarness?: boolean } = {};
    // Only the Tauri path (HostedApp) passes `onRestart`: there the shell starts and restarts the harness.
    if (onRestart) {
      h.restart = onRestart;
      h.managesHarness = true;
    }
    if (isTauri(window)) h.pickFolder = () => pickFolder();
    return Object.keys(h).length ? h : undefined;
  }, [onRestart]);
  if (!bridge) return null;
  const app = (
    <OctoApp bridge={bridge} bridgeUrl={bridgeLabel(choice)} shell="desktop" demo={choice.kind === "demo"} chrome={chrome} {...(host ? { host } : {})} />
  );
  if (guideY === null) return app;
  return (
    <>
      {app}
      <div aria-hidden data-chrome-guide className="pointer-events-none fixed inset-x-0 z-50 h-px bg-[#ff00ff]" style={{ top: guideY - 0.5 }} />
    </>
  );
}
