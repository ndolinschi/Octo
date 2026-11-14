import { SETTING_IDS } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { Button } from "../primitives/Button";
import { SecretForm } from "../shared/SecretForm";
import { KeyLink } from "../shared/providers/ConnectSteps";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { Notice } from "../primitives/Notice";
import { SaveStatus } from "./parts";
import { useSave } from "./useSave";

/**
 * Decision 89 d: the API provider's key is a field in its detail pane (write-only, through the settings API), never prose
 * about an environment variable. Ready: "Replace key" and a quiet "Remove key".
 */
export function ProviderKey() {
  const harness = useHarnessSettings();
  const { restart } = useSettingsActions();
  const [saved, run] = useSave();
  const [confirm, setConfirm] = useState(false);
  // Esc while "Confirm remove key" is armed takes the confirmation back; it must not also leave Settings (capture: before the page's own Esc).
  useEffect(() => {
    if (!confirm) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setConfirm(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirm]);
  const id = SETTING_IDS.anthropicApiKey;
  const s = harness.get(id);
  return (
    // S5: one label for the key ("API key", the field's own), not a caption, a state line and a field label saying it thrice.
    <section id="row-api-key" aria-label="API key" className="flex flex-col gap-3">
      {harness.load.status === "loading" && <p className="text-sm text-fg-3">Loading…</p>}
      {harness.load.status === "unavailable" && <p className="text-sm text-fg-2">This connection cannot read or change Octo&apos;s settings.</p>}
      {harness.load.status === "error" && (
        <Notice
          tone="error"
          action={
            <Button variant="link" size="xs" onClick={harness.reload}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load the settings. {harness.load.message}. Octo&apos;s local service answers only on this computer.
        </Notice>
      )}
      {s && !s.editable && <p className="text-sm text-fg-2">{s.note ?? `The key is set by the ${s.source}; change it there.`}</p>}
      {s?.editable && (
        <>
          <div className="max-w-measure">
            <SecretForm
              label="API key"
              set={s.set === true}
              hint={s.hint}
              placeholder="sk-ant-…"
              showSaved={!harness.needsRestart(id)}
              onSave={(value) => harness.save({ set: { [id]: value } })}
            />
          </div>
          <KeyLink kind="api" />
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
