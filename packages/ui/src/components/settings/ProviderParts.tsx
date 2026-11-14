import type { ReactNode } from "react";
import { EXPERIMENTAL_TIP, stateText, type Tone } from "../../lib/providers";
import { modelName } from "../../lib/models";
import { Button } from "../primitives/Button";
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

/**
 * G14: the router's detail had only "Billing" to say. What the provider list does know about it: its state in a sentence, the
 * models it lists, where its settings are (the Router group below), and "Check again" (reads the provider list anew).
 */
export function RouterFacts(props: { provider: Provider; checking: boolean; onCheck(): void; onSettings?: (() => void) | undefined }) {
  const p = props.provider;
  const n = p.models.length;
  const models =
    n > 0 ? `${n} ${n === 1 ? "model" : "models"} listed${p.default_model ? `; ${modelName(p.default_model)} when none is named` : ""}.` : "No models listed.";
  return (
    <section className="flex flex-col gap-1">
      <SectionTitle
        aside={
          <Button variant="quiet" size="sm" aria-busy={props.checking} onClick={() => !props.checking && props.onCheck()}>
            {props.checking ? "Checking…" : "Check again"}
          </Button>
        }
      >
        Status
      </SectionTitle>
      <p className="text-sm text-fg-2">{p.state === "ready" ? "Ready: Octo's model requests go through the router." : `${stateText(p.state)}.`}</p>
      <p className="text-sm text-fg-2">{models}</p>
      <p className="text-sm text-fg-2">
        Its switch and upstream key are under Router, below.
        {props.onSettings && (
          <Button variant="link" size="sm" className="ml-1" onClick={props.onSettings}>
            Router settings
          </Button>
        )}
      </p>
    </section>
  );
}
