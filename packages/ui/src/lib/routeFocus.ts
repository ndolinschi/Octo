/** 11b: what takes focus when Settings opens or closes (see `app/routeFocus`). */
export function routeFocusTarget(wasInSettings: boolean, inSettings: boolean): "title" | "opener" | null {
  if (!wasInSettings && inSettings) return "title";
  if (wasInSettings && !inSettings) return "opener";
  return null;
}

/** The title of the screen on show: Settings' (`#octo-page-title`), else the first visible `[data-page-title]`, else its h1. */
export function pageTitle(): HTMLElement | null {
  const shown = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;
  const settings = document.getElementById("octo-page-title");
  if (shown(settings)) return settings;
  const marked = [...document.querySelectorAll("[data-page-title]")].find(shown);
  if (marked) return marked;
  // A screen without a marked title (yet): its first visible h1, made focusable for this (no ring: `focus-visible` needs a key).
  const h1 = [...document.querySelectorAll("main h1, [data-app-root] h1")].find(shown) ?? null;
  if (h1 && !h1.hasAttribute("tabindex")) {
    h1.setAttribute("tabindex", "-1");
    h1.classList.add("focus-visible:shadow-none");
  }
  return h1;
}
