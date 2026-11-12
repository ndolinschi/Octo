import type { ReactNode } from "react";
import { stateText, type Tone } from "../../lib/providers";
import type { Provider } from "@octo/agent-client";
import { ProviderMark } from "../primitives/ProviderMark";
import { StateDot } from "./parts";

/** The heading of one block of a provider's detail (decision 89 d): same style, same gap above everywhere. */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-3">
      <h3 className="min-w-0 flex-1 text-sm font-medium text-fg">{children}</h3>
      {aside}
    </div>
  );
}

/** Mark, name, state and the dim "Experimental": the detail's title (without its buttons). */
export function ProviderTitle({ provider, tone }: { provider: Provider; tone: Tone }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <ProviderMark id={provider.id} label={provider.label} size={20} className="text-fg-2" />
      <h2 className="min-w-0 truncate text-title text-fg">{provider.label}</h2>
      <span className="flex shrink-0 items-center gap-2 text-sm text-fg-3">
        <StateDot tone={tone} />
        {stateText(provider.state)}
        {provider.experimental && <span>· Experimental</span>}
      </span>
    </div>
  );
}
