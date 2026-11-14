/** The shortcuts sheet (`components/shell/ShortcutsSheet`, its own chunk) listens for this event; the palette and Settings send it. */
export const SHORTCUTS_EVENT = "octo:shortcuts";
export const openShortcuts = () => window.dispatchEvent(new Event(SHORTCUTS_EVENT));
