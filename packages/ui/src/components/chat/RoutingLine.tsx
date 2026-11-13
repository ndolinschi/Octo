import type { TierPolicy } from "@octo/agent-client";
import { Segmented } from "../primitives/Segmented";

const POLICIES: readonly { id: TierPolicy; label: string; title: string }[] = [
  { id: "auto", label: "Auto", title: "Auto: the router may pick a lower or higher tier" },
  { id: "ceiling", label: "Ceiling", title: "Ceiling: never above the requested tier" },
  { id: "fixed", label: "Fixed", title: "Fixed: always the requested tier" },
];

/** Decision 91e: the router's tier policy, a second line of the model menu ("Routing: Auto"); only with a router in the path. */
export function RoutingLine(props: { value: TierPolicy; onChoose(value: TierPolicy): void }) {
  return (
    <div className="flex min-h-ctl-sm items-center justify-between gap-2 text-xs text-fg-3">
      <span>Routing</span>
      <Segmented label="Routing" options={POLICIES} value={props.value} onChange={props.onChoose} />
    </div>
  );
}
