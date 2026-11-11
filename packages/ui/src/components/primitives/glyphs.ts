import {
  Bot,
  FileDiff,
  ChartNoAxesColumn,
  Folder,
  Gauge,
  ListTree,
  MessageCircleQuestionMark,
  Notebook,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * Glyphs with a meaning used in more than one place (contract v6 decision 14): one glyph per meaning,
 * never one glyph for two meanings. File types live in `files/fileIcons.ts`.
 */
export const GLYPH = {
  /** The project's orchestrator (its tab, decision 23): plans and delegates, so a flow glyph, not a chat bubble. */
  chat: Workflow,
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
  /** Tokens, cost and limits (Usage tool, Home's Tokens card). */
  usage: Gauge,
  /** What the agents changed in the project: diffs, revert (Changes tool). */
  changes: FileDiff,
  /** A side question about the project that does not enter the orchestrator's history (decision 40). */
  side: MessageCircleQuestionMark,
  /** Settings, app-wide and per project: one gear (the tooltip says which). */
  settings: Settings,
} satisfies Record<string, LucideIcon>;
