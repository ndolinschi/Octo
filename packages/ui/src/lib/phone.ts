import { createContext, useContext } from "react";

/** Maximum viewport width (or coarse-pointer landscape height) in px where the mobile phone layout applies. */
export const PHONE_MAX_WIDTH = 414;

/**
 * Phone layout mode (direction 7): ONE switch for phone screens (<= 414px wide, or landscape <= 414px tall with a coarse
 * pointer). `OctoApp` reads it once (or takes the host's `layout`), sets `data-phone` on the root element (the `phone:` CSS
 * variant) and provides `usePhone()`; components never invent their own breakpoint for it. The container-query sheds of
 * narrow panes on desktop are a different thing and stay.
 */
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px), (max-height: ${PHONE_MAX_WIDTH}px) and (pointer: coarse)`;

export const PhoneContext = createContext(false);

/** True while the app is in the phone layout. */
export function usePhone(): boolean {
  return useContext(PhoneContext);
}
