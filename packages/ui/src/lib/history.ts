import { useEffect, useState } from "react";

/** The Navigation API, where the engine has it (Chromium, WebView2). */
type NavigationLike = EventTarget & { canGoBack: boolean; canGoForward: boolean };

function navigation(): NavigationLike | null {
  const nav = (window as { navigation?: NavigationLike }).navigation;
  return nav && typeof nav.canGoBack === "boolean" ? nav : null;
}

/**
 * Whether history.back()/forward() have somewhere to go. Engines without the Navigation API
 * cannot tell, so both stay enabled there.
 */
export function useHistoryAvailability(): { back: boolean; forward: boolean } {
  const read = () => {
    const nav = navigation();
    return nav ? { back: nav.canGoBack, forward: nav.canGoForward } : { back: true, forward: true };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState((prev) => {
      const next = read();
      return prev.back === next.back && prev.forward === next.forward ? prev : next;
    });
    const nav = navigation();
    nav?.addEventListener("currententrychange", update);
    window.addEventListener("hashchange", update);
    return () => {
      nav?.removeEventListener("currententrychange", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  return state;
}
