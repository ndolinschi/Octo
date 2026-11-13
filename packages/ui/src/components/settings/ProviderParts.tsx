import type { ReactNode } from "react";
import { EXPERIMENTAL_TIP, stateText, type Tone } from "../../lib/providers";
import type { Provider } from "@octo/agent-client";
import { ProviderMark } from "../primitives/ProviderMark";
import { SectionHeader } from "../primitives/SectionHeader";
import { ToneDot } from "../shared/providers/ProviderRows";

/** The heading of one block of a provider's detail (decision 89 d): same style, same gap above everywhere. */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <SectionHeader level="title" as="h3" aside={aside}>
      {children}
    </SectionHeader>
  );
}

/** Mark, name, state and the dim "Experimental": the detail's title (without its buttons). */
export function ProviderTitle({ provider, tone, stateLabel }: { provider: Provider; tone: Tone; stateLabel?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <ProviderMark id={provider.id} label={provider.label} size={20} className="text-fg-2" />
      <h2 className="min-w-0 truncate text-title text-fg">{provider.label}</h2>
      <span className="flex shrink-0 items-center gap-2 text-sm text-fg-3">
        <ToneDot tone={tone} />
        {stateLabel ?? stateText(provider.state)}
        {provider.experimental && <span title={EXPERIMENTAL_TIP}>· Experimental</span>}
      </span>
    </div>
  );
}
