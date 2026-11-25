import { BridgeError, toBridgeError, type Bridge, type FetchLike, type HttpBridgeOptions } from "./client";
import type { FileStat } from "./types";

/** A file's bytes, base64-encoded (`GET …/files/content?encoding=base64`): any file, same roots, path checks and 2 MiB limit as text. */
export type FileBytes = FileStat & { content: string; encoding: "base64" };

/** The optional bridge method that returns a file's bytes; the UI uses it to preview images. */
export type FileBytesReader = {
  readFileBytes(projectId: string, folder: string, path: string, opts?: { workspaceId?: string }): Promise<FileBytes>;
};

/** The bridge's byte reader, when it has one (the HTTP bridge after {@link withFileBytes}, the demo bridge). */
export function fileBytesReader(bridge: object): FileBytesReader["readFileBytes"] | undefined {
  if (!("readFileBytes" in bridge)) return undefined;
  const fn: unknown = bridge.readFileBytes;
  if (typeof fn !== "function") return undefined;
  return (projectId, folder, path, opts) => Promise.resolve(fn.call(bridge, projectId, folder, path, opts)).then(parseFileBytes);
}

/** Adds `readFileBytes` to an HTTP bridge, reaching the harness with the same base URL and token. */
export function withFileBytes<B extends Bridge>(bridge: B, options: Pick<HttpBridgeOptions, "baseUrl" | "token" | "fetch">): B & FileBytesReader {
  const base = options.baseUrl.replace(/\/+$/, "");
  const token = (options.token ?? "").trim();
  const readFileBytes: FileBytesReader["readFileBytes"] = async (projectId, folder, path, opts) => {
    const doFetch = options.fetch ?? globalFetch();
    const ws = opts?.workspaceId && opts.workspaceId !== "shared" ? `&workspace=${encodeURIComponent(opts.workspaceId)}` : "";
    const url = `${base}/v1/projects/${encodeURIComponent(projectId)}/files/content?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}&encoding=base64${ws}`;
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const res = await doFetch(url, token === "" ? { method: "GET" } : { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      status = res.status;
      ok = res.ok;
      text = await res.text();
    } catch (e) {
      throw new BridgeError(0, "network_error", e instanceof Error ? e.message : String(e));
    }
    if (!ok) throw toBridgeError(status, text);
    const body = parseJson(text);
    return parseFileBytes(body);
  };
  return { ...bridge, readFileBytes };
}

/** Validates an answer: a {@link FileBytes} or an `invalid_response` error. */
export function parseFileBytes(body: unknown): FileBytes {
  if (
    isRecord(body) &&
    typeof body.content === "string" &&
    body.encoding === "base64" &&
    typeof body.folder === "string" &&
    typeof body.path === "string" &&
    typeof body.size === "number" &&
    typeof body.mtime === "string"
  ) {
    return { folder: body.folder, path: body.path, size: body.size, mtime: body.mtime, content: body.content, encoding: "base64" };
  }
  throw new BridgeError(0, "invalid_response", "Octo's local service sent an answer that could not be read.");
}

function globalFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new BridgeError(0, "network_error", "fetch is not available");
  return (url, init) => f(url, init);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the caller reports the status with the text's first words.
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
