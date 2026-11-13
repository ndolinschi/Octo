import type { ProviderList } from "@octo/agent-client";
import { canRun, chipLabel } from "../../lib/providers";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { useSettingsActions } from "./pageContext";

/**
 * One notice above a group of models that share a problem: the chosen models whose provider is not connected, named once each.
 * The rows below show only their value (a notice under every row said the same four times).
 */
export function ModelsProblem(props: { list: ProviderList; values: readonly string[] }) {
  const { connect } = useSettingsActions();
  const names = [...new Set(props.values.filter((v) => v !== "" && !canRun(props.list, v)).map((v) => chipLabel(v, props.list)))];
  if (names.length === 0) return null;
  const many = names.length > 1;
  return (
    <Notice
      tone="warn"
      action={
        <Button variant="link" size="xs" onClick={() => connect("providers")}>
          Connect a provider
        </Button>
      }
    >
      {names.join(", ")} {many ? "cannot run: their providers are" : "cannot run: its provider is"} not connected.
    </Notice>
  );
}
