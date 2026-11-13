import type { ReactNode } from "react";
import { EXPERIMENTAL_TIP, stateText, type Tone } from "../../lib/providers";
import type { Provider } from "@octo/agent-client";
import { ProviderMark } from "../primitives/ProviderMark";
import { SectionHeader } from "../primitives/SectionHeader";
import { ToneDot } from "../shared/providers/ProviderRows";

/**
 * The caption of one group of a provider's detail (decision 89 d). Polish step 6a, S3/S5: a group caption is meta (12px
 * `fg-3`), as on every settings page, not bold body text; `aside` is a quiet button at the caption's right.
 */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <SectionHeader as="h3" aside={aside}>
      {children}
    </SectionHeader>
  );
}

/** Mark, name, state and the dim "Experimental": the detail's title (without its buttons). */
export function ProviderTitle({ provider, tone, stateLabel }: { provider: Provider; tone: Tone; stateLabel?: string }) {
  return (
    // It does not shrink below its content (up to the line's width): in a narrow pane the action wraps under it instead of
    // cutting the name ("GitH…").
    <div className="flex max-w-full min-w-0 flex-[1_0_auto] items-center gap-3">
      <ProviderMark id={provider.id} label={provider.label} size={20} className="text-fg-2" />
      <h2 className="min-w-0 truncate text-title text-fg">{provider.label}</h2>
      {/* S5: the state once, glyph + word; "Experimental" once after it. */}
      <span className="flex shrink-0 items-center gap-2 text-sm text-fg-2">
        <ToneDot tone={tone} />
        <span>
          {stateLabel ?? stateText(provider.state)}
          {provider.experimental && (
            <span title={EXPERIMENTAL_TIP} className="text-fg-3">
              {" · Experimental"}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}
