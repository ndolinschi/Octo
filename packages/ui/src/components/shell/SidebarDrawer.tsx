import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePresence } from "../primitives/Presence";
import { useModal } from "../primitives/useModal";

/**
 * The sidebar as an overlay drawer (narrow windows): a scrim and the sidebar, under the title bar row. B59 (polish step 2, F7):
 * it is modal like a `Dialog` — Tab and Shift+Tab stay inside it, Esc closes it (`useModal`) — and it takes focus on the open
 * project's row (else its first control) and gives it back to the opener as soon as it starts closing.
 */
export function SidebarDrawer(props: { onClose(): void; opener: RefObject<HTMLElement | null>; children: ReactNode }) {
  const { onClose, opener, children } = props;
  const panel = useRef<HTMLDivElement>(null);
  const state = usePresence();
  useModal(panel, onClose);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('a[aria-current="true"], a[aria-current="page"]')?.focus();
  }, []);
  useEffect(() => {
    if (state === "closed" && opener.current?.isConnected) opener.current.focus();
  }, [state, opener]);
  return (
    // Starts under the title bar row, so its toggle stays visible (Esc or the scrim closes the drawer).
    <div className="fixed inset-x-0 top-bar bottom-chip z-40" inert={state === "closed"}>
      <div className="octo-scrim absolute inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        data-state={state}
        className="octo-drawer absolute inset-y-0 left-0 max-w-[calc(100%-48px)] overscroll-contain shadow-pop"
      >
        {children}
      </div>
    </div>
  );
}
