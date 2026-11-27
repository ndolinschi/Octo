import type { Provider } from "@octo/agent-client";
import { useEffect, useRef, useState } from "react";
import { accountStatus, refreshProviders, stateTone } from "../../../lib/providers";
import { errorMessage, structuredError } from "../../../lib/format";
import { useApp } from "../../../state/app";
import { Button } from "../../primitives/Button";
import { Notice } from "../../primitives/Notice";
import { TextField } from "../../primitives/TextField";
import { ToneDot } from "../../shared/providers/ProviderRows";
import { LoginButton } from "./AgentLogin";

/**
 * One login in an agent's Accounts list: its state dot, name and folder, its state (with "limit reached" when it is), and
 * Log in, Rename and Open. Rename edits the name in place; `provider.id` is what the rename names (the agent's own id
 * names its default login).
 */
export function AccountRow({ name, folder, provider, onOpen }: { name: string; folder: string; provider: Provider; onOpen?: (() => void) | undefined }) {
  const { bridge } = useApp();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const label = (draft ?? "").trim();
    const rename = bridge.renameAgentAccount;
    if (!rename || busy) return;
    if (label === "" || label === name) return setDraft(null);
    setBusy(true);
    setError("");
    try {
      await rename(provider.id, label);
      await refreshProviders(bridge);
      setDraft(null);
    } catch (e) {
      const s = structuredError(e);
      setError(s ? `${s.message}${s.hint ? ` ${s.hint}` : ""}` : `${errorMessage(e)}. Try again.`);
    }
    setBusy(false);
  };
  return (
    <li data-account={provider.id} className="flex min-w-0 flex-col gap-1 border-b border-line py-1.5 last:border-b-0">
      <div className="flex min-h-ctl-md min-w-0 items-center gap-3">
        {draft !== null ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <RenameField aria-label={`Name of ${name}`} value={draft} onChange={setDraft} onCancel={() => setDraft(null)} />
            <Button type="submit" size="xs" variant="secondary" loading={busy}>
              Save
            </Button>
            <Button type="button" size="xs" variant="quiet" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-fg">{name}</span>
              <span className="truncate font-mono text-xs text-fg-3">{folder}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-fg-2">
              <ToneDot tone={stateTone(provider)} />
              {accountStatus(provider)}
            </span>
          </>
        )}
      </div>
      {draft === null && (
        <div className="flex flex-wrap items-center gap-x-1">
          {provider.state !== "not_installed" && <LoginButton provider={provider} size="xs" quiet />}
          {bridge.renameAgentAccount && (
            <Button variant="quiet" size="xs" onClick={() => setDraft(name)}>
              Rename
            </Button>
          )}
          {onOpen && (
            <Button variant="quiet" size="xs" onClick={onOpen}>
              Open
            </Button>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </li>
  );
}

/** The name field of a row being renamed: selected when it appears, Escape leaves it. */
function RenameField(props: { "aria-label": string; value: string; onChange(value: string): void; onCancel(): void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.select(), []);
  return (
    <TextField
      ref={field}
      size="sm"
      aria-label={props["aria-label"]}
      value={props.value}
      maxLength={40}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onCancel();
        }
      }}
      className="min-w-0 flex-1"
    />
  );
}
