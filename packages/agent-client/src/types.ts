export type ShellKind = "desktop" | "web" | "vscode";

export type AgentBridgeConfig = {
  baseUrl: string;
  shell: ShellKind;
};

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8790";

export type Tier = "fast" | "balanced" | "deep";
export type AgentStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
/** How an Octo router treats the tier hint: auto (may go lower or higher), ceiling (never above), fixed (the hint's tier). */
export type TierPolicy = "auto" | "ceiling" | "fixed";
export type Models = {
  orchestrator: string;
  fast: string;
  balanced: string;
  deep: string;
  tier_policy?: TierPolicy;
  /** Model for side questions; absent means the fast tier. Cannot be cleared once set. */
  side?: string;
};
export type Folder = { id: string; label: string; path: string };

export type ProjectInput = {
  name: string;
  description?: string;
  instructions?: string;
  folders?: { path: string; label?: string }[];
  models?: Partial<Models>;
  max_depth?: number;
  /** Spend cap in USD (> 0); null removes it (PATCH only). */
  budget_usd?: number | null;
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
  /** Spend cap in USD; null: none. */
  budget_usd?: number | null;
  /** Last known spend in USD (router report or usage rows); null: unknown. */
  spent_usd?: number | null;
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
  /** Tokens in the agent's context and the window size; null when unknown (the bridge always sends them). */
  context_used?: number | null;
  context_size?: number | null;
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

/** A transcript marker: the history up to and including message `upto_message_id` was replaced by a summary at `at`. */
export type CompactionMarker = {
  upto_message_id: number;
  at: string;
  /** Estimated size of the summary (characters / 4); absent from older harnesses. */
  summary_tokens?: number;
};

/** What `GET .../agents/{aid}/messages` returns: the raw messages plus the compaction markers. */
export type Transcript = { messages: Message[]; compactions: CompactionMarker[] };

export type ContextPartKey = "system" | "tools" | "notes" | "messages" | "tool_results" | "summary";
export type ContextPart = { key: ContextPartKey; tokens: number };

/**
 * `GET /v1/projects/{pid}/context`: what the agent's next request would contain.
 * `used_tokens` is the last response's reported input (+ cache read/write) when
 * `estimated` is false, else a character-count estimate; `parts` is always an estimate scaled to sum to
 * `used_tokens`. `window_tokens` is null when the model's window is unknown.
 */
export type ContextBreakdown = {
  agent_id: string;
  model: string;
  window_tokens: number | null;
  used_tokens: number;
  estimated: boolean;
  parts: ContextPart[];
};

/** One turn of the project's side conversation. A question and its answer share `side_id`. */
export type SideMessage = {
  id: number;
  side_id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
};

/** The 202 body of `POST .../side`: the stored question; the answer arrives as side.* events. */
export type SideStarted = { side_id: string; message: SideMessage };

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

export type AgentCompactedEvent = {
  type: "agent.compacted";
  seq: number;
  agent_id: string;
  upto_message_id: number;
  summary_tokens?: number;
  at: string;
};

/** Streamed text of a side answer (only when the harness streams); the final text is in side.done. */
export type SideDeltaEvent = { type: "side.delta"; seq: number; side_id: string; text: string };
export type SideDoneEvent = { type: "side.done"; seq: number; side_id: string; message: SideMessage };
/** The question failed or was cancelled (`error` is "cancelled" when the conversation was cleared); its stored question is gone. */
export type SideErrorEvent = { type: "side.error"; seq: number; side_id: string; error: string };

export type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number };
export type FileStat = { folder: string; path: string; size: number; mtime: string };
export type FileContent = FileStat & { content: string };
export type WriteFileInput = {
  folder: string;
  path: string;
  content: string;
  expected_mtime?: string;
};

export type FileChangedEvent = {
  type: "file.changed";
  seq: number;
  folder: string;
  path: string;
  source: "user" | "agent";
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
  | FileChangedEvent
  | TurnFinishedEvent
  | AgentCompactedEvent
  | SideDeltaEvent
  | SideDoneEvent
  | SideErrorEvent;

export type BridgeEventType = BridgeEvent["type"];

export type BridgeConfig = {
  default_models: Models;
  default_max_depth: number;
  /** An Octo router was detected behind the harness's base URL. */
  router?: boolean;
  /** Capabilities the router announced (autoroute, route_hints, result_headers, budget_key). */
  router_capabilities?: string[];
};

export type PluginLanguageServer = {
  id: string;
  label: string;
  languages: string[];
  available: boolean;
};
export type PluginAgent = {
  id: string;
  label: string;
  available: boolean;
  /** Result of the manifest's login probe; null (or absent) when there is no probe or no result yet. */
  logged_in?: boolean | null;
  /** Models the manifest lists for spawn_agent's `model`; empty or absent when it lists none. */
  models?: string[];
  default_model?: string;
  /** One-line login instruction from the manifest. */
  hint?: string;
};
export type PluginToolServer = { url: string };

export type Plugin = {
  name: string;
  version: string;
  description: string;
  language_servers: PluginLanguageServer[];
  agents: PluginAgent[];
  tool_servers: PluginToolServer[];
  errors: string[];
};

export type LanguageServerInfo = {
  id: string;
  label: string;
  languages: string[];
  available: boolean;
};

export type LanguageServerExit = { code: number; reason?: string };
export type LanguageServerFolder = { uri: string; name: string };

export type LanguageServerSession = {
  rootUri: string;
  workspaceFolders: LanguageServerFolder[];
  send(message: unknown): Promise<void>;
  onMessage(cb: (message: unknown) => void): () => void;
  onExit(cb: (info: LanguageServerExit) => void): () => void;
  close(): Promise<void>;
};

export type UsageGroup = "day" | "model" | "project" | "agent";

/** `from`/`to` are RFC 3339 or YYYY-MM-DD (UTC; `to` exclusive); default is the last 30 days, grouped by day. */
export type UsageParams = {
  from?: string;
  to?: string;
  group?: UsageGroup;
  /** Narrows the report to one project id. */
  project?: string;
};

export type UsageBucket = {
  /** Day (YYYY-MM-DD), model id, project id or agent id. */
  key: string;
  /** Same as key for day and model; the project name or the agent role otherwise. */
  label: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  /** Reported cost plus estimated cost; null when nothing in the bucket has a price. */
  cost_usd: number | null;
  /** True when any part comes from the harness's price table. */
  cost_estimated: boolean;
};

export type UsageReport = {
  from: string;
  to: string;
  group: UsageGroup;
  buckets: UsageBucket[];
  total: UsageBucket;
};

export type LimitKind = "requests" | "tokens" | "input_tokens" | "output_tokens";

export type Limit = {
  /** Host of the harness's base URL, e.g. "api.anthropic.com". */
  provider: string;
  /** Model of the response the headers came with. */
  model: string;
  kind: LimitKind;
  limit: number | null;
  remaining: number | null;
  /** RFC 3339; duration resets are converted using observed_at. */
  resets_at: string | null;
  observed_at: string;
};
