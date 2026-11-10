import { Bot, Folder, MessagesSquare, Network, NotebookText, type LucideIcon } from "lucide-react";

/**
 * Glyphs with a meaning used in more than one place (contract v6 decision 14): one glyph per meaning,
 * never one glyph for two meanings. File types live in `files/fileIcons.ts`.
 */
export const GLYPH = {
  /** The orchestrator conversation (Chat tab). */
  chat: MessagesSquare,
  /** One sub-agent's transcript (Agent tab), and an ACP agent in the "+" menu. */
  agent: Bot,
  /** The delegation tree of every agent (Agents tool). */
  agents: Network,
  /** Project notes (Notes tool). */
  notes: NotebookText,
  /** The project's files (Files tool, file view). */
  files: Folder,
} satisfies Record<string, LucideIcon>;
