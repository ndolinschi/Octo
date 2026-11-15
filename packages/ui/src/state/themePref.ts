import { choiceCodec } from "../lib/storage";

export type ThemeMode = "dark" | "light";
export type DarkTheme = "dark" | "cursor" | "claude" | "codex" | "opencode";
export type Theme = DarkTheme | "light";
export type ThemePref = "system" | Theme;

export const THEME_CHOICES = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark", description: "Octo's default neutral dark" },
  { id: "cursor", label: "Cursor", description: "Cool charcoal & electric blue" },
  { id: "claude", label: "Claude Code", description: "Warm espresso & terracotta" },
  { id: "codex", label: "Codex", description: "Deep ink slate & emerald" },
  { id: "opencode", label: "OpenCode", description: "Midnight graphite & violet" },
  { id: "light", label: "Light" },
] as const satisfies readonly { id: ThemePref; label: string; description?: string }[];

export function themeMode(theme: Theme): ThemeMode {
  return theme === "light" ? "light" : "dark";
}

/** Stored as plain text (`octo.theme`); an unknown value means "system". */
export const themeCodec = choiceCodec<ThemePref>(["system", "dark", "cursor", "claude", "codex", "opencode", "light"], "system");
