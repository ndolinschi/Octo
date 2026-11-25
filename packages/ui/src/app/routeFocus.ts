import { useEffect, useRef } from "react";
import { focusSoon } from "../lib/focus";
import { pageTitle, routeFocusTarget } from "../lib/routeFocus";

/**
 * 11b: where focus goes after the route changes, so it never stays on the page's body (a screen reader would say nothing):
 * - entering Settings: its title (F4's `#octo-page-title`);
 * - leaving Settings (Esc, Back, "Previous page"): the control that opened it, when it is on screen again;
 * - any other route change that left focus nowhere (a status-bar item that opened Home, the history's Back): the new screen's
 *   title (`[data-page-title]`, a `tabIndex={-1}` heading without a ring for programmatic focus).
 * A focus the person moved is never taken (`onlyIfLost`), except the return to Settings' opener.
 */
export function useRouteFocus(inSettings: boolean): void {
  const opener = useRef<HTMLElement | null>(null);
  const was = useRef(inSettings);
  useEffect(() => {
    // The focused control at the moment the hash changes (before React renders the next screen): Settings' opener.
    const onHash = (e: HashChangeEvent) => {
      const a = document.activeElement;
      const from = new URL(e.oldURL).hash;
      if (!window.location.hash.startsWith("#/settings") || from.startsWith("#/settings")) return;
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
    };
    window.addEventListener("hashchange", onHash, true);
    return () => window.removeEventListener("hashchange", onHash, true);
  }, []);
  useEffect(() => {
    const target = routeFocusTarget(was.current, inSettings);
    was.current = inSettings;
    if (target === "title") focusSoon(pageTitle, { onlyIfLost: true, timeout: 2000 });
    else if (target === "opener") {
      const el = opener.current;
      opener.current = null;
      // After the workspace is shown again: a card that takes focus on show must not keep it.
      if (el?.isConnected) focusSoon(() => el, { delay: 60, timeout: 1500 });
      else focusSoon(pageTitle, { onlyIfLost: true, timeout: 2000 });
    }
  }, [inSettings]);
  useEffect(() => {
    const onRoute = () => {
      if (window.location.hash.startsWith("#/settings")) return;
      focusSoon(pageTitle, { onlyIfLost: true, timeout: 2000 });
    };
    window.addEventListener("hashchange", onRoute);
    return () => window.removeEventListener("hashchange", onRoute);
  }, []);
}
