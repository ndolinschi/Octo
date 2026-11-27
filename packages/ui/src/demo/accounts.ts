import {
  BridgeError,
  type AgentLoginOptions,
  type AgentLoginSession,
  type AgentLoginState,
  type LoginMethod,
  type Provider,
  type TerminalExit,
} from "@octo/agent-client";

/**
 * Demo additions to the agent accounts of `providers.ts` (which keeps the accounts themselves, `?accounts=work`): the login
 * methods and login sheet (a fake link and code that turns `ok` after Enter or 3 seconds), the "one account only" reasons, a
 * name for the agent's own login (rename), and `?limit=<provider id>` (that entry has reached its plan limit). Nothing here
 * touches a real folder.
 */

/** Why the demo agents without `account_env` keep one login only (the harness's `account_unsupported`). */
const REASONS: Record<string, string> = {
  copilot: "Octo has not yet confirmed how to keep a second GitHub Copilot sign-in apart.",
  grok: "Octo could not confirm where Grok keeps its sign-in, so a second one cannot be kept apart.",
};
const NO_WAY = "Octo knows no documented way to keep a second login of this CLI apart.";

const METHODS: Record<string, LoginMethod[]> = {
  "claude-code": [
    { id: "claudeai", label: "Claude subscription" },
    { id: "console", label: "Anthropic Console" },
  ],
  codex: [
    { id: "browser", label: "Browser sign-in" },
    { id: "device", label: "Device code" },
  ],
  copilot: [{ id: "login", label: "GitHub account" }],
  grok: [{ id: "login", label: "xAI account" }],
};
const LOGIN_COMMAND: Record<string, string> = { "claude-code": "claude auth login", codex: "codex login", copilot: "copilot login", grok: "grok login" };
const LOGIN_PAGE: Record<string, string> = {
  "claude-code": "https://claude.ai/oauth/authorize?client_id=octo-demo",
  codex: "https://auth.openai.com/codex/device",
};

const encoder = new TextEncoder();

export type DemoAccountExtrasOptions = { limit?: string | null; loggedIn: Set<string> };

export function demoAccountExtras(options: DemoAccountExtrasOptions) {
  const { loggedIn } = options;
  /** Names the user gave the agents' own logins (`renameAgentAccount` with the agent's id). */
  const defaultLabels = new Map<string, string>();
  const limit = (id: string): Pick<Provider, "limit"> => {
    if (options.limit !== id) return {};
    const now = Date.now();
    return { limit: { reached_at: new Date(now - 5 * 60_000).toISOString(), resets_at: new Date(now + 90 * 60_000).toISOString() } };
  };
  const baseOf = (p: Pick<Provider, "id" | "account_of">) => p.account_of ?? p.id;

  /** The list as the harness lists it: login methods and commands, the reasons, the default account's name, a limit. */
  const decorate = (list: readonly Provider[]): Provider[] =>
    list.map((p): Provider => {
      if (p.kind !== "agent") return p;
      const base = baseOf(p);
      const methods = METHODS[base];
      const named = !p.account_of && p.account_env ? defaultLabels.get(p.id) : undefined;
      const command =
        p.account_of && p.account_dir
          ? `${list.find((x) => x.id === base)?.account_env ?? ""}=${p.account_dir} ${LOGIN_COMMAND[base] ?? ""}`
          : LOGIN_COMMAND[base];
      return {
        ...p,
        ...(named ? { label: `${p.label} · ${named}`, account_default_label: named } : {}),
        ...(!p.account_of && !p.account_env ? { account_unsupported: REASONS[p.id] ?? NO_WAY } : {}),
        ...(methods ? { login_methods: methods } : {}),
        ...(command ? { login_command: command.trim() } : {}),
        ...limit(p.id),
      };
    });

  return {
    decorate,
    defaultLabels,
    /** The agent a `?limit=` turn fails on (its provider id), or null. */
    limitedId: (): string | null => options.limit ?? null,
    /** A login that prints a fake link and code, and turns `ok` after Enter or 3 seconds. */
    login(provider: Provider, opts?: AgentLoginOptions): AgentLoginSession {
      const base = baseOf(provider);
      const methods = METHODS[base];
      if (!methods) {
        throw Object.assign(new BridgeError(409, "login_unavailable", `${provider.label} cannot be logged in from Octo.`), {
          hint: "Log in to it in a terminal, then check again.",
        });
      }
      const providerId = provider.id;
      const outputs = new Set<(data: Uint8Array) => void>();
      const exits = new Set<(info: TerminalExit) => void>();
      const logins = new Set<(state: AgentLoginState) => void>();
      const pending: Uint8Array[] = [];
      let last: AgentLoginState | undefined;
      let closed = false;
      let finished = false;
      const emit = (text: string) => {
        if (closed) return;
        const bytes = encoder.encode(text);
        if (outputs.size === 0) pending.push(bytes);
        else outputs.forEach((fn) => fn(bytes));
      };
      const finish = () => {
        if (finished || closed) return;
        finished = true;
        clearTimeout(timer);
        emit("\r\nLogged in.\r\n");
        loggedIn.add(providerId);
        exits.forEach((fn) => fn({ code: 0 }));
        last = "ok";
        logins.forEach((fn) => fn("ok"));
      };
      const page = LOGIN_PAGE[base] ?? "https://example.com/login";
      const method = methods.find((m) => m.id === opts?.method)?.label;
      emit(
        `Starting the login${method ? ` (${method})` : ""}…\r\n\r\nOpen this link in your browser to sign in:\r\n\r\n  ${page}&state=${providerId.replace("@", "-")}\r\n\r\nYour one-time code: OCTO-4821\r\n\r\nPress Enter when you have signed in.\r\n`,
      );
      const timer = setTimeout(finish, 3000);
      (timer as { unref?: () => void }).unref?.();
      return {
        sessionId: `login-${providerId}`,
        pid: 52_000,
        command: provider.login_command ?? "",
        write: async (data) => {
          if (/[\r\n]/.test(data)) finish();
          else emit(data);
        },
        resize: async () => undefined,
        onOutput: (cb) => {
          outputs.add(cb);
          for (const chunk of pending.splice(0)) cb(chunk);
          return () => void outputs.delete(cb);
        },
        onExit: (cb) => {
          exits.add(cb);
          return () => void exits.delete(cb);
        },
        onLogin: (cb) => {
          logins.add(cb);
          if (last !== undefined) cb(last);
          return () => void logins.delete(cb);
        },
        close: async () => {
          closed = true;
          clearTimeout(timer);
        },
      };
    },
  };
}
