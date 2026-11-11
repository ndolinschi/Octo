import { createContext, useContext } from "react";

/** Height a tool panel's list must leave free at its end for the floating composer (0 when none). */
export const FloatRoomContext = createContext(0);

/** The end-of-list spacer for the floating composer: a height, not padding, so insets stay on the scale. */
export function FloatRoom() {
  const room = useContext(FloatRoomContext);
  return room > 0 ? <div aria-hidden data-float-room className="shrink-0" style={{ height: room }} /> : null;
}
