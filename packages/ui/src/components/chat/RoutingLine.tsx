import type { TierPolicy } from "@octo/agent-client";
import { Segmented } from "../primitives/Segmented";

const POLICIES: readonly { id: TierPolicy; label: string; title: string }[] = [
  { id: "auto", label: "Auto", title: "Auto: Octo picks a cheaper or stronger model per task" },
  { id: "ceiling", label: "Ceiling", title: "Up to the chosen tier: may go cheaper, never stronger" },
  { id: "fixed", label: "Fixed", title: "Always the chosen tier" },
];

/** Decision 91e: the router's tier policy, a second line of the model menu ("Routing: Auto"); only with a router in the path. */
export function RoutingLine(props: { value: TierPolicy; onChoose(value: TierPolicy): void }) {
  return (
    <div className="flex min-h-ctl-sm items-center justify-between gap-2 text-xs text-fg-3">
      <span>Model choice</span>
      <Segmented label="Model choice" options={POLICIES} value={props.value} onChange={props.onChoose} />
    </div>
  );
}
