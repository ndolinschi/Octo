import type { Provider } from "@octo/agent-client";
import { useState } from "react";
import { cn } from "../../../lib/cn";
import { errorMessage } from "../../../lib/format";
import { isReady, plainReason, recheckAgent, stateText, stateTone } from "../../../lib/providers";
import { useApp } from "../../../state/app";
import { Button } from "../../primitives/Button";
import { Notice } from "../../primitives/Notice";
import { ProviderMark } from "../../primitives/ProviderMark";
import { AgentSteps, KeySteps } from "./ConnectSteps";
import { ToneDot } from "./ProviderRows";

/** What a provider needs, in one sentence (decision 53). */
function describe(p: Provider): string {
  if (p.state === "not_supported") return plainReason(p);
  if (isReady(p)) return p.kind === "agent" ? "Logged in and ready. Pick it, or one of its models, in any model picker." : "Connected.";
  if (p.kind === "agent")
    return p.state === "not_installed"
      ? "Not installed on this computer. Install it and log in once in a terminal, then press Check again."
      : "Installed, but not logged in. Log in once in a terminal, then press Check again.";
  if (p.kind === "api") return "Bill per token with your own Anthropic API key.";
  return "Route requests through the Octo router: one key upstream (for example OpenRouter), many models.";
}

/**
 * Decision 91b: the detail beside (below, under the floor) the providers list on the connect screen. Mark, name and state;
 * one sentence; the steps (commands to copy, or the key form); and the ONE action: "Check again" for an agent, the key
 * form's own save for the API and the router. No buttons in the list and no second button row.
 */
export function ConnectDetail({ provider: p, framed = true }: { provider: Provider; framed?: boolean }) {
  const { bridge } = useApp();
  const [state, setState] = useState<{ kind: "idle" | "running" | "done" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const check = () => {
    setState({ kind: "running" });
    recheckAgent(bridge, p.id).then(
      () => setState({ kind: "done" }),
      (e: unknown) => setState({ kind: "failed", message: errorMessage(e).replace(/\.$/, "") }),
    );
  };
  const agent = p.kind === "agent" && p.state !== "not_supported" && !isReady(p);
  return (
    <div data-connect-detail className={cn("flex min-w-0 flex-1 flex-col gap-4 p-5", framed && "rounded-lg border border-panel-edge bg-panel shadow-panel")}>
      <div className="flex min-w-0 items-center gap-3">
        <ProviderMark id={p.id} label={p.label} size={20} className="text-fg-2" />
        <h2 className="min-w-0 flex-1 truncate text-title text-fg">{p.label}</h2>
        <span className="flex shrink-0 items-center gap-2 text-sm text-fg-3">
          <ToneDot tone={stateTone(p)} />
          {stateText(p.state)}
        </span>
      </div>
      <p className="text-sm text-fg-2">{describe(p)}</p>
      {p.kind === "agent" ? <AgentSteps provider={p} /> : <KeySteps provider={p} upstream={false} />}
      {agent && (
        <div className="flex flex-col gap-2">
          <div>
            <Button variant="primary" loading={state.kind === "running"} onClick={check}>
              {state.kind === "running" ? "Checking…" : "Check again"}
            </Button>
          </div>
          {state.kind === "failed" && (
            <Notice tone="error" action={undefined}>
              Could not check: {state.message}. Check that Octo&apos;s local service is running.
            </Notice>
          )}
          {state.kind === "done" && !isReady(p) && <Notice tone="warn">Still {stateText(p.state).toLowerCase()}.</Notice>}
        </div>
      )}
    </div>
  );
}
