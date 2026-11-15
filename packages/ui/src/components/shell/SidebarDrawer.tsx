import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { useHistoryLayer } from "../../lib/historyLayer";
import { usePhone } from "../../lib/phone";
import { IconButton } from "../primitives/IconButton";
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
  // Direction 7: on the phone the navigation is a full-screen list and a history entry (Back closes it).
  const phone = usePhone();
  useHistoryLayer(phone && state === "open", () => onClose());
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('a[aria-current="true"], a[aria-current="page"]')?.focus();
  }, []);
  useEffect(() => {
    if (state === "closed" && opener.current?.isConnected) opener.current.focus();
  }, [state, opener]);
  return (
    // Starts under the title bar row, so its toggle stays visible (Esc or the scrim closes the drawer).
    <div
      className={cn("fixed z-40", phone ? "octo-sheet inset-x-0" : "inset-x-0 top-bar bottom-7")}
      data-sheet={phone ? "full" : undefined}
      inert={state === "closed"}
    >
      <div className="octo-scrim absolute inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        data-state={state}
        className={cn(
          "absolute inset-y-0 left-0 overscroll-contain",
          phone ? "right-0 flex flex-col overflow-y-auto bg-window" : "octo-drawer max-w-[calc(100%-48px)] shadow-pop",
        )}
      >
        {phone && (
          <div className="octo-phone-header flex shrink-0 items-center gap-1 px-1">
            <IconButton icon={X} label="Close the menu" size="lg" onClick={onClose} />
            <span className="min-w-0 flex-1 truncate text-title text-fg">Octo</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
