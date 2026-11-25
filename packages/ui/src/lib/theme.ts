export type ThemeMode = "dark" | "light";
export type DarkTheme = "dark" | "cursor" | "claude" | "codex" | "opencode";
export type Theme = DarkTheme | "light";
export type ThemePref = "system" | Theme;

export function themeMode(theme: Theme): ThemeMode {
  return theme === "light" ? "light" : "dark";
}
