import type { Provider } from "@octo/agent-client";
import { useId, useState } from "react";
import { accountBase, accountsOf, refreshProviders, stateTone, suggestedAccountDir, providerStateText, useProviders } from "../../lib/providers";
import { errorMessage, structuredError } from "../../lib/format";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { FieldRow } from "../primitives/FieldRow";
import { Notice } from "../primitives/Notice";
import { TextField } from "../primitives/TextField";
import { ToneDot } from "../shared/providers/ProviderRows";
import { SectionTitle } from "./ProviderParts";

/**
 * Agent accounts: more logins of one agent (Claude Code, Codex), each in its own folder that the agent's CLI is pointed at
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Every account is listed and chosen as an agent of its own, so a project, a session
 * or a delegation picks the account in the ordinary model picker. Octo keeps only the name and the folder; the user logs
 * the folder in with the CLI (the account's own detail shows the command).
 */
export function AgentAccounts({ agent, onOpen }: { agent: Provider; onOpen?: (id: string) => void }) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const all = providers.status === "loading" ? [] : (providers.list?.providers ?? []);
  const accounts = accountsOf(all, agent.id);
  const [label, setLabel] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const base = useId();
  const env = agent.account_env ?? "";
  const folder = dir.trim() || suggestedAccountDir(agent, label);
  const add = async () => {
    if (!bridge.addAgentAccount || busy) return;
    if (!label.trim()) {
      setError({ message: "An account needs a short name." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const added = await bridge.addAgentAccount(agent.id, { label: label.trim(), config_dir: folder });
      await refreshProviders(bridge);
      setLabel("");
      setDir("");
      if (added) onOpen?.(added.id);
    } catch (e) {
      const s = structuredError(e);
      setError(s ? { message: s.message, ...(s.hint ? { hint: s.hint } : {}) } : { message: errorMessage(e) });
    }
    setBusy(false);
  };
  return (
    <section aria-label="Accounts" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionTitle>Accounts</SectionTitle>
        <ul className="flex flex-col">
          <AccountRow name="Default" folder={agent.account_default ?? "The CLI's own folder"} provider={agent} />
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              name={a.account_label ?? a.label}
              folder={a.account_dir ?? ""}
              provider={a}
              onOpen={onOpen ? () => onOpen(a.id) : undefined}
            />
          ))}
        </ul>
      </div>
      {bridge.addAgentAccount && (
        <div className="flex flex-col gap-2">
          <FieldRow
            fields={[
              {
                id: `${base}-name`,
                label: "Account name",
                control: <TextField id={`${base}-name`} value={label} placeholder="Work" maxLength={40} onChange={(e) => setLabel(e.target.value)} />,
              },
              {
                id: `${base}-dir`,
                label: "Login folder",
                control: (
                  <TextField
                    id={`${base}-dir`}
                    value={dir}
                    placeholder={suggestedAccountDir(agent, label)}
                    spellCheck={false}
                    className="font-mono"
                    onChange={(e) => setDir(e.target.value)}
                  />
                ),
              },
            ]}
            hint={`Octo starts ${agent.label} with ${env} set to this folder, so the account keeps its own login there. Octo stores only the name and the folder.`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" aria-busy={busy} onClick={() => void add()}>
              {busy ? "Adding…" : "Add account"}
            </Button>
            {error && (
              <Notice tone="error">
                {error.message}
                {error.hint ? ` ${error.hint}` : ""}
              </Notice>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function AccountRow({ name, folder, provider, onOpen }: { name: string; folder: string; provider: Provider; onOpen?: (() => void) | undefined }) {
  return (
    <li className="flex min-h-ctl-md items-center gap-3 border-b border-line py-1.5 last:border-b-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-fg">{name}</span>
        <span className="truncate font-mono text-xs text-fg-3">{folder}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-fg-2">
        <ToneDot tone={stateTone(provider)} />
        {providerStateText(provider)}
      </span>
      {onOpen && (
        <Button variant="quiet" size="xs" onClick={onOpen}>
          Open
        </Button>
      )}
    </li>
  );
}

/** An account's own detail: which agent and folder it is, and "Remove account" (the folder and its login stay). */
export function AccountFacts({ account, onRemoved }: { account: Provider; onRemoved?: () => void }) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const all = providers.status === "loading" ? [] : (providers.list?.providers ?? []);
  const agent = accountBase(all, account);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    if (!bridge.removeAgentAccount || !account.account_of || !account.account_id || busy) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    try {
      await bridge.removeAgentAccount(account.account_of, account.account_id);
      await refreshProviders(bridge);
      onRemoved?.();
    } catch (e) {
      setError(errorMessage(e));
      setConfirm(false);
    }
    setBusy(false);
  };
  return (
    <section aria-label="Account" className="flex flex-col gap-1">
      <SectionTitle>Account</SectionTitle>
      <p className="text-sm text-fg-2">
        {`An account of ${agent?.label ?? account.account_of ?? "this agent"}. Its login is kept in `}
        <code className="font-mono text-fg">{account.account_dir}</code>
        {agent?.account_env ? ` (${agent.account_env}).` : "."}
      </p>
      <p className="text-xs text-fg-3">Choose it in any model picker to run a project, a session or a delegation on this login.</p>
      {bridge.removeAgentAccount && (
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button size="sm" variant={confirm ? "danger" : "secondary"} aria-busy={busy} onClick={() => void remove()} onBlur={() => setConfirm(false)}>
            {confirm ? "Remove account?" : "Remove account"}
          </Button>
          {confirm && <span className="text-xs text-fg-3">The folder and the login in it stay on this computer.</span>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
    </section>
  );
}
