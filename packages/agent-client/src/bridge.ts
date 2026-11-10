import { DEFAULT_BRIDGE_URL } from "./types";

export type EnvLike = Record<string, string | undefined>;

export function resolveBridgeUrl(env: EnvLike = (import.meta as ImportMeta & { env?: EnvLike }).env ?? {}): string {
  const url = env.VITE_HARNESS_BRIDGE_URL ?? env.HARNESS_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
  return url.replace(/\/$/, "");
}
