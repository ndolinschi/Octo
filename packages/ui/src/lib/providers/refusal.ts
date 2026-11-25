// Read by the composer on every failed send, so outside `recheck` (which loads on the first "Check again").

/** A refusal (422 `model_unavailable`) the user may override: the harness says the login probe alone decided it. */
export function canForce(e: unknown): boolean {
  return typeof e === "object" && e !== null && "can_force" in e && e.can_force === true;
}

/** The agent a refusal is about (`BridgeError.provider`), when it is one the user can recheck. */
export function refusedProvider(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "provider" in e && typeof e.provider === "string" ? e.provider : undefined;
}
