import type { Provider } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { useRef, useState } from "react";
import { billingLine, commandsIn, extraReason, primaryAction, reasonLine, recheckAgent, refreshProviders, stateTone } from "../../lib/providers";
import { cn } from "../../lib/cn";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Rich } from "../shared/providers/ConnectSteps";
import { Notice } from "../primitives/Notice";
import { AgentPrefs } from "./AgentPrefsPane";
import { ProviderKey } from "./ProviderKey";
import { ProviderModels } from "./ProviderModels";
import { useHarnessSettings } from "./harnessSettings";
import { CONTROL_CAP } from "./parts";
import { ProviderTitle, SectionTitle } from "./ProviderParts";

/**
 * Decision 89 d, in this order: title row (mark, name, state, the state's one action), the reason with the commands to run,
 * the API key field (API only), Models, Preferred model, Roles, Billing. Fills the rest of the page beside the list.
 */
export function ProviderDetail({ provider: p }: { provider: Provider }) {
  const { bridge } = useApp();
  const harness = useHarnessSettings();
  const action = primaryAction(p);
  const pane = useRef<HTMLDivElement>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      // Runs the agent's login probe now (`POST /v1/providers/{id}/recheck`), then reloads the shared list.
      await recheckAgent(bridge, p.id);
    } catch {
      // The state shown is the one before; "Still …" below says nothing changed, and the harness log has the cause.
      await refreshProviders(bridge);
    }
    setChecking(false);
    setChecked(true);
  };
  const connect = () => pane.current?.querySelector<HTMLInputElement>("input[type=password]")?.focus();
  const reason = reasonLine(p);
  const restartNeeded = p.kind === "api" && harness.needsRestart(SETTING_IDS.anthropicApiKey);
  return (
    // S1/S5: the right half of the Providers surface (no frame of its own): the title line, then groups in the page's
    // style — a meta caption over its rows, 24 apart.
    <div ref={pane} data-provider-detail className="@container flex min-w-0 flex-1 flex-col gap-6 p-5">
      <div className="flex min-h-ctl-md flex-wrap items-center gap-x-4 gap-y-2">
        <ProviderTitle provider={p} tone={restartNeeded ? "warn" : stateTone(p)} {...(restartNeeded ? { stateLabel: "Restart needed" } : {})} />
        {action && (
          <div className="flex items-center gap-2">
            {checked && !checking && p.state !== "ready" && <Notice tone="warn">Still not ready.</Notice>}
            <Button
              variant="primary"
              // Not `disabled` while checking: a disabled button drops focus to the page (part 8, finding 3).
              aria-busy={checking}
              onClick={() => (checking ? undefined : action === "Check again" ? void check() : connect())}
            >
              {checking ? "Checking…" : action}
            </Button>
          </div>
        )}
      </div>
      <div className={cn("flex max-w-measure min-w-0 flex-col gap-6", CONTROL_CAP)}>
        {reason && <Reason provider={p} text={reason} />}
        {p.kind === "api" && <ProviderKey />}
        {(p.models.length > 0 || p.state === "ready") && p.kind !== "router" && <ProviderModels provider={p} />}
        {p.kind === "agent" && p.state === "ready" && <AgentPrefs agent={p} />}
        {p.state !== "not_installed" && p.state !== "not_connected" && (
          <section className="flex flex-col gap-1">
            <SectionTitle>Billing</SectionTitle>
            <p className="text-sm text-fg-2">{billingLine(p)}</p>
          </section>
        )}
      </div>
    </div>
  );
}

/** The reason in plain words, then each step as a command to copy; a hint with no command shows as prose. */
function Reason({ provider: p, text }: { provider: Provider; text: string }) {
  const steps =
    p.kind === "agent" ? [...(p.state === "not_installed" ? [{ title: "Install", hint: p.install_hint }] : []), { title: "Log in", hint: p.login_hint }] : [];
  // S5: the API provider's "No API key" is said by its key group; one label, not three.
  const extra = p.kind === "api" ? "" : extraReason(p);
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">
        <Rich text={text} />
      </p>
      {extra && p.state !== "error" && (
        <p className="text-xs text-fg-3">
          <Rich text={extra} />
        </p>
      )}
      {p.state !== "error" &&
        steps.map((s) => {
          const commands = commandsIn(s.hint);
          return (
            <div key={s.title} className="flex flex-col gap-1">
              <SectionTitle>{s.title}</SectionTitle>
              {commands.map((c) => (
                <CommandLine key={c} command={c} label={`${s.title.toLowerCase()} command`} />
              ))}
              {commands.length === 0 && (
                <p className="text-sm text-fg-3">{s.hint ? <Rich text={s.hint} /> : "The agent's plugin gives no instructions; see its documentation."}</p>
              )}
            </div>
          );
        })}
    </section>
  );
}
