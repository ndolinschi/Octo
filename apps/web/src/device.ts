import type { HostCapabilities } from "@octo/ui";
import type { Me } from "./pairing";

/**
 * The web client's layout (direction 7): the phone layout on a narrow window, and on a touch screen that is short (a phone
 * held sideways is ~844x390, wider than the app's own phone query); the desktop layout otherwise, so a tablet (portrait
 * from 768px, landscape) and a desktop browser get the desktop one.
 */
export const WEB_PHONE_QUERY = "(max-width: 414px), (pointer: coarse) and (max-height: 414px)";

/** `HostCapabilities.remoteDevice` from `/pair/me`: what the harness lets this device do. */
export function deviceOf(me: Pick<Me, "read_only" | "permissions">): NonNullable<HostCapabilities["remoteDevice"]> {
  return { readOnly: me.read_only, permissions: [...me.permissions] };
}

/** Whether a newer `/pair/me` changes what the device may do (the computer switched read-only, or the permissions). */
export function deviceChanged(a: Pick<Me, "read_only" | "permissions">, b: Pick<Me, "read_only" | "permissions">): boolean {
  return a.read_only !== b.read_only || a.permissions.join(",") !== b.permissions.join(",");
}
