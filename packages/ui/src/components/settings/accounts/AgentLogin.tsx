import type { Provider } from "@octo/agent-client";
import { lazy, Suspense, useState } from "react";
import { loginChoices } from "../../../lib/providers";
import { Button } from "../../primitives/Button";
import type { MenuItem } from "../../primitives/Menu";
import { MenuButton } from "../../primitives/MenuButton";
import { Presence } from "../../primitives/Presence";

/** The login sheet and its terminal are their own chunk: nothing of it loads until "Log in" is pressed. */
const LoginSheet = lazy(() => import("./LoginSheet").then((m) => ({ default: m.LoginSheet })));

/**
 * "Log in" for one agent entry (its own login or one of its accounts): the agent's login command runs in the login sheet's
 * terminal. A menu when the agent has several methods; nothing when the harness names no login method (an older harness,
 * or a CLI without one) or the bridge cannot start a login.
 */
export function LoginButton({ provider, size = "sm", quiet = false }: { provider: Provider; size?: "xs" | "sm"; quiet?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const methods = loginChoices(provider);
  if (provider.login_methods === undefined || methods.length === 0) return null;
  const items: MenuItem[] = methods.map((m) => ({ id: m.id || "login", label: m.label, run: () => setOpen(m.id) }));
  return (
    <>
      {methods.length > 1 ? (
        <MenuButton label={`Log in to ${provider.label}`} text="Log in" size={size} items={items} />
      ) : (
        <Button variant={quiet ? "quiet" : "secondary"} size={size} onClick={() => setOpen(methods[0]?.id ?? "")}>
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

/** An agent that keeps one login only says why in one line ("One account only: <reason>"), with its Log in unless shown above. */
export function OneAccountOnly({ provider, withLogin }: { provider: Provider; withLogin: boolean }) {
  const reason = (provider.account_unsupported ?? "").replace(/\.$/, "");
  return (
    <section className="flex flex-col items-start gap-2">
      <p data-accounts-unsupported className="text-sm text-fg-2">
        One account only{reason ? `: ${reason}.` : "."}
      </p>
      {withLogin && <LoginButton provider={provider} />}
    </section>
  );
}
