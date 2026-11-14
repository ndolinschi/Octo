import type { RemoteAccessApi, RemoteDevice, RemoteStatus } from "@octo/agent-client";

/**
 * Remote access in the demo (spec 2026-11-14 remote access): off at first; turning it on asks for the acknowledgement once,
 * goes "starting" and then "on" with a made-up quick-tunnel address; "Add a device" shows a code, and a few seconds later
 * an "iPhone" claims it and waits for Allow. One paired iPad exists from the start. `?remote=missing` shows the
 * not-installed state, `?remote=on` starts switched on with a code open and a phone waiting.
 */
export function createDemoRemote(mode: string | null = searchMode()): RemoteAccessApi {
  const now = () => Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  let acknowledged = mode === "on";
  let state: RemoteStatus["state"] = "off";
  let url: string | undefined;
  let found = mode !== "missing";
  let pairing: RemoteStatus["pairing"];
  let claimTimer: ReturnType<typeof setTimeout> | undefined;
  const devices: RemoteDevice[] = [
    {
      id: "dev_ipad",
      name: "iPad",
      status: "active",
      read_only: true,
      paired_at: iso(now() - 3 * 86_400_000),
      last_seen: iso(now() - 2 * 3_600_000),
      online: false,
    },
  ];
  const view = (): RemoteStatus => ({
    state,
    ...(url ? { url } : {}),
    connected: state === "on",
    ...(state === "error"
      ? {
          error: {
            code: "cloudflared_missing",
            message: "Remote access needs Cloudflare's tunnel program, and it is not installed.",
            hint: "Install it, then check again.",
            command: "brew install cloudflared",
          },
        }
      : {}),
    ...(state !== "off" && state !== "error" ? { listen: "127.0.0.1:52811" } : {}),
    cloudflared: found
      ? { found: true, path: "/opt/homebrew/bin/cloudflared", version: "2025.1.0", install: "brew install cloudflared" }
      : { found: false, install: "brew install cloudflared" },
    ...(pairing ? { pairing } : {}),
    devices: devices.map((d) => ({ ...d })),
    online: devices.filter((d) => d.online).length,
    pending: devices.filter((d) => d.status === "pending").length,
    acknowledged,
    permissions: ["read", "send", "answer", "stop"],
    idle_off_hours: 8,
    web_app: true,
  });
  const settle = () => new Promise((r) => setTimeout(r, 120)).then(view);
  const issue = () => {
    const code = "K7QM-4ZP2";
    pairing = { code, expires_at: iso(now() + 5 * 60_000), link: `${url ?? ""}/#pair=${code.replace("-", "")}` };
    if (claimTimer) clearTimeout(claimTimer);
    claimTimer = setTimeout(() => {
      pairing = undefined;
      devices.unshift({ id: `dev_${String(now())}`, name: "iPhone", status: "pending", read_only: false, paired_at: iso(now()), online: false });
    }, 6000);
  };
  const turnOn = () => {
    state = "starting";
    setTimeout(() => {
      if (state !== "starting") return;
      state = "on";
      url = "https://brave-otter-lantern-quiz.trycloudflare.com";
    }, 1200);
  };
  if (mode === "on") {
    state = "on";
    url = "https://brave-otter-lantern-quiz.trycloudflare.com";
    issue();
    devices.push({
      id: "dev_pixel",
      name: "Pixel 9",
      status: "active",
      read_only: false,
      paired_at: iso(now() - 40 * 60_000),
      last_seen: iso(now()),
      online: true,
    });
  }
  return {
    status: settle,
    enable: (ack) => {
      if (!acknowledged && !ack) return Promise.reject(new Error("Remote access has to be confirmed the first time."));
      acknowledged = true;
      if (!found) state = "error";
      else turnOn();
      return settle();
    },
    disable: () => {
      state = "off";
      url = undefined;
      pairing = undefined;
      for (let i = devices.length - 1; i >= 0; i--) if (devices[i]?.status === "pending") devices.splice(i, 1);
      return settle();
    },
    check: () => {
      found = true;
      if (state === "error") state = "off";
      return settle();
    },
    issueCode: () => {
      issue();
      return settle();
    },
    cancelCode: () => {
      pairing = undefined;
      if (claimTimer) clearTimeout(claimTimer);
      return settle();
    },
    confirmDevice: (id) => {
      const d = devices.find((x) => x.id === id);
      if (d) Object.assign(d, { status: "active", online: true, last_seen: iso(now()) });
      return settle();
    },
    setReadOnly: (id, readOnly) => {
      const d = devices.find((x) => x.id === id);
      if (d) d.read_only = readOnly;
      return settle();
    },
    revokeDevice: (id) => {
      const i = devices.findIndex((x) => x.id === id);
      if (i >= 0) devices.splice(i, 1);
      return settle();
    },
    revokeAll: () => {
      devices.splice(0);
      state = "off";
      url = undefined;
      pairing = undefined;
      return settle();
    },
  };
}

function searchMode(): string | null {
  return typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("remote") : null;
}
