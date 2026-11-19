import { warmBridgeClient } from "@octo/agent-client";
import { warmDrag } from "../components/dock/drag";
import { transcriptPart } from "../components/chat/transcriptPart";
import { browserIdle, installIntentWarming, warmOnIdle } from "../lib/warmSchedule";

/**
 * Idle warm-up order (`lib/warm`), most likely first: the palette, the model list, Settings, then the tool tabs the "+" picker
 * offers. Each key's chunk is registered next to its lazy component; one key per idle slot.
 */
const IDLE_WARM = [
  "palette",
  "model",
  "settings",
  "tab-picker",
  "project-dialog",
  "tool:files",
  "tool:terminal",
  "tool:review",
  "tool:browser",
  "tool:processes",
  "tool:changes",
];
/** Idle warming starts this long after the shell mounts (the project's first load has the main thread before that). */
const SHELL_SETTLES_MS = 1500;

/** The chunks the first minutes most likely need: the first assistant message must not flash as plain text before Markdown. */
function warmFirstPaint() {
  warmBridgeClient();
  warmDrag();
  // Each failure is retried by the real use, which shows the error.
  void import("../components/shared/Markdown").catch(() => undefined);
  void transcriptPart.fetch().catch(() => undefined);
  void import("../components/chat/ToolGroup").catch(() => undefined);
  void import("../components/chat/DelegationGroup").catch(() => undefined);
  void import("../components/chat/TurnBanner").catch(() => undefined);
  void import("../components/shell/DiscardDialogs").catch(() => undefined);
  void import("../components/primitives/Menu").catch(() => undefined);
  void import("../components/chat/ComposerPills").catch(() => undefined);
  void import("../components/shell/SidebarDrawer").catch(() => undefined);
  void import("../components/chat/ContextRing").catch(() => undefined);
  void import("../components/chat/SessionMenu").catch(() => undefined);
}

/**
 * Everything the shell warms after its first paint (its own chunk, so none of it is in the entry): the first-paint chunks on the
 * first idle moment, then the lazy surfaces (palette, model list, Settings, tool tabs) on intent at once and on idle once the
 * shell has settled (`lib/warmSchedule`; none under Save-Data). Returns a stop.
 */
export function startWarming(doc: Document): () => void {
  // Right after the first paint, as before: at the first idle moment, at the latest after 500ms.
  const cancelFirst = browserIdle(warmFirstPaint, 500);
  const unlisten = installIntentWarming(doc);
  let cancel: () => void = () => undefined;
  const id = window.setTimeout(() => (cancel = warmOnIdle(IDLE_WARM)), SHELL_SETTLES_MS);
  return () => {
    cancelFirst();
    unlisten();
    window.clearTimeout(id);
    cancel();
  };
}
