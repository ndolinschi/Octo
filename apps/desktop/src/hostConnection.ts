/** What the Tauri shell's `bridge_url` / `bridge_restart` commands return: the harness URL and its API token. */
export type HostConnection = { url: string; token: string };

/**
 * Reads the command's result. A shell that still answers with a bare URL string (no token) gives an empty token, so
 * the app keeps working against a harness started with `--no-api-token`.
 */
export function parseConnection(raw: unknown): HostConnection {
  if (typeof raw === "string") return { url: raw, token: "" };
  if (typeof raw === "object" && raw !== null) {
    const { url, token } = raw as { url?: unknown; token?: unknown };
    if (typeof url === "string" && url !== "") return { url, token: typeof token === "string" ? token : "" };
  }
  throw new Error("the desktop shell returned no bridge URL");
}
