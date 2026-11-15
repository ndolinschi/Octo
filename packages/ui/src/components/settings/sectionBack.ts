import { settingsHref } from "../../lib/route";

/**
 * A9.1 (phone): the one way back from a settings section is the header's "←" (PhoneChrome). Direction 7: a section opened
 * from the list goes back through the history; one reached any other way (a link, a search result, a reload) replaces itself
 * with the list. A layer open over the section (a provider's detail, `useHistoryLayer`) is closed first, by its history entry.
 */
let fromList = false;

/** The section about to open was picked in the list of sections. */
export function markFromList(): void {
  fromList = true;
}

/** What "back" does from a section: pop the history (a layer, or the list it came from) or replace the entry with the list. */
export function sectionBackStep(layerOpen: boolean, cameFromList: boolean): "history" | "list" {
  return layerOpen || cameFromList ? "history" : "list";
}

/** `historyLayer`'s mark on a layer's entry (`octoLayer` in `history.state`). */
function layerOpen(): boolean {
  const s: unknown = window.history.state;
  return typeof s === "object" && s !== null && typeof Reflect.get(s, "octoLayer") === "string";
}

export function backToSections(): void {
  const layer = layerOpen();
  if (sectionBackStep(layer, fromList) === "history") window.history.back();
  else window.location.replace(settingsHref(""));
  if (!layer) fromList = false;
}
