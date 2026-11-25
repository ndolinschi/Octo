import type { ErrorFields, PluginAgent } from "@octo/agent-client";
import { commandOf } from "./plain";

/** The login line of an agent that is not logged in: the command to copy and, when its manifest names one, the second step. */
export type LoginSteps = { command: string; hint?: string };

const BACKTICKS = /`([^`]+)`/g;

/**
 * The command that logs `agent` in (decision 94b), read from the plugin list because an agent row keeps only its message and
 * hint after a restart: the manifest's `auth.command`, else the command in backticks of its login hint. A second backticked
 * step in the hint ("then `/login`") becomes the hint "Run it in a terminal, then type /login, then check again.". Null when the agent is
 * logged in, or the manifest names no command.
 */
export function loginSteps(agent: Pick<PluginAgent, "logged_in" | "login_command" | "hint"> | undefined): LoginSteps | null {
  if (!agent || agent.logged_in === true) return null;
  const command = agent.login_command?.trim() || commandOf(agent.hint);
  if (!command) return null;
  const step = [...(agent.hint ?? "").matchAll(BACKTICKS)].map((m) => m[1]?.trim() ?? "").find((s) => s.startsWith("/") && s !== command);
  return step ? { command, hint: `Run it in a terminal, then type ${step}, then check again.` } : { command };
}

/** `fields` with the login command filled in when the harness did not send one (an agent row has none); `fields` as they were otherwise. */
export function withLoginSteps(fields: ErrorFields | undefined, steps: LoginSteps | null): ErrorFields | undefined {
  if (!steps || fields?.command) return fields;
  const hint = steps.hint && !fields?.hint?.includes(steps.hint) ? steps.hint : fields?.hint;
  return { ...fields, command: steps.command, ...(hint ? { hint } : {}) };
}
