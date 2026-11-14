import type { RemoteStatus } from "@octo/agent-client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useCopy } from "../../lib/hooks";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Notice } from "../primitives/Notice";
import { SkeletonList } from "../primitives/Skeleton";
import { Switch } from "../primitives/Switch";
import { RISK_TEXT, stateLine } from "../shared/remoteText";
import { useRemoteAccess } from "../shared/useRemoteAccess";
import { LoadErrorRow, SettingsGroup, SettingsRow } from "./parts";
import { DeviceRow, PairingPanel, PendingRow, useNow } from "./RemoteParts";

const POLL_MS = 2000;

/**
 * Settings → Remote access (spec 2026-11-14-remote-access-mobile-design.md, section 7): the switch (off by default; the
 * first time it explains the risk and asks once), the tunnel's address with copy, "Add a device" (QR code, code and
 * countdown), the yes/no for a device that just paired, the devices with read-only and revoke, "Revoke all and turn off",
 * and the install line when Cloudflare's program is missing.
 */
export function RemoteAccessSection() {
  const { load, busy, actionError, run, retry } = useRemoteAccess(POLL_MS);
  const [confirming, setConfirming] = useState(false);
  const now = useNow(30_000);
  if (load.status === "unavailable")
    return (
      <SettingsGroup label="Remote access">
        <SettingsRow rowId="remote" title="Remote access" description="This connection does not offer remote access." />
      </SettingsGroup>
    );
  if (load.status === "loading")
    return (
      <SettingsGroup label="Remote access">
        <SkeletonList count={1} size="lg" twoLine />
      </SettingsGroup>
    );
  if (load.status === "error")
    return (
      <SettingsGroup label="Remote access">
        <LoadErrorRow what="remote access" message={load.message} hint="Retry once Octo's local service is running." onRetry={retry} />
      </SettingsGroup>
    );
  const s = load.s;
  const on = s.state === "on" || s.state === "starting";
  const toggle = (next: boolean) => {
    if (!next) void run((a) => a.disable());
    else if (!s.acknowledged) setConfirming(true);
    else void run((a) => a.enable());
  };
  const pending = s.devices.filter((d) => d.status === "pending");
  const active = s.devices.filter((d) => d.status === "active");
  return (
    <>
      <SettingsGroup
        label="Remote access"
        footer="Paired devices can read projects and files, send messages, answer approvals and stop turns. They cannot change settings, keys, plugins or remote access."
      >
        <SettingsRow
          rowId="remote"
          title="Remote access"
          description={stateLine(s)}
          control={<Switch checked={on} onChange={toggle} label="Remote access" disabled={busy || s.state === "starting"} />}
        />
        <Problem s={s} busy={busy} onCheck={() => void run((a) => a.check())} onRetry={() => void run((a) => a.enable())} />
        {s.state === "on" && s.url && <AddressRow url={s.url} />}
        {actionError && (
          <div className="px-settings-inset py-2">
            <Notice tone="error">{actionError}</Notice>
          </div>
        )}
      </SettingsGroup>

      {s.state === "on" && (
        <SettingsGroup label="Add a device">
          {pending.map((d) => (
            <PendingRow
              key={d.id}
              device={d}
              now={now}
              busy={busy}
              onAllow={() => void run((a) => a.confirmDevice(d.id))}
              onDeny={() => void run((a) => a.revokeDevice(d.id))}
            />
          ))}
          {s.pairing ? (
            <PairingPanel pairing={s.pairing} busy={busy} onNew={() => void run((a) => a.issueCode())} onCancel={() => void run((a) => a.cancelCode())} />
          ) : (
            <SettingsRow
              rowId="remote-add"
              title="Pair a phone"
              description={
                s.web_app
                  ? "Shows a QR code and a code that work once, for five minutes."
                  : "The phone's web app is not installed with this Octo, so a phone sees only a short notice."
              }
              control={
                <Button size="sm" onClick={() => void run((a) => a.issueCode())} disabled={busy}>
                  Add a device
                </Button>
              }
            />
          )}
        </SettingsGroup>
      )}

      {s.devices.length > pending.length && (
        <SettingsGroup
          label="Devices"
          aside={
            <Button size="xs" variant="danger" onClick={() => void run((a) => a.revokeAll())} disabled={busy}>
              Revoke all and turn off
            </Button>
          }
        >
          {active.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              now={now}
              busy={busy}
              onReadOnly={(v) => void run((a) => a.setReadOnly(d.id, v))}
              onRevoke={() => void run((a) => a.revokeDevice(d.id))}
            />
          ))}
        </SettingsGroup>
      )}

      {confirming && (
        <Dialog
          title="Turn on remote access?"
          description={RISK_TEXT}
          width="sm"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirming(false);
                  void run((a) => a.enable(true));
                }}
              >
                Turn on
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </>
  );
}

function AddressRow({ url }: { url: string }) {
  const [copied, copy] = useCopy();
  return (
    <SettingsRow
      rowId="remote-url"
      title="Address"
      description={<span className="font-mono break-all text-fg-2">{url}</span>}
      control={
        <Button size="sm" icon={copied ? Check : Copy} onClick={() => copy(url)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      }
    />
  );
}

/** cloudflared missing (with its install line and "Check again"), or the tunnel failing. */
function Problem({ s, busy, onCheck, onRetry }: { s: RemoteStatus; busy: boolean; onCheck(): void; onRetry(): void }) {
  const missing = s.error?.code === "cloudflared_missing" || (s.state === "off" && !s.cloudflared.found);
  if (missing)
    return (
      <div className="px-settings-inset py-3">
        <Notice
          form="block"
          tone="warn"
          title="Cloudflare's tunnel program is not installed"
          command={s.cloudflared.install}
          actions={
            <Button size="sm" onClick={onCheck} disabled={busy}>
              Check again
            </Button>
          }
        >
          Remote access runs it to reach this computer from your phone. Install it, then check again.
        </Notice>
      </div>
    );
  if (s.state !== "error" || !s.error) return null;
  return (
    <div className="px-settings-inset py-3">
      <Notice
        form="block"
        tone="error"
        title={s.error.message}
        actions={
          <Button size="sm" onClick={onRetry} disabled={busy}>
            Try again
          </Button>
        }
      >
        {s.error.hint}
        {s.error.details && <pre className="mt-2 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap text-fg-3">{s.error.details}</pre>}
      </Notice>
    </div>
  );
}
