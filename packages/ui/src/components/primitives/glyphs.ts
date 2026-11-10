import { Bot, ChartNoAxesColumn, Folder, ListTree, MessagesSquare, Notebook, Settings, type LucideIcon } from "lucide-react";

/**
 * Glyphs with a meaning used in more than one place (contract v6 decision 14): one glyph per meaning,
 * never one glyph for two meanings. File types live in `files/fileIcons.ts`.
 */
export const GLYPH = {
  /** The orchestrator conversation (Chat tab). */
  chat: MessagesSquare,
  /** One sub-agent's transcript (Agent tab), and an ACP agent in the "+" menu. */
  agent: Bot,
  /** The delegation tree of every agent (Agents tool): a plain indented list, not a diagram. */
  agents: ListTree,
  /** Project notes (Notes tool). */
  notes: Notebook,
  /** The project's files (Files tool, file view). */
  files: Folder,
  /** Facts about the project: folders, models, tokens, activity, files written (Details tool). */
  details: ChartNoAxesColumn,
  /** Settings, app-wide and per project: one gear (the tooltip says which). */
  settings: Settings,
} satisfies Record<string, LucideIcon>;
