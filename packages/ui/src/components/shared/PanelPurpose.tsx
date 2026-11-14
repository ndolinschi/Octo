import { Info } from "lucide-react";
import { TOOL_PURPOSE, type PurposeTool } from "../../lib/toolPurpose";
import { IconButton } from "../primitives/IconButton";

/**
 * Walk B13: the (i) after a tool panel's title; its tooltip (and accessible name) is the panel's one-line purpose. Goes in
 * the `Panel`'s `lead` slot, so the 40px header keeps its height.
 */
export function PanelPurpose({ tool }: { tool: PurposeTool }) {
  return <IconButton icon={Info} size="xs" label={TOOL_PURPOSE[tool]} className="-ml-1 text-fg-3" />;
}
