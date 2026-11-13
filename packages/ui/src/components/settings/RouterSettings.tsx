import { SETTING_IDS } from "@octo/agent-client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../primitives/Button";
import { ListFrame } from "../primitives/Card";
import { SkeletonList } from "../primitives/Skeleton";
import { Switch } from "../primitives/Switch";
import { TextField } from "../primitives/TextField";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { CONTROL_W, LoadErrorRow, SaveStatus, SettingsRow } from "./parts";
import { useSave } from "./useSave";

/** The router's switch, URL and upstream key, folded (decision 59; the API key moved into its provider's detail, decision 89). Values are write-only. */
export function RouterSettings() {
  const [open, setOpen] = useState(false);
  const harness = useHarnessSettings();
  const panelId = useId();
  return (
    <section className="flex flex-col gap-2">
      <Button
        variant="quiet"
        size="xs"
        icon={open ? ChevronDown : ChevronRight}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="self-start"
      >
        Router
      </Button>
      <div id={panelId} hidden={!open}>
        <ListFrame>
          {harness.load.status === "unavailable" && (
            <SettingsRow title="Not available here" description="This connection cannot read or change the harness's settings." />
          )}
          {harness.load.status === "loading" && <SkeletonList count={1} size="lg" twoLine />}
          {harness.load.status === "error" && (
            <LoadErrorRow what="settings" message={harness.load.message} hint="The harness answers only on this machine (loopback)." onRetry={harness.reload} />
          )}
          {harness.load.status === "ready" && (
            <>
              <RouterSwitch />
              <RouterUrl />
              <SecretRow id={SETTING_IDS.routerUpstreamKey} rowId="upstream-key" target="router-upstream" />
            </>
          )}
        </ListFrame>
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
        <TextField
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
          className={`${CONTROL_W.lg} font-mono`}
        />
      }
    />
  );
}
