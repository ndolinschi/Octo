/** The platform's command key as shortcut hints spell it: "⌘" on Apple platforms, else "Ctrl+". */
export const MOD_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
