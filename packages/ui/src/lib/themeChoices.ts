import type { ThemePref } from "./theme";

/** The theme picker's choices (Settings → Appearance, a lazy chunk): apart from `theme`, which the entry imports. */
export const THEME_CHOICES = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark", description: "Octo's default neutral dark" },
  { id: "cursor", label: "Cursor", description: "Cool charcoal & electric blue" },
  { id: "claude", label: "Claude Code", description: "Warm espresso & terracotta" },
  { id: "codex", label: "Codex", description: "Deep ink slate & emerald" },
  { id: "opencode", label: "OpenCode", description: "Midnight graphite & violet" },
  { id: "light", label: "Light" },
] as const satisfies readonly { id: ThemePref; label: string; description?: string }[];
