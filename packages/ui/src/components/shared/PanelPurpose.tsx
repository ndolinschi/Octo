import { Info } from "lucide-react";
import { usePhone } from "../../lib/phone";
import { TOOL_PURPOSE, type PurposeTool } from "../../lib/toolPurpose";
import { IconButton } from "../primitives/IconButton";

/**
 * Walk B13: the (i) after a tool panel's title; its tooltip (and accessible name) is the panel's one-line purpose. Goes in
 * the `Panel`'s `lead` slot, so the 40px header keeps its height.
 * A4: not on the phone, where a lone (i) took a 44px band of its own; the phone header's "⋯" sheet starts with "About this
 * panel" and the same line (`PhoneMoreSheet`).
 */
export function PanelPurpose({ tool }: { tool: PurposeTool }) {
  if (usePhone()) return null;
  return <IconButton icon={Info} size="xs" label={TOOL_PURPOSE[tool]} className="-ml-1 text-fg-3" />;
}
