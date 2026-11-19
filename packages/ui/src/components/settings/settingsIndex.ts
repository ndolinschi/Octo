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
  { id: "integrations", label: "Integrations" },
  { id: "usage", label: "Usage and budget" },
  { id: "memory", label: "Memory" },
  { id: "commands", label: "Commands and review" },
  { id: "privacy", label: "Privacy and data" },
  { id: "remote", label: "Remote access" },
  { id: "about", label: "About" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** Decision 89 f: the Agents page is gone; its address opens Providers. */
const RENAMED: Record<string, SectionId> = { agents: "providers" };

export function sectionOf(raw: string | null): SectionId {
  return SECTIONS.find((s) => s.id === raw)?.id ?? (raw ? RENAMED[raw] : undefined) ?? "general";
}

export function sectionLabel(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

export type IndexedRow = {
  section: SectionId;
  id: string;
  title: string;
  description: string;
  keywords?: string;
  /** A8: a row the phone does not show (it has no keyboard). */
  desktopOnly?: true;
};

export const SETTINGS_INDEX: readonly IndexedRow[] = [
  { section: "general", id: "startup", title: "On startup", description: "What the app shows when it opens", keywords: "launch open home last project" },
  {
    section: "general",
    id: "sidebar-view",
    title: "Sidebar shows",
    description: "Projects and sessions, projects, or sessions",
    keywords: "sidebar tree sessions projects view list",
  },
  {
    section: "general",
    id: "bridge",
    title: "Octo's local service",
    description: "The background service that keeps projects and runs agents",
    keywords: "harness connection bridge url offline retry",
  },
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
    description: "Ways to run models: coding agents, an API key, the Octo router",
    keywords: "connect reconnect remove login install claude copilot grok codex agents subscription acp models roles preferred model",
  },
  {
    section: "providers",
    id: "api-key",
    title: "Anthropic API key",
    description: "Pay per token with your own Anthropic key",
    keywords: "secret key anthropic",
  },
  {
    section: "providers",
    id: "router",
    title: "Use the Octo router",
    description: "Send model requests through the Octo router",
    keywords: "router openrouter upstream",
  },
  { section: "providers", id: "router-url", title: "External router URL", description: "A router you run yourself", keywords: "router base url" },
  {
    section: "providers",
    id: "upstream-key",
    title: "Router provider key",
    description: "The provider key the router uses (for example OpenRouter)",
    keywords: "openrouter secret upstream",
  },
  {
    section: "models",
    id: "default-orchestrator",
    title: "Default model",
    description: "Answers in new projects",
    keywords: "model default orchestrator main",
  },
  {
    section: "models",
    id: "tiers",
    title: "Tiers",
    description: "Fast, balanced and deep models for work handed to an agent",
    keywords: "fast balanced deep tier roles speed",
  },
  { section: "models", id: "visible", title: "Models in menus", description: "Which models appear when you choose one", keywords: "hide show list picker" },
  {
    section: "editor",
    id: "completion",
    title: "Inline completion",
    description: "Whether code suggestions run as you type, per project",
    keywords: "autocomplete copilot suggestions ollama small tier",
  },
  {
    section: "editor",
    id: "compact-folders",
    title: "Compact folders",
    description: "Folders that hold only one folder share a row in the file tree",
    keywords: "file tree compact middle packages java nested directories chain",
  },
  {
    section: "editor",
    id: "completion-model",
    title: "Ollama small-tier model",
    description: "The Ollama model tag used when inline completion runs through the small tier",
    keywords: "ollama small tier completion qwen model tag autocomplete",
  },
  {
    section: "editor",
    id: "ollama-url",
    title: "Ollama server URL",
    description: "Where Ollama listens for inline completion requests",
    keywords: "ollama url endpoint local completion small tier",
  },
  {
    section: "integrations",
    id: "plugins",
    title: "Integrations",
    description: "Language help, agents and extra tools from plugins",
    keywords: "plugins lsp language server tool server mcp agents",
  },
  {
    section: "commands",
    id: "project-commands",
    title: "Project commands",
    description: "Commands you start yourself, from the header or by name",
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
  { section: "usage", id: "limits", title: "Subscription limits", description: "Usage limits reported by the provider", keywords: "rate limit quota plan" },
  { section: "usage", id: "budget", title: "Budget", description: "A total spending cap per project", keywords: "spend cost usd cap limit" },
  {
    section: "memory",
    id: "auto-memory",
    title: "Auto-memory",
    description: "Ask before remembering, review each item, allow automatically, or block for this project",
    keywords: "memory remember auto block allow review prompt",
  },
  {
    section: "memory",
    id: "context",
    title: "Context mode",
    description: "How each project decides what the model reads",
    keywords: "memory window full history digest",
  },
  {
    section: "privacy",
    id: "feature-auto-memory",
    title: "Auto-memory prompt & digest",
    description: "Process-wide feature flag for automatic memory prompts and digests",
    keywords: "feature flag auto memory digest toggle",
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
    title: "Record what agents send and receive",
    description: "Each agent conversation saved to a file, secrets removed",
    keywords: "debug log trace acp wire",
  },
  { section: "privacy", id: "data-dir", title: "Data folder", description: "Where Octo keeps projects and traces", keywords: "directory folder path harness" },
  {
    section: "privacy",
    id: "child-env",
    title: "Environment passed to agents",
    description: "Variables agents and tools may see",
    keywords: "env allow list variables",
  },
  {
    section: "privacy",
    id: "import-sessions",
    title: "Import sessions",
    description: "Bring in past conversations from Claude Code, Codex, Gemini, and OpenCode",
    keywords: "import claude codex gemini opencode history sessions migrate",
  },
  {
    section: "privacy",
    id: "delete-all-sessions",
    title: "Delete all sessions",
    description: "Delete every session and message across all projects",
    keywords: "delete clear wipe reset all sessions messages privacy",
  },
  {
    section: "remote",
    id: "remote",
    title: "Remote access",
    description: "Reach this computer from your phone through Cloudflare",
    keywords: "phone mobile tunnel cloudflare cloudflared remote pair qr devices",
  },
  { section: "remote", id: "remote-add", title: "Add a device", description: "A QR code and a code that work once", keywords: "add device pairing qr code" },
  { section: "about", id: "version", title: "Version", description: "Octo's local service and the app", keywords: "about build" },
  {
    section: "about",
    id: "shortcuts",
    title: "Keyboard shortcuts",
    description: "Every shortcut in one list",
    keywords: "keys hotkeys help",
    desktopOnly: true,
  },
];

/** Rows whose title, description, keywords or section match every word of `query`, in index order. */
export function searchSettings(query: string, opts?: { phone?: boolean }): IndexedRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_INDEX.filter((r) => {
    if (opts?.phone && r.desktopOnly) return false;
    const text = `${r.title} ${r.description} ${r.keywords ?? ""} ${sectionLabel(r.section)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
