import { choiceCodec } from "../lib/storage";
import type { ThemePref } from "../lib/theme";

export { themeMode, type DarkTheme, type Theme, type ThemeMode, type ThemePref } from "../lib/theme";

/** Stored as plain text (`octo.theme`); an unknown value means "system". */
export const themeCodec = choiceCodec<ThemePref>(["system", "dark", "cursor", "claude", "codex", "opencode", "light"], "system");
