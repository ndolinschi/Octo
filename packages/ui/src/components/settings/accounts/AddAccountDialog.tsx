import type { Provider } from "@octo/agent-client";
import { useState } from "react";
import { errorMessage, structuredError } from "../../../lib/format";
import { DEFAULT_ACCOUNT_NAME, accountName, accountNameProblem, refreshProviders } from "../../../lib/providers";
import { useApp } from "../../../state/app";
import { Button } from "../../primitives/Button";
import { Checkbox } from "../../primitives/Checkbox";
import { Dialog } from "../../primitives/Dialog";
import { Field } from "../../primitives/Field";
import { Notice } from "../../primitives/Notice";
import { TextField } from "../../primitives/TextField";

/**
 * "Add account": a name for the new login, and "Use an existing folder" (advanced) when the agent's login is already in a folder
 * of its own. When the agent has only its own login, the dialog also asks what to call it (prefilled "Personal"), because
 * two accounts need two names; that renames it first.
 */
export function AddAccountDialog(props: { base: string; baseLabel: string; accounts: readonly Provider[]; onClose(): void }) {
  const { bridge } = useApp();
  const onlyDefault = props.accounts.length <= 1;
  const [name, setName] = useState("");
  const [defaultName, setDefaultName] = useState(DEFAULT_ACCOUNT_NAME);
  const [existing, setExisting] = useState(false);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taken = props.accounts.map(accountName);
  const nameProblem = name === "" ? null : accountNameProblem(name, [...taken, ...(onlyDefault ? [defaultName] : [])]);
  const defaultProblem = onlyDefault ? accountNameProblem(defaultName, name.trim() === "" ? [] : [name]) : null;
  const folderProblem =
    existing && dir.trim() !== "" && !/^(?:\/|[A-Za-z]:[\\/]|~)/.test(dir.trim())
      ? "Use the full path of the folder, starting with / or a drive letter."
      : null;
  const valid = name.trim() !== "" && nameProblem === null && defaultProblem === null && folderProblem === null && (!existing || dir.trim() !== "");

  const add = async () => {
    const create = bridge.addAgentAccount;
    if (!create || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (onlyDefault) {
        const current = props.accounts[0];
        if (current && bridge.renameAgentAccount && defaultName.trim() !== accountName(current))
          await bridge.renameAgentAccount(current.id, defaultName.trim());
      }
      await create(props.base, { name: name.trim(), ...(existing && dir.trim() ? { dir: dir.trim() } : {}) });
      await refreshProviders(bridge);
      props.onClose();
    } catch (e) {
      const s = structuredError(e);
      setError(s ? `${s.message}${s.hint ? ` ${s.hint}` : ""}` : `${errorMessage(e)}. Check the name and folder, then try again.`);
      await refreshProviders(bridge).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Add a ${props.baseLabel} account`}
      description="A second login for the same agent, kept apart from your first. Octo never stores the password or key; the agent keeps its own login in its folder."
      width="sm"
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void add()}>
            Add account
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        {onlyDefault && (
          <Field label="Name of your current account" htmlFor="account-default-name" error={defaultProblem} hint="Shown next to the new one in the model list.">
            <TextField id="account-default-name" value={defaultName} maxLength={40} onChange={(e) => setDefaultName(e.target.value)} />
          </Field>
        )}
        <Field label="Name of the new account" htmlFor="account-name" error={nameProblem} hint="For example Work or Team.">
          <TextField id="account-name" data-autofocus value={name} maxLength={40} placeholder="Work" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Checkbox
          checked={existing}
          onChange={setExisting}
          label="Use an existing folder"
          description="Advanced: the agent already has a login in a folder of your choice."
        />
        {existing && (
          <Field label="Folder" htmlFor="account-dir" error={folderProblem} hint="Octo uses this folder as it is and never deletes it.">
            <TextField id="account-dir" className="font-mono" value={dir} placeholder="/Users/you/.claude-work" onChange={(e) => setDir(e.target.value)} />
          </Field>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Dialog>
  );
}
