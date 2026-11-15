import type { RemoteDevice, RemoteStatus } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { encodeQr } from "../../lib/qr";
import { Button } from "../primitives/Button";
import { Switch } from "../primitives/Switch";
import { countdown, deviceLine } from "../shared/remoteText";
import { SettingsRow } from "./parts";

/**
 * The pairing link as a QR code: dark modules on white whatever the theme (scanners expect it), a 4-module quiet zone,
 * one SVG path so it stays crisp at any scale.
 */
export function QrImage({ text, size }: { text: string; size: number }) {
  const path = useMemo(() => {
    const qr = encodeQr(text);
    let d = "";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.dark(x, y)) d += `M${String(x + 4)} ${String(y + 4)}h1v1h-1z`;
    return { d, n: qr.size + 8 };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label="QR code with the address and the pairing code"
      width={size}
      height={size}
      viewBox={`0 0 ${String(path.n)} ${String(path.n)}`}
      className="shrink-0 rounded-md"
      shapeRendering="crispEdges"
    >
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/** The clock, read again every `ms` (the code's countdown each second, the devices' "last seen" each half minute). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** The open code: QR, the code in large mono, its countdown, "New code" and "Cancel". */
export function PairingPanel({
  pairing,
  busy,
  onNew,
  onCancel,
}: {
  pairing: NonNullable<RemoteStatus["pairing"]>;
  busy: boolean;
  onNew(): void;
  onCancel(): void;
}) {
  const now = useNow(1000);
  const left = countdown(pairing.expires_at, now);
  return (
    <div data-remote-pairing className="flex gap-4 px-settings-row-inset py-3 max-sm:flex-col max-sm:items-center">
      <QrImage text={pairing.link} size={168} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 max-sm:items-center max-sm:text-center">
        <p className="text-sm text-fg-2">Scan with the phone's camera, or open the address there and type the code.</p>
        <p className="font-mono text-figure tracking-widest text-fg" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>
          {pairing.code}
        </p>
        <p className="text-xs text-fg-3 tabular-nums" aria-live="off">
          {left === "expired" ? "This code has expired." : `Works once. Expires in ${left}.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onNew} disabled={busy}>
            New code
          </Button>
          <Button size="sm" variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "iPhone wants to connect": the computer's yes/no before a paired device can do anything (spec section 5). */
export function PendingRow({ device, now, busy, onAllow, onDeny }: { device: RemoteDevice; now: number; busy: boolean; onAllow(): void; onDeny(): void }) {
  return (
    <SettingsRow
      rowId={`remote-pending-${device.id}`}
      title={`${device.name} wants to connect`}
      description={deviceLine(device, now)}
      control={
        <>
          <Button size="sm" onClick={onDeny} disabled={busy}>
            Deny
          </Button>
          <Button size="sm" variant="primary" onClick={onAllow} disabled={busy}>
            Allow
          </Button>
        </>
      }
    />
  );
}

/** A paired device: when it was seen, read-only, remove. */
export function DeviceRow({
  device,
  now,
  busy,
  onReadOnly,
  onRevoke,
}: {
  device: RemoteDevice;
  now: number;
  busy: boolean;
  onReadOnly(v: boolean): void;
  onRevoke(): void;
}) {
  return (
    <SettingsRow
      title={device.name}
      description={deviceLine(device, now)}
      leading={<span aria-hidden className={device.online ? "size-1.5 rounded-full bg-ok" : "size-1.5 rounded-full bg-line-strong"} />}
      control={
        <>
          <span className="flex items-center gap-2 text-xs text-fg-2">
            Read-only
            <Switch checked={device.read_only} onChange={onReadOnly} label={`${device.name} can only read`} disabled={busy} />
          </span>
          {/* Red is kept for "Remove all and turn off": one device's removal is an ordinary button (it can pair again). */}
          <Button size="sm" onClick={onRevoke} disabled={busy}>
            Remove
          </Button>
        </>
      }
    />
  );
}
