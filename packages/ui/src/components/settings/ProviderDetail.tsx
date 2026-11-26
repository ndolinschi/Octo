import type { Provider } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { useState } from "react";
import { billingLine, commandsIn, extraReason, primaryAction, reasonLine, recheckAgent, refreshProviders, stateTone, takesAccounts } from "../../lib/providers";
import { cn } from "../../lib/cn";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Rich } from "../shared/providers/ConnectSteps";
import { Notice } from "../primitives/Notice";
import { AgentPrefs } from "./AgentPrefsPane";
import { AccountFacts, AgentAccounts } from "./AgentAccountsPane";
import { ProviderKey } from "./ProviderKey";
import { ProviderModels } from "./ProviderModels";
import { useHarnessSettings } from "./harnessSettings";
import { CONTROL_CAP } from "./parts";
import { ProviderTitle, RouterFacts, SectionTitle } from "./ProviderParts";

/**
 * Decision 89 d, in this order: title row (mark, name, state, the state's one action), the reason with the commands to run,
 * the API key field (API only), Models, Preferred model, Roles, Billing. Fills the rest of the page beside the list.
 */
export function ProviderDetail({ provider: p, onRouter, onSelect }: { provider: Provider; onRouter?: () => void; onSelect?: (id: string) => void }) {
  const { bridge } = useApp();
  const harness = useHarnessSettings();
  // A2: the API provider's one action is its key form's "Save key"; a second filled "Connect" beside it did nothing visible.
  // The router's "Connect" opens the Router group below, where its switch and upstream key are.
  // A server that does not answer (Ollama, a local base URL) has nothing to save: its action is looking again.
  const action = p.kind === "api" && p.state !== "not_running" ? null : primaryAction(p);
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
  const connect = () => onRouter?.();
  const [rechecking, setRechecking] = useState(false);
  const recheckRouter = async () => {
    setRechecking(true);
    // A failed read keeps the list as it was; the providers page shows its own error for it.
    await refreshProviders(bridge).catch(() => undefined);
    setRechecking(false);
  };
  const reason = reasonLine(p);
  const restartNeeded = p.kind === "api" && harness.needsRestart(SETTING_IDS.anthropicApiKey);
  return (
    // S1/S5: the right half of the Providers surface (no frame of its own): the title line, then groups in the page's
    // style — a meta caption over its rows, 24 apart.
    <div data-provider-detail className="@container flex min-w-0 flex-1 flex-col gap-6 p-card">
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
        {p.account_of && <AccountFacts account={p} {...(onSelect ? { onRemoved: () => onSelect(p.account_of ?? "") } : {})} />}
        {takesAccounts(p) && p.state !== "not_installed" && <AgentAccounts agent={p} {...(onSelect ? { onOpen: onSelect } : {})} />}
        {p.kind === "agent" && p.state === "ready" && <AgentPrefs agent={p} />}
        {p.kind === "router" && <RouterFacts provider={p} checking={rechecking} onCheck={() => void recheckRouter()} onSettings={onRouter} />}
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

/** "type /login" in a login hint: the step typed inside the agent after starting it. */
const SLASH_STEP = /\btype `?(\/[a-z-]+)`?/i;
/** A bare domain in prose ("from x.ai"): shown as a link. */
const DOMAIN = /\b((?:[a-z0-9-]+\.)+(?:ai|com|dev|io|org|net))\b/i;

/** Plugin prose with no command in it, in plain words: "on PATH" said as a person would, a domain as a link. */
function HintProse({ text }: { text: string }) {
  const plain = text.replace(/\s*so that `?([\w.-]+)`? is on PATH/i, " so that the $1 command works in a terminal");
  const m = DOMAIN.exec(plain);
  if (!m) return <Rich text={plain} />;
  return (
    <>
      <Rich text={plain.slice(0, m.index)} />
      <a href={`https://${m[1]}`} target="_blank" rel="noreferrer noopener" className="text-link underline-offset-2 hover:underline">
        {m[1]}
      </a>
      <Rich text={plain.slice(m.index + m[0].length)} />
    </>
  );
}

/**
 * The reason in plain words, then each step as a command to copy and one line saying where to run it (C17: "in a terminal",
 * and the step typed inside the agent, such as /login); a hint with no command shows as prose with its link.
 */
function Reason({ provider: p, text }: { provider: Provider; text: string }) {
  const steps =
    p.kind === "agent"
      ? [
          ...(p.state === "not_installed" ? [{ title: /too old/i.test(p.reason) ? "Update" : "Install", hint: p.install_hint }] : []),
          { title: "Log in", hint: p.login_hint },
        ]
      : p.state === "not_running" && p.problem?.command
        ? [{ title: "Start", hint: `\`${p.problem.command}\`` }]
        : [];
  // S5: the API provider's "No API key" is said by its key group; one label, not three. C17: "Grok is not installed." after
  // "Not installed" and the reason line says nothing new.
  const extra = p.kind === "api" || p.state === "not_running" || (p.state === "not_installed" && /not installed/i.test(extraReason(p))) ? "" : extraReason(p);
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
          const slash = SLASH_STEP.exec(s.hint)?.[1];
          return (
            <div key={s.title} className="flex flex-col gap-1">
              <SectionTitle>{s.title}</SectionTitle>
              {commands.map((c) => (
                <CommandLine key={c} command={c} label={`${s.title.toLowerCase()} command`} />
              ))}
              {commands.length > 0 && (
                <p className="text-xs text-fg-3">
                  {commands.length > 1 ? "Run one of these in a terminal" : "Run this in a terminal"}
                  {slash && s.title === "Log in" ? `, then type ${slash} and follow the steps` : ""}.
                </p>
              )}
              {commands.length === 0 && (
                <p className="text-sm text-fg-2">{s.hint ? <HintProse text={s.hint} /> : "No setup steps are available; see the agent's documentation."}</p>
              )}
            </div>
          );
        })}
    </section>
  );
}
