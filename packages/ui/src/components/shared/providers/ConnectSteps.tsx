import type { Provider, SettingsUpdate, SettingsView } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { errorMessage } from "../../../lib/format";
import { API_PROVIDER, commandsIn, extraReason, isReady, refreshProviders } from "../../../lib/providers";
import { useApp } from "../../../state/app";
import { useHost } from "../../../state/host";
import { Button } from "../../primitives/Button";
import { CommandLine } from "../../primitives/CommandLine";
import { Spinner } from "../../primitives/Status";
import { SecretForm } from "../SecretForm";

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

/** Prose from the harness or a plugin, where text in backticks is code: shown as inline code, never as literal backticks. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`\n]+)`/).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-xs text-fg">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The sentence behind a "Details" fold: the commands are already shown as copy lines (decision 89 d: no "set X" as prose). */
function Details({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-ml-2">
          {open ? "Hide details" : "Details"}
        </Button>
      </div>
      {open && (
        <p className="text-sm text-fg-2">
          <Rich text={text} />
        </p>
      )}
    </div>
  );
}

/** An environment variable name in prose (`COPILOT_GITHUB_TOKEN`): an instruction that belongs under "Details". */
const ENV_VAR = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

/** An agent's install and login steps as commands to copy (decision 53); a ready agent shows its models. */
export function AgentSteps({ provider: p }: { provider: Provider }) {
  if (isReady(p))
    return (
      <p className="text-sm text-fg-2">
        {p.models.length
          ? `Models: ${p.models.map((m) => (m.id === p.default_model ? `${m.label} (default)` : m.label)).join(", ")}.`
          : "The agent picks its own model."}
      </p>
    );
  const steps: { title: string; text: string; commands: string[] }[] = [];
  if (p.state === "not_installed") steps.push({ title: "Install", text: p.install_hint, commands: commandsIn(p.install_hint) });
  steps.push({ title: "Log in", text: p.login_hint, commands: commandsIn(p.login_hint) });
  return (
    <div className="flex flex-col gap-4">
      {extraReason(p) && (
        <p className="text-xs text-fg-3">
          <Rich text={extraReason(p)} />
        </p>
      )}
      <ol className="flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-2">
            <h3 className="text-heading text-fg">
              {steps.length > 1 ? `${i + 1}. ` : ""}
              {s.title}
            </h3>
            {s.commands.map((c) => (
              <CommandLine key={c} command={c} label={`${s.title.toLowerCase()} command`} />
            ))}
            {s.text &&
              (s.commands.length > 0 || ENV_VAR.test(s.text) ? (
                <Details text={s.text} />
              ) : (
                <p className="text-sm text-fg-2">
                  <Rich text={s.text} />
                </p>
              ))}
            {!s.text && <p className="text-sm text-fg-3">The agent's plugin gives no instructions; see its documentation.</p>}
          </li>
        ))}
      </ol>
      <p className="text-xs text-fg-3">Run these in a terminal; Octo never runs them for you. When you are done, press Check again.</p>
    </div>
  );
}

/** The API key form, or the router switch and upstream key. */
export function KeySteps({ provider, upstream }: { provider: Provider; upstream: boolean }) {
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
      // Decision 89 d: the sentence in plain words; the variable to set is under "Details", like the agents' steps.
      <div role={load.status === "error" ? "alert" : undefined} className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">
          {load.status === "error" ? `${load.message}. ` : ""}This connection cannot set keys: the harness accepts them only from this machine. Set the key
          where the harness runs.
        </p>
        <Details
          text={`Set \`${provider.kind === "api" ? SETTING_IDS.anthropicApiKey : SETTING_IDS.routerUpstreamKey}\` in the harness's environment, then restart it.`}
        />
      </div>
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
            <Button variant="link" size="xs" onClick={host.restart}>
              Restart now
            </Button>
          ) : (
            <span className="text-fg-3">Quit and reopen the app.</span>
          )}
        </p>
      )}
    </div>
  );
}
