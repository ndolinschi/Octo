import type { Provider } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { useState } from "react";
import { Button } from "../primitives/Button";
import { SecretForm } from "../shared/SecretForm";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { SaveStatus } from "./parts";
import { SectionTitle } from "./ProviderParts";
import { useSave } from "./useSave";

/**
 * Decision 89 d: the API provider's key is a field in its detail pane (write-only, through the settings API), never prose
 * about an environment variable. Ready: "Replace key" and a quiet "Remove key".
 */
export function ProviderKey({ provider }: { provider: Provider }) {
  const harness = useHarnessSettings();
  const { restart } = useSettingsActions();
  const [saved, run] = useSave();
  const [confirm, setConfirm] = useState(false);
  const id = SETTING_IDS.anthropicApiKey;
  const s = harness.get(id);
  return (
    <section id="row-api-key" className="flex flex-col gap-3">
      <SectionTitle>API key</SectionTitle>
      {harness.load.status === "loading" && <p className="text-sm text-fg-3">Loading…</p>}
      {harness.load.status === "unavailable" && <p className="text-sm text-fg-2">This connection cannot read or change the harness&apos;s settings.</p>}
      {harness.load.status === "error" && (
        <p role="alert" className="text-sm text-fg-2">
          <span className="text-err">Couldn&apos;t load the settings.</span> {harness.load.message}. The harness answers only on this machine.{" "}
          <button type="button" onClick={harness.reload} className="text-link hover:underline">
            Retry
          </button>
        </p>
      )}
      {s && !s.editable && <p className="text-sm text-fg-2">{s.note ?? `The key is set by the ${s.source}; change it there.`}</p>}
      {s?.editable && (
        <>
          <div className="max-w-measure">
            <SecretForm
              label={provider.state === "ready" ? "Replace the key" : "Anthropic API key"}
              set={s.set === true}
              hint={s.hint}
              placeholder="sk-ant-…"
              onSave={(value) => harness.save({ set: { [id]: value } })}
            />
          </div>
          {s.set === true && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant={confirm ? "danger" : "secondary"}
                onClick={() => (confirm ? void run(() => harness.save({ unset: [id] })).then(() => setConfirm(false)) : setConfirm(true))}
              >
                {confirm ? "Confirm remove key" : "Remove key"}
              </Button>
              <SaveStatus state={saved} />
            </div>
          )}
        </>
      )}
      {harness.needsRestart(id) && <SaveStatus state={{ kind: "idle" }} restart onRestart={restart} />}
    </section>
  );
}
