import type { Provider } from "@octo/agent-client";
import { commandsIn, stateText, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { SettingsGroup, SettingsRow, SkeletonRow, StateDot } from "./parts";
import { toneOf } from "./ProvidersSection";

/** Decision 59 Agents: each subscription agent — its state, the exact install / login commands, its models, a check. */
export function AgentsSection() {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  if (providers.status === "loading")
    return (
      <SettingsGroup label="Agents">
        <SkeletonRow />
        <SkeletonRow />
      </SettingsGroup>
    );
  const agents = providers.list?.providers.filter((p) => p.kind === "agent") ?? [];
  return (
    <>
      {providers.status === "error" && (
        <SettingsGroup label="Agents">
          <SettingsRow
            title={<span className="text-err">Couldn't check the agents</span>}
            description={`${providers.message.replace(/\.$/, "")}. Check that the harness is running, then retry.`}
            control={
              <Button size="sm" onClick={() => void providers.refresh()}>
                Retry
              </Button>
            }
          />
        </SettingsGroup>
      )}
      {providers.status === "ready" && agents.length === 0 && (
        <SettingsGroup label="Agents">
          <SettingsRow title="No agents" description="The harness lists no agent plugins. Agents come from plugin manifests (Editor → Plugins)." />
        </SettingsGroup>
      )}
      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} refreshing={providers.status === "ready" && providers.refreshing} onCheck={() => void providers.refresh()} />
      ))}
    </>
  );
}

function AgentCard({ agent: a, refreshing, onCheck }: { agent: Provider; refreshing: boolean; onCheck(): void }) {
  const install = a.state === "not_installed" ? commandsIn(a.install_hint) : [];
  const login = a.state === "not_logged_in" || a.state === "not_installed" ? commandsIn(a.login_hint) : [];
  const def = a.models.find((m) => m.id === a.default_model);
  return (
    <SettingsGroup label={a.label} id={a.state === "ready" ? undefined : `agent-${a.id}`}>
      <SettingsRow
        rowId={`agent-${a.id}-state`}
        leading={<StateDot tone={toneOf(a)} />}
        title={stateText(a.state)}
        description={a.state === "ready" ? "Logged in and ready to run." : a.reason || "Not ready."}
        control={
          <Button size="sm" onClick={onCheck} disabled={refreshing} aria-busy={refreshing}>
            {refreshing ? "Checking…" : "Check again"}
          </Button>
        }
      />
      {a.state === "not_installed" && (
        <SettingsRow
          title="Install"
          description={
            <span className="flex flex-col gap-2">
              <span>{a.install_hint || "Install the agent's command line so that it is on PATH."}</span>
              {install.map((c) => (
                <CommandLine key={c} command={c} label="install command" />
              ))}
            </span>
          }
        />
      )}
      {(a.state === "not_logged_in" || a.state === "not_installed") && a.login_hint && (
        <SettingsRow
          title={a.state === "not_installed" ? "Then log in" : "Log in"}
          description={
            <span className="flex flex-col gap-2">
              <span>{a.login_hint}</span>
              {login.map((c) => (
                <CommandLine key={c} command={c} label="login command" />
              ))}
            </span>
          }
        />
      )}
      <SettingsRow
        title="Models"
        description={
          a.models.length === 0
            ? "The agent picks its own model."
            : a.models.map((m) => (m.id === a.default_model ? `${m.label} (default)` : m.label)).join(", ")
        }
        control={def ? <span className="text-sm text-fg-2">Default: {def.label}</span> : undefined}
      />
    </SettingsGroup>
  );
}
