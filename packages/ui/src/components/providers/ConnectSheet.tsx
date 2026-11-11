import type { Provider, SettingsUpdate, SettingsView } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { API_PROVIDER, ROUTER_PROVIDER, commandsIn, isReady, refreshProviders, stateText, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { Button } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Status";
import { SecretForm } from "./SecretForm";

/** The router's upstream key has its own target (Settings → Providers → API keys). */
export const ROUTER_UPSTREAM = "router-upstream";

type SettingsLoad = { status: "loading" } | { status: "unavailable" } | { status: "error"; message: string } | { status: "ready"; view: SettingsView };

function useSettingsView() {
  const { bridge } = useApp();
  const [load, setLoad] = useState<SettingsLoad>(() => (bridge.getSettings ? { status: "loading" } : { status: "unavailable" }));
  useEffect(() => {
    if (!bridge.getSettings) return;
    let live = true;
    bridge.getSettings().then(
      (view) => live && setLoad({ status: "ready", view }),
      (e: unknown) => live && setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const save = async (update: SettingsUpdate) => {
    if (!bridge.putSettings) throw new Error("This connection cannot change the harness's settings");
    const view = await bridge.putSettings(update);
    setLoad({ status: "ready", view });
    await refreshProviders(bridge);
  };
  return { load, save };
}

/**
 * Decision 53: the connect sheet of one provider. An agent: its state and the exact install and login commands (each
 * with a copy button) and "Check again". The API: a write-only key form. The router: its switch and upstream key.
 */
export function ConnectSheet({ target, onClose }: { target: string; onClose(): void }) {
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
          {provider?.kind === "agent" && (
            <CheckAgain provider={provider} refreshing={providers.status === "ready" && providers.refreshing} onCheck={() => void providers.refresh()} />
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
        <p className="flex h-9 items-center gap-2 text-sm text-fg-3" aria-busy>
          <Spinner size={10} /> Checking what is on this machine…
        </p>
      )}
      {providers.status === "error" && !provider && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
          <span className="min-w-0 flex-1">
            <span className="text-err">Couldn't check the providers.</span> {providers.message.replace(/\.$/, "")}. Check that the harness is running.
          </span>
          <Button size="sm" onClick={() => void providers.refresh()}>
            Retry
          </Button>
        </div>
      )}
      {list && !provider && <p className="text-sm text-fg-2">The harness does not list this provider any more. Close this and pick another one.</p>}
      {provider?.kind === "agent" && <AgentSteps provider={provider} />}
      {provider && provider.kind !== "agent" && <KeySteps provider={provider} upstream={target === ROUTER_UPSTREAM} />}
    </Dialog>
  );
}

function describe(p: Provider): string {
  if (isReady(p)) return p.kind === "agent" ? "Logged in and ready. Pick it, or one of its models, in any model picker." : "Connected.";
  if (p.kind === "agent")
    return p.state === "not_installed"
      ? "Not installed on this machine. Install it, log in, then check again."
      : "Installed, but not logged in. Log in once, then check again.";
  if (p.kind === "api") return "Bill per token with your own Anthropic API key.";
  return "Route requests through the Octo router: one key upstream (for example OpenRouter), many models.";
}

function CheckAgain({ provider, refreshing, onCheck }: { provider: Provider; refreshing: boolean; onCheck(): void }) {
  const [checked, setChecked] = useState(false);
  if (isReady(provider)) return null;
  return (
    <span className="mr-auto flex items-center gap-3 max-[420px]:mr-0 max-[420px]:flex-col max-[420px]:items-stretch">
      <Button
        onClick={() => {
          setChecked(true);
          onCheck();
        }}
        disabled={refreshing}
        aria-busy={refreshing}
      >
        {refreshing ? "Checking…" : "Check again"}
      </Button>
      {checked && !refreshing && (
        <span role="status" className="text-xs text-warn">
          Still {stateText(provider.state).toLowerCase()}.
        </span>
      )}
    </span>
  );
}

function AgentSteps({ provider: p }: { provider: Provider }) {
  if (isReady(p))
    return (
      <p className="text-sm text-fg-2">
        {p.models.length
          ? `Models: ${p.models.map((m) => (m.id === p.default_model ? `${m.label} (default)` : m.label)).join(", ")}.`
          : "The agent picks its own model."}
      </p>
    );
  const steps: { title: string; text: string | undefined; commands: string[] }[] = [];
  if (p.state === "not_installed") steps.push({ title: "Install", text: p.install_hint, commands: commandsIn(p.install_hint) });
  steps.push({ title: "Log in", text: p.login_hint, commands: commandsIn(p.login_hint) });
  return (
    <div className="flex flex-col gap-4">
      {p.reason && <p className="text-xs text-fg-3">{p.reason}</p>}
      <ol className="flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-2">
            <h3 className="text-heading text-fg">
              {steps.length > 1 ? `${i + 1}. ` : ""}
              {s.title}
            </h3>
            {s.text && <p className="text-sm text-fg-2">{s.text}</p>}
            {s.commands.map((c) => (
              <CommandLine key={c} command={c} label={`${s.title.toLowerCase()} command`} />
            ))}
            {!s.text && <p className="text-sm text-fg-3">The agent's plugin gives no instructions; see its documentation.</p>}
          </li>
        ))}
      </ol>
      <p className="text-xs text-fg-3">Run these in a terminal; Octo never runs them for you. When you are done, press Check again.</p>
    </div>
  );
}

function KeySteps({ provider, upstream }: { provider: Provider; upstream: boolean }) {
  const settings = useSettingsView();
  const host = useHost();
  const { load } = settings;
  if (load.status === "loading")
    return (
      <p className="flex h-9 items-center gap-2 text-sm text-fg-3" aria-busy>
        <Spinner size={10} /> Loading…
      </p>
    );
  if (load.status === "unavailable" || load.status === "error")
    return (
      <p role={load.status === "error" ? "alert" : undefined} className="text-sm text-fg-2">
        {load.status === "error" ? `${load.message}. ` : ""}This connection cannot set keys: the harness accepts them only from this machine. Set{" "}
        <code className="font-mono text-xs">{provider.kind === "api" ? SETTING_IDS.anthropicApiKey : SETTING_IDS.routerUpstreamKey}</code> in the harness's
        environment instead.
      </p>
    );
  const view = load.view;
  const get = (id: string) => view.settings.find((s) => s.id === id);
  const restart = view.restart_required.length > 0;
  const keyId = provider.kind === "api" || provider.id === API_PROVIDER ? SETTING_IDS.anthropicApiKey : SETTING_IDS.routerUpstreamKey;
  const key = get(keyId);
  const router = get(SETTING_IDS.routerEnabled);
  return (
    <div className="flex flex-col gap-4">
      {provider.kind === "router" && router && !upstream && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-fg-2">{router.value === true ? "The router is switched on." : "The router is switched off."}</p>
          <Button size="sm" disabled={!router.editable} onClick={() => void settings.save({ set: { [router.id]: router.value !== true } })}>
            {router.value === true ? "Switch off" : "Switch on"}
          </Button>
        </div>
      )}
      {key?.editable === false ? (
        <p className="text-sm text-fg-2">{key.note ?? `The key is set by the ${key.source}; change it there.`}</p>
      ) : (
        <SecretForm
          label={provider.kind === "api" ? "Anthropic API key" : "Upstream key (for example OpenRouter)"}
          set={key?.set === true}
          hint={key?.hint}
          placeholder={provider.kind === "api" ? "sk-ant-…" : "sk-or-…"}
          focusFirst
          onSave={(value) => settings.save({ set: { [keyId]: value } })}
        />
      )}
      {restart && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-warn">
          Saved. The harness applies keys and the router switch after a restart.
          {host.restart ? (
            <button type="button" onClick={host.restart} className="rounded-xs text-link underline-offset-2 hover:underline">
              Restart now
            </button>
          ) : (
            <span className="text-fg-3">Quit and reopen the app.</span>
          )}
        </p>
      )}
    </div>
  );
}
