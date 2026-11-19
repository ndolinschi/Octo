import { Info } from "lucide-react";
import { usePhone } from "../../lib/phone";
import { TOOL_PURPOSE, type PurposeTool } from "../../lib/toolPurpose";
import { IconButton } from "../primitives/IconButton";

/**
 * Walk B13: the (i) at the start of a tool panel's bar (G1: the bar has no title); its tooltip (and accessible name) is the panel's one-line purpose. Goes in
 * the `Panel`'s `lead` slot, so the 40px header keeps its height.
 * A4: not on the phone, where a lone (i) took a 44px band of its own; the phone header's "⋯" sheet starts with "About this
 * panel" and the same line (`PhoneMoreSheet`).
 */
export function PanelPurpose({ tool }: { tool: PurposeTool }) {
  if (usePhone()) return null;
  // G1: the first thing in the bar, on the 8px inset and the 28px box of the Files and Browser bars' first buttons.
  return <IconButton icon={Info} size="sm" label={TOOL_PURPOSE[tool]} className="text-fg-3" />;
}
