import type { Provider } from "@octo/agent-client";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  accountName,
  accountsOf,
  accountStatus,
  agentBaseLabel,
  baseIdOf,
  isDefaultAccount,
  loginChoices,
  recheckAgent,
  refreshProviders,
  stateTone,
  useProviders,
} from "../../../lib/providers";
import { errorMessage, structuredError } from "../../../lib/format";
import { useApp } from "../../../state/app";
import { Button } from "../../primitives/Button";
import type { MenuItem } from "../../primitives/Menu";
import { MenuButton } from "../../primitives/MenuButton";
import { Presence } from "../../primitives/Presence";
import { TextField } from "../../primitives/TextField";
import { ErrorNotice } from "../../shared/ErrorNotice";
import { ToneDot } from "../../shared/providers/ProviderRows";
import { SectionTitle } from "../ProviderParts";
import { AddAccountDialog } from "./AddAccountDialog";
import { RemoveAccountDialog } from "./RemoveAccountDialog";

/** The login sheet and its terminal are their own chunk: nothing of it loads until "Log in" is pressed. */
const LoginSheet = lazy(() => import("./LoginSheet").then((m) => ({ default: m.LoginSheet })));

/** A failed action as the notice reads it: the harness's own fields, else its message with a next step. */
function failure(e: unknown): { message: string; hint?: string; command?: string; details?: string } {
  const s = structuredError(e);
  return s ?? { message: errorMessage(e), hint: "Try again, or check that Octo's local service is running." };
}

/**
 * Settings → Providers → an agent with accounts (design 2026-11-26 section 9). One row per account: a state dot, the name,
 * its folder (dim), then Log in (a menu when the agent has several methods), Check again, Rename and Remove. "Add account"
 * asks for a name. An agent that cannot have accounts says so in one line; an older harness (no `accounts_support`) shows
 * nothing here and keeps the login command of the detail. An agent that is not installed shows no account and no Log in
 * (the install guidance above says what to do); `loginBlock` says the detail's own "Log in" step already carries the one
 * Log in button, so this section adds none.
 */
export function AccountsSection({ provider, loginBlock = false }: { provider: Provider; loginBlock?: boolean }) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const all = providers.status === "loading" ? [] : (providers.list?.providers ?? []);
  const base = baseIdOf(provider);
  const support = (all.find((p) => p.id === base) ?? provider).accounts_support;
  const [login, setLogin] = useState<{ id: string; method: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const notInstalled = (all.find((p) => p.id === base) ?? provider).state === "not_installed";
  if (support === undefined)
    return provider.login_methods && !notInstalled && !loginBlock ? (
      <section className="flex flex-col items-start gap-1">
        <SectionTitle>Log in</SectionTitle>
        <LoginButton provider={provider} />
      </section>
    ) : null;
  if (!support.supported)
    return (
      <section className="flex flex-col items-start gap-2">
        <p data-accounts-unsupported className="text-sm text-fg-2">
          One account only{support.reason ? `: ${support.reason.replace(/\.$/, "")}.` : "."}
        </p>
        {!notInstalled && !loginBlock && <LoginButton provider={provider} />}
      </section>
    );
  if (notInstalled) return null;

  const accounts = accountsOf(all, base);
  const canWrite = bridge.addAgentAccount !== undefined && bridge.renameAgentAccount !== undefined && bridge.removeAgentAccount !== undefined;
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const commitRename = (p: Provider) => {
    const name = draft.trim();
    const rename = bridge.renameAgentAccount;
    if (!rename || name === "" || name === accountName(p)) return setRenaming(null);
    void run(`rename:${p.id}`, async () => {
      await rename(p.id, name);
      await refreshProviders(bridge);
      setRenaming(null);
    });
  };
  const loginItems = (p: Provider): MenuItem[] =>
    loginChoices(p).map((m) => ({ id: m.id || "login", label: m.label, run: () => setLogin({ id: p.id, method: m.id }) }));
  const loginFor = login ? all.find((p) => p.id === login.id) : undefined;
  const removeFor = removing ? all.find((p) => p.id === removing) : undefined;

  return (
    <section data-accounts className="flex min-w-0 flex-col gap-1">
      <SectionTitle
        aside={
          canWrite ? (
            <Button variant="quiet" size="xs" onClick={() => setAdding(true)} className="-mr-2">
              Add account
            </Button>
          ) : undefined
        }
      >
        Accounts
      </SectionTitle>
      {error !== null && <ErrorNotice fields={failure(error)} data="accounts-error" />}
      <ul className="flex min-w-0 flex-col divide-y divide-line">
        {accounts.map((p) => {
          const methods = loginChoices(p);
          const isDefault = isDefaultAccount(p);
          const name = accountName(p);
          return (
            <li key={p.id} data-account={p.id} className="flex min-w-0 flex-col gap-1 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <ToneDot tone={stateTone(p)} />
                {renaming === p.id ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitRename(p);
                    }}
                  >
                    <RenameField aria-label={`Name of ${name}`} value={draft} onChange={setDraft} onCancel={() => setRenaming(null)} />
                    <Button type="submit" size="xs" variant="secondary" loading={busy === `rename:${p.id}`}>
                      Save
                    </Button>
                    <Button type="button" size="xs" variant="quiet" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 truncate text-sm text-fg">{name}</span>
                    <span className="shrink-0 text-xs text-fg-3">{accountStatus(p)}</span>
                  </>
                )}
              </div>
              {p.account?.dir && (
                <p className="truncate pl-4 font-mono text-xs text-fg-3" title={p.account.dir}>
                  {p.account.dir}
                </p>
              )}
              {renaming !== p.id && (
                <div className="flex min-w-0 flex-wrap items-center gap-x-1 pl-2">
                  <div className="flex items-center gap-x-1">
                    {methods.length > 1 ? (
                      <MenuButton label={`Log in to ${name}`} text="Log in" items={loginItems(p)} />
                    ) : (
                      methods.length === 1 && (
                        <Button variant="quiet" size="xs" onClick={() => setLogin({ id: p.id, method: methods[0]?.id ?? "" })}>
                          Log in
                        </Button>
                      )
                    )}
                    <Button
                      variant="quiet"
                      size="xs"
                      loading={busy === `check:${p.id}`}
                      onClick={() => void run(`check:${p.id}`, () => recheckAgent(bridge, p.id))}
                    >
                      Check again
                    </Button>
                  </div>
                  <div className="flex items-center gap-x-1">
                    {bridge.renameAgentAccount && (
                      <Button
                        variant="quiet"
                        size="xs"
                        onClick={() => {
                          setDraft(name);
                          setRenaming(p.id);
                        }}
                      >
                        Rename
                      </Button>
                    )}
                    {bridge.removeAgentAccount && !isDefault && (
                      <Button variant="danger" size="xs" onClick={() => setRemoving(p.id)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {support.note && <p className="text-xs text-fg-3">{support.note}</p>}
      <Presence show={adding}>
        {adding && (
          <AddAccountDialog
            base={base}
            baseLabel={agentBaseLabel(all.find((p) => p.id === base) ?? provider)}
            accounts={accounts}
            onClose={() => setAdding(false)}
          />
        )}
      </Presence>
      <Presence show={removeFor !== undefined}>{removeFor && <RemoveAccountDialog provider={removeFor} onClose={() => setRemoving(null)} />}</Presence>
      <Presence show={loginFor !== undefined}>
        {loginFor && login && (
          <Suspense fallback={null}>
            <LoginSheet provider={loginFor} method={login.method || undefined} onClose={() => setLogin(null)} />
          </Suspense>
        )}
      </Presence>
    </section>
  );
}

/** The name field of a row being renamed: focused when it appears, Escape leaves it. */
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

/**
 * The agent has one login only (no accounts block, or an agent that cannot have accounts) but a login method: the same
 * sheet, from one button under its command.
 */
export function LoginButton({ provider }: { provider: Provider }) {
  const [open, setOpen] = useState<string | null>(null);
  const methods = loginChoices(provider);
  if (provider.login_methods === undefined || methods.length === 0) return null;
  const items: MenuItem[] = methods.map((m) => ({ id: m.id || "login", label: m.label, run: () => setOpen(m.id) }));
  return (
    <>
      {methods.length > 1 ? (
        <MenuButton label={`Log in to ${provider.label}`} text="Log in" items={items} />
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setOpen(methods[0]?.id ?? "")}>
          Log in
        </Button>
      )}
      <Presence show={open !== null}>
        {open !== null && (
          <Suspense fallback={null}>
            <LoginSheet provider={provider} method={open || undefined} onClose={() => setOpen(null)} />
          </Suspense>
        )}
      </Presence>
    </>
  );
}
