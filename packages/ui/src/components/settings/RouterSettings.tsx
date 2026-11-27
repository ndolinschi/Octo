import { SETTING_IDS } from "@octo/agent-client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../primitives/Button";
import { SkeletonList } from "../primitives/Skeleton";
import { Switch } from "../primitives/Switch";
import { TextField } from "../primitives/TextField";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { CONTROL_W, LoadErrorRow, SaveStatus, SettingsGroup, SettingsRow } from "./parts";
import { useSave } from "./useSave";

/** The router's switch, URL and upstream key, folded (decision 59; the API key moved into its provider's detail, decision 89). Values are write-only. */
export function RouterSettings(props: { open?: boolean; onOpen?(open: boolean): void }) {
  const [own, setOwn] = useState(false);
  const open = props.open ?? own;
  const setOpen = (next: (o: boolean) => boolean) => (props.onOpen ? props.onOpen(next(open)) : setOwn(next));
  const harness = useHarnessSettings();
  const panelId = useId();
  // S1: a group like every other (caption over one surface), folded to one row until it is opened (decision 89).
  return (
    <SettingsGroup label="Router" id="row-router-group">
      <SettingsRow
        title="Octo router"
        // B7: the router by what it does for a person, and what happens without it.
        description="Optional. Uses cheaper models for small tasks and can cap spending. When off, each task uses its tier's model."
        control={
          <Button
            variant="quiet"
            size="sm"
            icon={open ? ChevronDown : ChevronRight}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            // A quiet button's text ends on the row's control edge, as a boxed control's frame does.
            className="-mr-2"
          >
            {open ? "Hide" : "Show"}
          </Button>
        }
      />
      {open && (
        <div id={panelId} className="divide-y divide-line">
          {harness.load.status === "unavailable" && <SettingsRow title="Not available here" description="This window can't read or change Octo's settings." />}
          {harness.load.status === "loading" && <SkeletonList count={3} size="lg" twoLine />}
          {harness.load.status === "error" && (
            <LoadErrorRow what="settings" message={harness.load.message} hint="Octo's local service answers only on this computer." onRetry={harness.reload} />
          )}
          {harness.load.status === "ready" && (
            <>
              <RouterSwitch />
              <RouterUrl />
              <SecretRow id={SETTING_IDS.routerUpstreamKey} rowId="upstream-key" target="router-upstream" />
            </>
          )}
        </div>
      )}
    </SettingsGroup>
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
            {s.set ? "Replace key" : "Add key"}
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
      description={s.editable ? "Octo starts the router that comes with the app and sends model requests through it." : (s.note ?? `Set by the ${s.source}`)}
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
        <div className={CONTROL_W.lg}>
          <TextField
            size="sm"
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
            className="font-mono"
          />
        </div>
      }
    />
  );
}
