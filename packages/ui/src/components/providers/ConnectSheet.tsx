import type { Provider } from "@octo/agent-client";
import { useState } from "react";
import { errorMessage } from "../../lib/format";
import { ROUTER_PROVIDER, USE_ANYWAY_NOTE, canUseAnyway, isReady, recheckAgent, stateText, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Notice } from "../primitives/Notice";
import { Spinner } from "../primitives/Status";
import { describe } from "../shared/providers/ConnectDetail";
import { AgentSteps, KeySteps, ROUTER_UPSTREAM } from "../shared/providers/ConnectSteps";

/**
 * Decision 53: the connect sheet of one provider. An agent: its state and the exact install and login commands (each
 * with a copy button) and "Check again". The API: a write-only key form. The router: its switch and upstream key.
 */
export function ConnectSheet({ target, onClose, onUseAnyway }: { target: string; onClose(): void; onUseAnyway?: (() => void) | null }) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const list = providers.status === "loading" ? null : providers.list;
  const id = target === ROUTER_UPSTREAM ? ROUTER_PROVIDER : target;
  const provider = list?.providers.find((p) => p.id === id);
  const title = provider ? (isReady(provider) ? provider.label : `Connect ${provider.label}`) : "Connect a provider";
  return (
    <Dialog
      title={title}
      {...(provider ? { description: describe(provider) } : {})}
      onClose={onClose}
      footer={
        <>
          {provider?.kind === "agent" && provider.state !== "not_supported" && (
            <CheckAgain
              provider={provider}
              onCheck={() => recheckAgent(bridge, provider.id)}
              {...(onUseAnyway && canUseAnyway(provider)
                ? {
                    onUseAnyway: () => {
                      onUseAnyway();
                      onClose();
                    },
                  }
                : {})}
            />
          )}
          <Button
            variant={provider && isReady(provider) ? "primary" : "secondary"}
            onClick={onClose}
            data-autofocus={provider?.kind === "agent" ? true : undefined}
          >
            {provider && isReady(provider) ? "Done" : "Close"}
          </Button>
        </>
      }
    >
      {providers.status === "loading" && (
        <p className="flex h-ctl-md items-center gap-2 text-sm text-fg-3" aria-busy>
          <Spinner size="xs" /> Checking what is on this machine…
        </p>
      )}
      {providers.status === "error" && !provider && (
        <Notice
          tone="error"
          action={
            <Button size="sm" onClick={() => void providers.refresh()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t check the providers. {providers.message.replace(/\.$/, "")}. Check that Octo&apos;s local service is running.
        </Notice>
      )}
      {list && !provider && <p className="text-sm text-fg-2">Octo's local service does not list this provider any more. Close this and pick another one.</p>}
      {provider?.kind === "agent" && <AgentSteps provider={provider} />}
      {provider && provider.kind !== "agent" && <KeySteps provider={provider} upstream={target === ROUTER_UPSTREAM} />}
    </Dialog>
  );
}

/** "Check again" runs the agent's login probe now (a spinner while it does); "Use anyway" only for a login the probe says is missing. */
function CheckAgain({ provider, onCheck, onUseAnyway }: { provider: Provider; onCheck(): Promise<boolean>; onUseAnyway?: () => void }) {
  const [checked, setChecked] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState("");
  if (isReady(provider)) return null;
  return (
    <span className="mr-auto flex min-w-0 flex-col gap-1 max-[420px]:mr-0">
      <span className="flex flex-wrap items-center gap-3 max-[420px]:flex-col max-[420px]:items-stretch">
        <Button
          loading={running}
          onClick={() => {
            setChecked(true);
            setRunning(true);
            setFailure("");
            onCheck().then(
              () => setRunning(false),
              (e: unknown) => {
                setRunning(false);
                setFailure(errorMessage(e).replace(/\.$/, ""));
              },
            );
          }}
          disabled={running}
        >
          {running ? "Checking…" : "Check again"}
        </Button>
        {onUseAnyway && (
          <Button variant="quiet" onClick={onUseAnyway} disabled={running}>
            Use anyway
          </Button>
        )}
        {checked && !running && (
          <Notice tone={failure ? "error" : "warn"}>{failure ? `Could not check: ${failure}.` : `Still ${stateText(provider.state).toLowerCase()}.`}</Notice>
        )}
      </span>
      {onUseAnyway && <span className="text-xs text-fg-3">{USE_ANYWAY_NOTE}</span>}
    </span>
  );
}
