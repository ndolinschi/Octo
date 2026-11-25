/**
 * Remote access (spec 2026-11-14-remote-access-mobile-design.md; exact API in apps/harness/docs/remote-access.md): the
 * computer's control routes under `/v1/remote`. Local token only; a paired device is refused on every one of them.
 */

export type RemoteState = "off" | "starting" | "on" | "error";

export type RemoteProblem = { code: string; message: string; hint?: string; command?: string; action?: string; details?: string };

export type RemoteDevice = {
  id: string;
  name: string;
  status: "pending" | "active";
  read_only: boolean;
  paired_at: string;
  last_seen?: string;
  /** Made a request in the last minute. */
  online: boolean;
};

export type RemoteStatus = {
  state: RemoteState;
  url?: string;
  /** cloudflared reported a connection the edge accepted. */
  connected: boolean;
  error?: RemoteProblem;
  /** The tunnel listener's loopback address while it is open. */
  listen?: string;
  cloudflared: { found: boolean; path?: string; version?: string; install: string };
  /** The open pairing code; `link` is the URL for the QR code (the code rides in its fragment). */
  pairing?: { code: string; expires_at: string; link: string };
  devices: RemoteDevice[];
  online: number;
  pending: number;
  /** The owner confirmed the first-time warning. */
  acknowledged: boolean;
  permissions: string[];
  /** Turns itself off after this many hours without a device request; 0 = never. */
  idle_off_hours: number;
  /** The harness has the phone's web app to serve. */
  web_app: boolean;
};

/** The control routes. Every call answers the whole status, so a screen just replaces what it shows. */
export type RemoteAccessApi = {
  status(): Promise<RemoteStatus>;
  /** `acknowledge` is needed the first time (409 `remote_ack_required` otherwise). */
  enable(acknowledge?: boolean): Promise<RemoteStatus>;
  disable(): Promise<RemoteStatus>;
  /** Looks for cloudflared again. */
  check(): Promise<RemoteStatus>;
  issueCode(): Promise<RemoteStatus>;
  cancelCode(): Promise<RemoteStatus>;
  confirmDevice(id: string): Promise<RemoteStatus>;
  setReadOnly(id: string, readOnly: boolean): Promise<RemoteStatus>;
  revokeDevice(id: string): Promise<RemoteStatus>;
  /** Removes every device and turns remote access off. */
  revokeAll(): Promise<RemoteStatus>;
};

type Request = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The control routes over the bridge client's `request`. */
export function remoteAccessApi(request: Request): RemoteAccessApi {
  const call = async (method: string, path: string, body?: unknown) => (await request(method, `/v1/remote${path}`, body)) as RemoteStatus;
  const dev = (id: string) => `/devices/${encodeURIComponent(id)}`;
  return {
    status: () => call("GET", ""),
    enable: (acknowledge) => call("POST", "/enable", acknowledge ? { acknowledge: true } : {}),
    disable: () => call("POST", "/disable"),
    check: () => call("POST", "/check"),
    issueCode: () => call("POST", "/pairing"),
    cancelCode: () => call("DELETE", "/pairing"),
    confirmDevice: (id) => call("POST", `${dev(id)}/confirm`),
    setReadOnly: (id, readOnly) => call("PATCH", dev(id), { read_only: readOnly }),
    revokeDevice: (id) => call("DELETE", dev(id)),
    revokeAll: () => call("POST", "/revoke-all"),
  };
}
