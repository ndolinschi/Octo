import { createContext, useContext } from "react";

/**
 * Phone layout mode (direction 7): ONE switch for narrow touch screens. A phone-sized touch screen (≤ 640px wide, or landscape
 * ≤ 479.98px tall, with a coarse pointer), or any window under 480px whatever its pointer. `OctoApp` reads it once (or takes the host's
 * `layout`), sets `data-phone` on the root element (the `phone:` CSS variant) and provides `usePhone()`; components never invent
 * their own breakpoint for it. The container-query sheds of narrow panes on desktop are a different thing and stay.
 */
export const PHONE_QUERY = "(max-width: 640px) and (pointer: coarse), (max-height: 479.98px) and (pointer: coarse), (max-width: 479.98px)";

export const PhoneContext = createContext(false);

/** True while the app is in the phone layout. */
export function usePhone(): boolean {
  return useContext(PhoneContext);
}
