import type { ProviderList } from "@octo/agent-client";
import { useState } from "react";
import { canRun, chipLabel } from "../../lib/providers";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { useSettingsActions } from "./pageContext";
import { runnableSwap } from "./modelRows";

/**
 * One notice above a group of models that share a problem: the chosen models that cannot run, named once each (the rows below
 * show only their value). A3: it says what is true — which provider they need, and which connected agent can run instead —
 * and offers that switch in one click for every row at once (`onApply` gets the new value per row, `undefined` = unchanged).
 * "Undo" puts the old values back until the notice is left.
 */
export function ModelsProblem(props: { list: ProviderList; values: readonly string[]; onApply(next: readonly (string | undefined)[]): Promise<void> }) {
  const { connect } = useSettingsActions();
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ before: readonly string[]; text: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { list, values } = props;
  const stuck = values.filter((v) => v !== "" && !canRun(list, v));
  const run = async (next: readonly (string | undefined)[], after: () => void) => {
    setBusy(true);
    setFailed(null);
    try {
      await props.onApply(next);
      after();
    } catch {
      setFailed("Could not change the models. Choose them again below.");
    }
    setBusy(false);
  };
  if (stuck.length === 0) {
    if (!undo) return null;
    return (
      <Notice
        tone="success"
        className="px-settings-inset"
        action={
          <Button variant="link" size="xs" disabled={busy} onClick={() => void run(undo.before, () => setUndo(null))}>
            Undo
          </Button>
        }
      >
        {undo.text}
      </Notice>
    );
  }
  const names = [...new Set(stuck.map((v) => chipLabel(v, list)))];
  const many = names.length > 1;
  const needAgent = stuck.find((v) => v.startsWith("acp:"));
  const need = needAgent
    ? `${many ? "They need" : "It needs"} ${chipLabel(needAgent.split("/")[0] ?? needAgent, list)}, which is not ready.`
    : `${many ? "These models need" : "This model needs"} an Anthropic API key or the router.`;
  const swaps = values.map((v) => (v !== "" && !canRun(list, v) ? (runnableSwap(list, v) ?? undefined) : undefined));
  const targets = [...new Set(swaps.filter((s): s is string => s !== undefined))];
  const agentName = targets[0] ? chipLabel(targets[0].split("/")[0] ?? targets[0], list) : null;
  const choice = targets.length === 1 && targets[0] ? chipLabel(targets[0], list) : agentName;
  return (
    <Notice
      tone="warn"
      // S1: on the page's one left edge (the captions' and labels').
      className="px-settings-inset"
      action={
        choice ? (
          <Button variant="link" size="xs" disabled={busy} onClick={() => void run(swaps, () => setUndo({ before: values, text: `Switched to ${choice}.` }))}>
            Use {choice} instead
          </Button>
        ) : (
          <Button variant="link" size="xs" onClick={() => connect("providers")}>
            Connect a provider
          </Button>
        )
      }
    >
      {names.join(", ")} cannot run. {need}
      {agentName ? ` ${agentName} is connected and can run instead.` : ""}
      {failed ? ` ${failed}` : ""}
    </Notice>
  );
}
