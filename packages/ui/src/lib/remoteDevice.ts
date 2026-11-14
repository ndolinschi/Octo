/**
 * Remote access (spec 2026-11-14-remote-access-mobile-design.md, `HostCapabilities.remoteDevice`): what a paired device may
 * do, so the UI hides or disables what the harness would refuse through the tunnel (`remote_forbidden`,
 * `remote_read_only`; the allow-list is `apps/harness/internal/remoteaccess/rules.go`). The harness stays the authority:
 * these only keep the person from reaching a refusal.
 */
export type RemoteDevice = {
  /** The device may only read (a per-device switch on the computer). */
  readOnly: boolean;
  /** What every device may do beyond reading (`HARNESS_REMOTE_ALLOW`): "send", "answer", "stop". */
  permissions: readonly string[];
};

/** The one sentence on every entry point a device may not use. */
export const ON_YOUR_COMPUTER = "Change this on your computer";

/**
 * The settings sections a device may change: the ones kept on the device itself (its startup and sidebar choices, its
 * theme) and About, which only reads. Every other section writes the harness's settings, providers, secrets, remote access,
 * plugins, project commands, memory or budgets, which are local only.
 */
const DEVICE_SECTIONS: ReadonlySet<string> = new Set(["general", "appearance", "about"]);

/** Whether a settings section is closed to this device (no device: never). */
export function sectionLocked(device: RemoteDevice | undefined, section: string): boolean {
  return device !== undefined && !DEVICE_SECTIONS.has(section);
}

/** Whether this device may do `what` beyond reading (no device: always). */
export function deviceMay(device: RemoteDevice | undefined, what: "send" | "answer" | "stop"): boolean {
  return device === undefined || (!device.readOnly && device.permissions.includes(what));
}

/**
 * Whether this device may change the project or run its commands (create, edit or remove projects, project settings,
 * commands, secrets): never through the tunnel.
 */
export function mayChangeProject(device: RemoteDevice | undefined): boolean {
  return device === undefined;
}
