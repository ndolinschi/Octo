import type { Provider } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { API_PROVIDER, connectAction, stateText, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { SaveStatus, SettingsGroup, SettingsRow, SkeletonRow, StateDot, Switch } from "./parts";
import { useSave } from "./useSave";

export const toneOf = (p: Pick<Provider, "state">) =>
  p.state === "ready" ? "ok" : p.state === "error" ? "err" : p.state === "not_connected" ? "muted" : "warn";

/** Decision 53 d / 59: every provider as a row with its state and one action; API keys and the router folded below. */
export function ProvidersSection() {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const list = providers.status === "ready" ? providers.list : providers.status === "error" ? providers.list : null;
  return (
    <>
      <SettingsGroup
        label="What can run a model"
        footer={
          list
            ? list.connected === 0
              ? "Nothing is connected: connect one provider to create projects."
              : `${list.connected === 1 ? "One provider" : `${list.connected} providers`} connected. Model pickers list only what these can run.`
            : undefined
        }
      >
        {providers.status === "loading" && [0, 1, 2].map((i) => <SkeletonRow key={i} />)}
        {providers.status === "error" && (
          <SettingsRow
            title={<span className="text-err">Couldn't load providers</span>}
            description={`${providers.message.replace(/\.$/, "")}. Check that the harness is running, then retry.`}
            control={
              <Button size="sm" onClick={() => void providers.refresh()}>
                Retry
              </Button>
            }
          />
        )}
        {list?.providers.map((p) => (
          <ProviderRow key={p.id} provider={p} />
        ))}
      </SettingsGroup>
      <ApiKeys />
    </>
  );
}

function ProviderRow({ provider: p }: { provider: Provider }) {
  const { connect, restart } = useSettingsActions();
  const harness = useHarnessSettings();
  const [saved, run] = useSave();
  const [confirm, setConfirm] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    // The button that replaced "Remove" takes its focus, so a keyboard user confirms with the next Enter.
    confirmRef.current?.focus();
    const id = window.setTimeout(() => setConfirm(false), 4000);
    return () => window.clearTimeout(id);
  }, [confirm]);
  const removable = p.state === "ready" && p.kind !== "agent" && harness.load.status === "ready";
  const remove = () =>
    run(() => harness.save(p.kind === "api" ? { unset: [SETTING_IDS.anthropicApiKey] } : { set: { [SETTING_IDS.routerEnabled]: false } })).then(() =>
      setConfirm(false),
    );
  const detail =
    p.state === "ready" ? (p.models.length ? (p.models.length === 1 ? "1 model" : `${p.models.length} models`) : "Ready") : (p.reason ?? stateText(p.state));
  const kind = p.kind === "api" ? "API key" : p.kind === "router" ? "Router" : "Agent on this machine";
  return (
    <SettingsRow
      rowId={`provider-${p.id}`}
      leading={<StateDot tone={toneOf(p)} />}
      title={p.label}
      description={
        <>
          <span className={cn(p.state !== "ready" && p.state !== "not_connected" && "text-warn")}>{stateText(p.state)}</span>
          {" · "}
          {p.state === "ready" ? `${kind}, ${detail}` : detail}
        </>
      }
      status={
        <SaveStatus
          state={saved}
          restart={p.kind !== "agent" && harness.needsRestart(p.kind === "api" ? SETTING_IDS.anthropicApiKey : SETTING_IDS.routerEnabled)}
          onRestart={restart}
        />
      }
      control={
        removable ? (
          confirm ? (
            <Button ref={confirmRef} size="sm" variant="danger" onClick={() => void remove()}>
              Confirm remove
            </Button>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )
        ) : (
          <Button size="sm" variant={connectAction(p) === "Manage" ? "secondary" : "primary"} onClick={() => connect(p.id)}>
            {connectAction(p) === "Manage" ? "Details" : connectAction(p)}
          </Button>
        )
      }
    />
  );
}

/** "API keys" folded (decision 59): the secrets and the router switch and URL. Values are write-only. */
function ApiKeys() {
  const [open, setOpen] = useState(false);
  const harness = useHarnessSettings();
  const panelId = useId();
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex h-row w-fit items-center gap-1.5 rounded-sm px-1 text-xs text-fg-3 hover:text-fg"
      >
        <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-150", open && "rotate-90")} />
        API keys and router
      </button>
      <div id={panelId} hidden={!open} className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel">
        {harness.load.status === "unavailable" && (
          <SettingsRow title="Not available here" description="This connection cannot read or change the harness's settings." />
        )}
        {harness.load.status === "loading" && <SkeletonRow />}
        {harness.load.status === "error" && (
          <SettingsRow
            title={<span className="text-err">Couldn't load settings</span>}
            description={`${harness.load.message}. The harness answers only on this machine (loopback).`}
            control={
              <Button size="sm" onClick={harness.reload}>
                Retry
              </Button>
            }
          />
        )}
        {harness.load.status === "ready" && (
          <>
            <SecretRow id={SETTING_IDS.anthropicApiKey} rowId="api-key" target={API_PROVIDER} />
            <RouterSwitch />
            <RouterUrl />
            <SecretRow id={SETTING_IDS.routerUpstreamKey} rowId="upstream-key" target="router-upstream" />
          </>
        )}
      </div>
    </section>
  );
}

function SecretRow({ id, rowId, target }: { id: string; rowId: string; target: string }) {
  const harness = useHarnessSettings();
  const { connect, restart } = useSettingsActions();
  const s = harness.get(id);
  if (!s) return null;
  const locked = !s.editable;
  return (
    <SettingsRow
      rowId={rowId}
      title={s.label.replace(/ \(for example OpenRouter\)$/, "")}
      description={locked ? (s.note ?? `Set by the ${s.source}`) : s.set ? `Set${s.hint ? ` (${s.hint})` : ""}. Never shown again.` : "Not set."}
      status={harness.needsRestart(id) ? <SaveStatus state={{ kind: "idle" }} restart onRestart={restart} /> : null}
      control={
        locked ? undefined : (
          <Button size="sm" onClick={() => connect(target)}>
            {s.set ? "Replace" : "Set key"}
          </Button>
        )
      }
    />
  );
}

function RouterSwitch() {
  const harness = useHarnessSettings();
  const { restart } = useSettingsActions();
  const [saved, run] = useSave();
  const id = useId();
  const s = harness.get(SETTING_IDS.routerEnabled);
  if (!s) return null;
  return (
    <SettingsRow
      rowId="router"
      title="Use the Octo router"
      htmlFor={id}
      description={s.editable ? "The app starts the bundled router in front of the harness." : (s.note ?? `Set by the ${s.source}`)}
      status={<SaveStatus state={saved} restart={harness.needsRestart(s.id)} onRestart={restart} />}
      control={
        <Switch
          id={id}
          label="Use the Octo router"
          disabled={!s.editable}
          checked={s.value === true}
          onChange={(on) => void run(() => harness.save({ set: { [s.id]: on } }))}
        />
      }
    />
  );
}

function RouterUrl() {
  const harness = useHarnessSettings();
  const { restart } = useSettingsActions();
  const [saved, run] = useSave();
  const id = useId();
  const s = harness.get(SETTING_IDS.routerBaseUrl);
  const stored = typeof s?.value === "string" ? s.value : "";
  const [draft, setDraft] = useState<string | null>(null);
  if (!s) return null;
  const value = draft ?? stored;
  const commit = () => {
    if (draft === null || draft.trim() === stored) return setDraft(null);
    void run(() => harness.save({ set: { [s.id]: draft.trim() } })).then((ok) => ok && setDraft(null));
  };
  return (
    <SettingsRow
      rowId="router-url"
      title="External router URL"
      htmlFor={id}
      description="Leave empty to use the router bundled with the app."
      status={<SaveStatus state={saved} restart={harness.needsRestart(s.id)} onRestart={restart} />}
      control={
        <Input
          id={id}
          value={value}
          disabled={!s.editable}
          placeholder="http://127.0.0.1:8080"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape" && draft !== null) {
              e.preventDefault();
              setDraft(null);
            }
          }}
          className="w-64 font-mono text-xs max-settings:w-full max-sm:text-input-touch"
        />
      }
    />
  );
}
