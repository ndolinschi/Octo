import { ArrowLeft, Menu as MenuIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/primitives/IconButton";
import { backToSections } from "../../components/settings/sectionBack";
import { SECTIONS } from "../../components/settings/settingsIndex";
import { useShell } from "../../state/shell";
import { useVisualViewport } from "./useVisualViewport";
import { useTouchHelpers } from "./useTouchHelpers";

/**
 * The screen's name for the top bar; null where a project's own header shows (`dock/phone/PhoneHeader`). A project route whose
 * workspace is not shown (the project is gone, Octo's local service is not answering yet) keeps the bar: the menu is the way
 * to Home and Settings from there (A9.4).
 */
export function screenTitle(hash: string, projectShown: boolean): string | null {
  // Balance pass: in a section the header names the section (the page's own title goes to a screen reader only, and the bar's
  // "Back to Settings" control, A9.1, is the way back to the list).
  const section = /^#\/settings\/([a-z-]+)/.exec(hash)?.[1];
  const known = section ? SECTIONS.find((s) => s.id === section) : undefined;
  if (known) return known.label;
  if (hash.startsWith("#/settings")) return "Settings";
  if (!hash.startsWith("#/p/")) return "Home";
  return projectShown ? null : "Octo";
}

/**
 * The phone layout's frame (direction 7), mounted by `AppShell` only while the mode is on (its own chunk):
 * - off a project (Home, Settings), the one-line top bar: the menu button (the navigation, `shell/SidebarDrawer` full screen)
 *   and the screen's name;
 * - the on-screen keyboard (`useVisualViewport`) and the touch helpers (a tap on a popup's scrim never reaches what is under
 *   it; a long press shows a control's description, the touch stand-in for a tooltip).
 */
export default function PhoneChrome({ projectShown }: { projectShown: boolean }) {
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
  const title = screenTitle(hash, projectShown);
  // A9.1: in a settings section the bar's button is the one way back to the list of sections (the page has no second one);
  // the menu is on the list's bar.
  const inSection = /^#\/settings\/[a-z-]+/.test(hash);
  return (
    <>
      {title !== null && (
        <header aria-label="Window" data-phone-header className="octo-phone-header absolute inset-x-0 top-0 z-20 flex items-center gap-1 bg-window px-1">
          {inSection ? (
            <IconButton icon={ArrowLeft} label="Back to Settings" size="lg" onClick={backToSections} />
          ) : (
            <IconButton icon={MenuIcon} label="Menu" size="lg" aria-expanded={sidebarOpen} onClick={toggleSidebar} />
          )}
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
