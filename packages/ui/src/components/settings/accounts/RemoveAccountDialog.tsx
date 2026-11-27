import type { Provider } from "@octo/agent-client";
import { useState } from "react";
import { errorMessage, structuredError } from "../../../lib/format";
import { accountName, refreshProviders } from "../../../lib/providers";
import { useApp } from "../../../state/app";
import { Button } from "../../primitives/Button";
import { Checkbox } from "../../primitives/Checkbox";
import { Dialog } from "../../primitives/Dialog";
import { Notice } from "../../primitives/Notice";

/**
 * "Remove": Octo forgets the account; the checkbox that also deletes its login folder is offered only when Octo made the
 * folder (`owned`), and is off by default. The text is plain about what stays: a system keychain entry the CLI may have made
 * is not removed. The default account has no Remove button at all.
 */
export function RemoveAccountDialog(props: { provider: Provider; onClose(): void }) {
  const { bridge } = useApp();
  const p = props.provider;
  const name = accountName(p);
  const owned = p.account?.owned === true;
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    const run = bridge.removeAgentAccount;
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run(p.id, { deleteData: owned && deleteData });
      await refreshProviders(bridge);
      props.onClose();
    } catch (e) {
      const s = structuredError(e);
      setError(s ? `${s.message}${s.hint ? ` ${s.hint}` : ""}` : `${errorMessage(e)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Remove ${name}?`}
      description={`${p.label} will no longer be offered in the model list. Projects that use it show the model as unavailable until you pick another.`}
      width="sm"
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void remove()}>
            Remove account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {p.account?.dir && (
          <p className="text-sm text-fg-2">
            Its login folder is <span className="font-mono text-xs break-all text-fg">{p.account.dir}</span>.
          </p>
        )}
        {owned ? (
          <Checkbox
            data-autofocus
            checked={deleteData}
            onChange={setDeleteData}
            label="Also delete its login folder"
            description="Octo made this folder. Deleting it signs the account out for good."
          />
        ) : (
          <p className="text-sm text-fg-2">Octo did not make this folder, so it is left as it is.</p>
        )}
        <p className="text-xs text-fg-3">
          If the agent saved the login in your system keychain, that entry is not removed. Remove it from the keychain yourself if you want it gone.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
