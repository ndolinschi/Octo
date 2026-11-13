/**
 * Decision 59: the sections of the settings page and the rows the search field finds across all of them. React-free
 * (glyphs live in `SettingsNav`); a row added to a section is added here with the same `id` (its anchor, `row-<id>`).
 */
export const SECTIONS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "editor", label: "Editor" },
  { id: "usage", label: "Usage and budget" },
  { id: "memory", label: "Memory" },
  { id: "commands", label: "Commands and review" },
  { id: "privacy", label: "Privacy and data" },
  { id: "about", label: "About" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** Sections whose page uses the whole width (a list beside a detail) instead of the 780px column. */
export const isWideSection = (id: SectionId): boolean => id === "providers";

/** Decision 89 f: the Agents page is gone; its address opens Providers. */
const RENAMED: Record<string, SectionId> = { agents: "providers" };

export function sectionOf(raw: string | null): SectionId {
  return SECTIONS.find((s) => s.id === raw)?.id ?? (raw ? RENAMED[raw] : undefined) ?? "general";
}

export function sectionLabel(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

export type IndexedRow = { section: SectionId; id: string; title: string; description: string; keywords?: string };

export const SETTINGS_INDEX: readonly IndexedRow[] = [
  { section: "general", id: "startup", title: "On startup", description: "What the app shows when it opens", keywords: "launch open home last project" },
  { section: "general", id: "bridge", title: "Harness connection", description: "The harness this window talks to", keywords: "bridge url offline retry" },
  { section: "appearance", id: "theme", title: "Theme", description: "Dark, light, or follow the system", keywords: "dark light mode colour color" },
  {
    section: "appearance",
    id: "backdrop",
    title: "Start-screen backdrop",
    description: "The streak behind Home and empty projects",
    keywords: "streak vivid mono off background",
  },
  { section: "appearance", id: "motion", title: "Reduce motion", description: "Turn off transitions and animations", keywords: "animation accessibility" },
  {
    section: "providers",
    id: "providers",
    title: "Providers",
    description: "What can run a model: an API key, the router, agents",
    keywords: "connect reconnect remove login install claude copilot grok codex agents subscription acp models roles preferred model",
  },
  {
    section: "providers",
    id: "api-key",
    title: "Anthropic API key",
    description: "Bill per token through your own key (in the API provider)",
    keywords: "secret key anthropic",
  },
  {
    section: "providers",
    id: "router",
    title: "Use the Octo router",
    description: "Route requests through the bundled router",
    keywords: "router openrouter upstream",
  },
  { section: "providers", id: "router-url", title: "External router URL", description: "A router you run yourself", keywords: "router base url" },
  {
    section: "providers",
    id: "upstream-key",
    title: "Router upstream key",
    description: "The key the router forwards to (for example OpenRouter)",
    keywords: "openrouter secret",
  },
  { section: "models", id: "default-orchestrator", title: "Default orchestrator", description: "Runs new projects' orchestrators", keywords: "model default" },
  { section: "models", id: "tiers", title: "Tiers", description: "Fast, balanced and deep models for delegated work", keywords: "fast balanced deep tier" },
  { section: "models", id: "visible", title: "Models in pickers", description: "Which models appear when you choose one", keywords: "hide show list picker" },
  {
    section: "editor",
    id: "completion",
    title: "Inline completion",
    description: "The model that suggests code as you type, per project",
    keywords: "autocomplete copilot suggestions",
  },
  {
    section: "editor",
    id: "plugins",
    title: "Plugins and language servers",
    description: "What the harness loaded from plugin manifests",
    keywords: "integrations lsp language server tool server mcp",
  },
  {
    section: "commands",
    id: "project-commands",
    title: "Project commands",
    description: "Named shell commands you run from a review or by name",
    keywords: "run tests dev server build scripts pinned",
  },
  {
    section: "commands",
    id: "review-commands",
    title: "Commands offered in a review",
    description: "Which commands a pull request's Run menu lists",
    keywords: "pull request run worktree",
  },
  {
    section: "commands",
    id: "review-mechanical",
    title: "Folded as mechanical",
    description: "Paths a review folds away in its reading order",
    keywords: "glob generated lock snapshot fold",
  },
  {
    section: "commands",
    id: "review-prefer",
    title: "Diff layout",
    description: "One column, side by side, or by width",
    keywords: "split unified side by side review diff",
  },
  { section: "usage", id: "limits", title: "Plan limits", description: "Rate limits the provider reported", keywords: "rate limit quota" },
  { section: "usage", id: "budget", title: "Budget", description: "A spending cap per project", keywords: "spend cost usd cap" },
  {
    section: "memory",
    id: "context",
    title: "Context mode",
    description: "How each project's orchestrator builds its context",
    keywords: "memory window full history digest",
  },
  {
    section: "privacy",
    id: "diagnostics",
    title: "Copy diagnostic report",
    description: "Versions, agents and recent logs, without secrets",
    keywords: "doctor report debug support",
  },
  {
    section: "privacy",
    id: "trace",
    title: "Record an ACP wire trace",
    description: "Write what agents send and receive, secrets removed",
    keywords: "debug log trace",
  },
  { section: "privacy", id: "data-dir", title: "Data folder", description: "Where the harness keeps projects and traces", keywords: "directory folder path" },
  {
    section: "privacy",
    id: "child-env",
    title: "Environment passed to agents",
    description: "Variables agents and tools may see",
    keywords: "env allow list variables",
  },
  { section: "about", id: "version", title: "Version", description: "The harness and the app", keywords: "about build" },
];

/** Rows whose title, description, keywords or section match every word of `query`, in index order. */
export function searchSettings(query: string): IndexedRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_INDEX.filter((r) => {
    const text = `${r.title} ${r.description} ${r.keywords ?? ""} ${sectionLabel(r.section)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
