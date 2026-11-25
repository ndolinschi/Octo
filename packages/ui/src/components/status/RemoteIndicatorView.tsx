import { Smartphone } from "lucide-react";
import { settingsHref } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { indicatorText } from "../shared/remoteText";
import { useRemoteAccess } from "../shared/useRemoteAccess";
import { StatusButton } from "./StatusButton";

const POLL_MS = 10_000;

/**
 * The status bar's remote-access item (spec 2026-11-14 remote access, section 7): shown only while remote access is on (or
 * failed), with the number of devices seen in the last minute, "allow?" when a phone waits for the computer's answer. A
 * `full`-access project driven from a phone is therefore never invisible here. Opens Settings → Remote access. Loaded
 * lazily by `RemoteIndicator` (the entry bundle's budget).
 */
export function RemoteIndicatorView() {
  const { load } = useRemoteAccess(POLL_MS);
  if (load.status !== "ready") return null;
  const text = indicatorText(load.s);
  if (!text) return null;
  return (
    <StatusButton
      data-remote-indicator
      title="Remote access is on: paired phones can reach this computer. Open its settings."
      {...(load.s.state === "error" ? { warning: "err" as const } : {})}
      onClick={() => (window.location.hash = settingsHref("remote"))}
    >
      <Glyph icon={Smartphone} size={14} />
      {text}
    </StatusButton>
  );
}
