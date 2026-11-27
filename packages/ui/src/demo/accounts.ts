import {
  BridgeError,
  type AccountsSupport,
  type AgentAccount,
  type AgentAccountRemoved,
  type AgentLoginOptions,
  type AgentLoginSession,
  type AgentLoginState,
  type LoginMethod,
  type Provider,
  type TerminalExit,
} from "@octo/agent-client";

/**
 * Demo accounts (design 2026-11-26 section 9, `?accounts=claude|all`, `?limit=<provider id>`): the account state the demo
 * keeps in memory: which accounts exist, their names, the default account's name, and a fake login that prints a link and a
 * code and turns `ok` after Enter or 3 seconds. `providers.ts` decorates its provider list with it and exposes the four
 * bridge methods; nothing here touches a real folder.
 */

/** What each demo agent can do: Claude Code and Codex keep accounts apart, the others cannot (and say why). */
const REASONS: Record<string, string> = {
  antigravity: "Its login is shared by the app, the command line and the editor through one system keychain entry.",
  copilot: "Octo cannot keep a second GitHub Copilot login apart yet.",
  grok: "Octo cannot keep a second Grok login apart.",
};
const SUPPORTED: ReadonlySet<string> = new Set(["claude-code", "codex", "gemini", "devin"]);

export function supportOf(id: string): AccountsSupport {
  return SUPPORTED.has(id) ? { supported: true } : { supported: false, reason: REASONS[id] ?? "Octo cannot keep a second login apart for this agent." };
}

const METHODS: Record<string, LoginMethod[]> = {
  "claude-code": [
    { id: "claudeai", label: "Claude subscription" },
    { id: "console", label: "Anthropic Console (billed per token)" },
  ],
  codex: [
    { id: "browser", label: "Browser" },
    { id: "device", label: "Device code" },
  ],
  copilot: [{ id: "default", label: "GitHub account" }],
  grok: [{ id: "default", label: "Browser" }],
};
const LOGIN_COMMAND: Record<string, string> = { "claude-code": "claude auth login", codex: "codex login", copilot: "copilot login", grok: "grok login" };
/** What each login method runs instead of the plain command (the demo's stand-ins for the real flags). */
const METHOD_COMMAND: Record<string, Record<string, string>> = {
  "claude-code": { claudeai: "claude auth login --claudeai", console: "claude auth login --console" },
  codex: { browser: "codex login", device: "codex login --device-auth" },
};
const HOME_VAR: Record<string, string> = { "claude-code": "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const LOGIN_PAGE: Record<string, string> = {
  "claude-code": "https://claude.ai/oauth/authorize?client_id=octo-demo",
  codex: "https://auth.openai.com/codex/device",
};

type Record_ = { base: string; slug: string; name: string; dir: string; owned: boolean };

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

const encoder = new TextEncoder();

export type DemoAccountsOptions = { accounts?: string | null; limit?: string | null; loggedIn: Set<string> };

export function demoAccounts(options: DemoAccountsOptions) {
  const { loggedIn } = options;
  const records: Record_[] = [];
  const defaultNames = new Map<string, string>();
  if (options.accounts === "claude" || options.accounts === "all") {
    records.push({ base: "claude-code", slug: "work", name: "Work", dir: "~/Library/Application Support/Octo/harness/accounts/claude-code/work", owned: true });
    defaultNames.set("claude-code", "Personal");
  }
  if (options.accounts === "all") {
    records.push({ base: "codex", slug: "second", name: "Second", dir: "~/Library/Application Support/Octo/harness/accounts/codex/second", owned: true });
    defaultNames.set("codex", "Personal");
    loggedIn.add("codex@second");
  }

  const idOf = (r: Record_) => `${r.base}@${r.slug}`;
  const accountOf = (r: Record_): AgentAccount => ({ id: r.slug, name: r.name, default: false, dir: r.dir, owned: r.owned });
  const loginCommand = (base: string, r?: Record_, method?: string): string => {
    const cmd = (method ? METHOD_COMMAND[base]?.[method] : undefined) ?? LOGIN_COMMAND[base];
    if (!cmd) return "";
    const home = HOME_VAR[base];
    return r && home ? `${home}="${r.dir}" ${cmd}` : cmd;
  };
  const limit = (id: string): Pick<Provider, "limit"> => {
    if (options.limit !== id) return {};
    const now = Date.now();
    return { limit: { reached_at: new Date(now - 5 * 60_000).toISOString(), resets_at: new Date(now + 90 * 60_000).toISOString() } };
  };

  /** The provider list with accounts: every agent says whether it supports them, and an agent with several lists each one. */
  const decorate = (list: readonly Provider[]): Provider[] =>
    list.flatMap((p): Provider[] => {
      if (p.kind !== "agent") return [p];
      const family = records.filter((r) => r.base === p.id);
      const support = supportOf(p.id);
      const name = defaultNames.get(p.id) ?? "Default";
      const methods = METHODS[p.id];
      const login = loginCommand(p.id);
      const own: Provider = {
        ...p,
        base_id: p.id,
        accounts_support: support,
        ...(support.supported ? { account: { id: "", name, default: true } } : {}),
        ...(family.length > 0 ? { label: `${p.label} · ${name}` } : {}),
        ...(methods ? { login_methods: methods } : {}),
        ...(login ? { login_command: login } : {}),
        ...limit(p.id),
      };
      const derived = family.map((r): Provider => ({
        ...p,
        id: idOf(r),
        base_id: p.id,
        label: `${p.label} · ${r.name}`,
        state: loggedIn.has(idOf(r)) ? "ready" : "not_logged_in",
        reason: loggedIn.has(idOf(r)) ? "" : "not logged in",
        account: accountOf(r),
        ...(methods ? { login_methods: methods } : {}),
        ...(login ? { login_command: loginCommand(p.id, r) } : {}),
        ...limit(idOf(r)),
      }));
      return [own, ...derived];
    });

  const recordOf = (id: string): Record_ | undefined => records.find((r) => idOf(r) === id);

  return {
    decorate,
    /** The agent a `?limit=` turn fails on (its provider id), or null. */
    limitedId: (): string | null => options.limit ?? null,
    add(base: string, input: { name: string; dir?: string }): AgentAccount {
      if (!supportOf(base).supported) throw new BridgeError(400, "accounts_unsupported", supportOf(base).reason ?? "This agent keeps one account only.");
      const name = input.name.trim();
      if (name === "") throw new BridgeError(400, "invalid_account", "Give the account a name.");
      let slug = slugOf(name) || "account";
      if (slug === "default") slug = "default-2";
      for (let n = 2; records.some((r) => r.base === base && r.slug === slug); n++) slug = `${slugOf(name) || "account"}-${n}`;
      const owned = !input.dir;
      const r: Record_ = { base, slug, name, dir: input.dir ?? `~/Library/Application Support/Octo/harness/accounts/${base}/${slug}`, owned };
      records.push(r);
      return accountOf(r);
    },
    rename(providerId: string, name: string): AgentAccount {
      const next = name.trim();
      if (next === "") throw new BridgeError(400, "invalid_account", "Give the account a name.");
      const r = recordOf(providerId);
      if (r) {
        r.name = next;
        return accountOf(r);
      }
      if (!supportOf(providerId).supported) throw new BridgeError(404, "not_found", "This agent has no accounts.");
      defaultNames.set(providerId, next);
      return { id: "", name: next, default: true };
    },
    remove(providerId: string, deleteData: boolean): AgentAccountRemoved {
      const r = recordOf(providerId);
      if (!r) throw new BridgeError(400, "default_account", "The default account cannot be removed.");
      records.splice(records.indexOf(r), 1);
      loggedIn.delete(providerId);
      return { removed: providerId, deleted_dir: deleteData && r.owned ? r.dir : null };
    },
    /** A login that prints a fake link and code, and turns `ok` after Enter or 3 seconds. */
    login(providerId: string, opts?: AgentLoginOptions): AgentLoginSession {
      const base = providerId.split("@")[0] ?? providerId;
      if (!METHODS[base]) {
        throw new BridgeError(404, "login_unavailable", "This agent has no login command Octo knows.", {
          hint: "Log in from a terminal, then press Check again.",
        });
      }
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
      const method = METHODS[base].find((m) => m.id === opts?.method)?.label;
      emit(
        `Starting the login${method ? ` (${method})` : ""}…\r\n\r\nOpen this link in your browser to sign in:\r\n\r\n  ${page}&state=${providerId.replace("@", "-")}\r\n\r\nYour one-time code: OCTO-4821\r\n\r\nPress Enter when you have signed in.\r\n`,
      );
      const timer = setTimeout(finish, 3000);
      (timer as { unref?: () => void }).unref?.();
      return {
        sessionId: `login-${providerId}`,
        pid: 52_000,
        command: loginCommand(base, recordOf(providerId), opts?.method),
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
