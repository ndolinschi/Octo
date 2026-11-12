import type { Provider } from "@octo/agent-client";
import { readable } from "../errors/plain";
import { stateText } from "./providers";

// Apart from `providers.ts` so the model picker (first paint) does not carry the error mapping.

/** The harness's reason when it says more than the state does ("grok: command not found on PATH"), else "" ("not logged in" after "Not logged in"). */
export function extraReason(p: Pick<Provider, "state" | "reason" | "problem">): string {
  const r = plainReason(p);
  return r && r.trim().toLowerCase() !== stateText(p.state).toLowerCase() ? r : "";
}

/** Why a provider is not ready, in the harness's plain words (`problem.message`), never its technical `reason`; an older harness's `reason` goes through the mapping. */
export function plainReason(p: Pick<Provider, "reason" | "problem">): string {
  return p.problem?.message ?? readable(p.reason);
}
