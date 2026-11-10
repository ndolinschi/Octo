export type ShellKind = "desktop" | "web";

export type AgentBridgeConfig = {
  baseUrl: string;
  shell: ShellKind;
};

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8790";

export type Tier = "fast" | "balanced" | "deep";
export type AgentStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
export type Models = { orchestrator: string; fast: string; balanced: string; deep: string };
export type Folder = { id: string; label: string; path: string };

export type ProjectInput = {
  name: string;
  description?: string;
  instructions?: string;
  folders?: { path: string; label?: string }[];
  models?: Partial<Models>;
  max_depth?: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: "idle" | "running";
  folder_count: number;
  agent_count: number;
  created_at: string;
  updated_at: string;
};

export type Project = ProjectSummary & {
  instructions: string;
  folders: Folder[];
  models: Models;
  max_depth: number;
  orchestrator_agent_id: string;
};

export type Agent = {
  id: string;
  project_id: string;
  parent_id: string | null;
  depth: number;
  role: string;
  title: string;
  task: string;
  model: string;
  tier: Tier | null;
  status: AgentStatus;
  result: string | null;
  error: string | null;
  spawn_tool_use_id: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

export type Message = {
  id: number;
  agent_id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  created_at: string;
};

export type Note = {
  id: string;
  title: string;
  content: string;
  author: "user" | "orchestrator";
  created_at: string;
  updated_at: string;
};

export type TurnStatus = "completed" | "failed" | "cancelled";

export type AgentCreatedEvent = { type: "agent.created"; seq: number; agent: Agent };
export type AgentUpdatedEvent = { type: "agent.updated"; seq: number; agent: Agent };
export type MessageCreatedEvent = { type: "message.created"; seq: number; message: Message };
export type MessageDeltaEvent = { type: "message.delta"; seq: number; agent_id: string; text: string };
export type ToolStartedEvent = {
  type: "tool.started";
  seq: number;
  agent_id: string;
  tool_use_id: string;
  name: string;
};
export type ToolFinishedEvent = {
  type: "tool.finished";
  seq: number;
  agent_id: string;
  tool_use_id: string;
  is_error: boolean;
};
export type NoteChangedEvent = { type: "note.changed"; seq: number; note: Note | null; note_id: string };
export type ProjectUpdatedEvent = { type: "project.updated"; seq: number; project: Project };
export type TurnFinishedEvent = {
  type: "turn.finished";
  seq: number;
  status: TurnStatus;
  error: string | null;
};

export type BridgeEvent =
  | AgentCreatedEvent
  | AgentUpdatedEvent
  | MessageCreatedEvent
  | MessageDeltaEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | NoteChangedEvent
  | ProjectUpdatedEvent
  | TurnFinishedEvent;

export type BridgeEventType = BridgeEvent["type"];

export type BridgeConfig = { default_models: Models; default_max_depth: number };
