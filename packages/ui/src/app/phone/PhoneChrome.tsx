import { Menu as MenuIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/primitives/IconButton";
import { useShell } from "../../state/shell";
import { useVisualViewport } from "./useVisualViewport";
import { useTouchHelpers } from "./useTouchHelpers";

/** The screen's name for the top bar; null where a project's own header shows (`dock/phone/PhoneHeader`). */
function screenTitle(hash: string): string | null {
  if (hash.startsWith("#/settings")) return "Settings";
  return hash.startsWith("#/p/") ? null : "Home";
}

/**
 * The phone layout's frame (direction 7), mounted by `AppShell` only while the mode is on (its own chunk):
 * - off a project (Home, Settings), the one-line top bar: the menu button (the navigation, `shell/SidebarDrawer` full screen)
 *   and the screen's name;
 * - the on-screen keyboard (`useVisualViewport`) and the touch helpers (a tap on a popup's scrim never reaches what is under
 *   it; a long press shows a control's description, the touch stand-in for a tooltip).
 */
export default function PhoneChrome() {
  const { toggleSidebar, sidebarOpen } = useShell();
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // A project's header (its own chunk) is fetched with this one, so it is in before the project is.
  useEffect(() => void import("../../components/dock/phone/PhoneHeader").catch(() => undefined), []);
  useVisualViewport();
  const tip = useTouchHelpers();
  const title = screenTitle(hash);
  return (
    <>
      {title !== null && (
        <header aria-label="Window" data-phone-header className="octo-phone-header absolute inset-x-0 top-0 z-20 flex items-center gap-1 bg-window px-1">
          <IconButton icon={MenuIcon} label="Menu" size="lg" aria-expanded={sidebarOpen} onClick={toggleSidebar} />
          <h1 className="min-w-0 flex-1 truncate text-title text-fg">{title}</h1>
        </header>
      )}
      {tip && (
        <div
          role="status"
          data-phone-tip
          className="octo-fade octo-phone-tip fixed inset-x-4 z-[70] rounded-lg bg-overlay px-4 py-3 text-sm whitespace-pre-line text-fg shadow-pop"
        >
          {tip}
        </div>
      )}
    </>
  );
}
