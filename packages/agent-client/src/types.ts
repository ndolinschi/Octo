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
/**
 * A model setting that names an ACP agent instead of a Messages API model:
 * `acp:<agent-id>` or `acp:<agent-id>/<model>`. Valid for `orchestrator` (the
 * orchestrator then runs as an ACP session) and for the tiers (`spawn_agent`
 * with that tier starts that agent). The harness answers 400 for an unknown or
 * unavailable agent; the orchestrator agent's `model` reads the same form.
 */
export type AcpModelRef = `acp:${string}`;
export type Models = {
  /** A Messages API model id, or an {@link AcpModelRef}. */
  orchestrator: string;
  fast: string;
  balanced: string;
  deep: string;
  tier_policy?: TierPolicy;
  /** Model for side questions; absent means the fast tier. Cannot be cleared once set. */
  side?: string;
  /**
   * Model of the editor's inline completion: a Messages API model id or a tier (`fast`, `balanced`, `deep`); absent
   * means the feature is off. Send `"off"` in an update to clear it. Never an ACP agent (400).
   */
  completion?: string;
  /**
   * Restricts and orders what a delegation with tier `auto` may choose from: `fast`, `balanced`, `deep` or
   * `acp:<id>[/<model>]`. Absent or empty: every API tier and every ready ACP agent. Send `[]` to clear.
   */
  auto_candidates?: string[];
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
  /** v7: `supervised` asks before writes, commands and ACP permission requests; `full` never asks. */
  access?: AccessMode;
  /** M2: how the orchestrator's context is built; fields left out keep their value (PATCH merges). */
  memory?: Partial<MemorySettings>;
};

/** Project memory setting (M2). `full` sends the whole transcript (the default); `window` assembles the context from blocks with caps. */
export type MemorySettings = { context: "full" | "window"; recent_exchanges: number };

/** Access mode of a project (v7 approvals). */
export type AccessMode = "supervised" | "full";

/** What a project asks of the user (harness 0.2+): `failed` after a failed turn (the error is on the orchestrator's agent). */
export type ProjectAttentionKind = "none" | "needs_you" | "failed";

/** A model a project stores whose provider cannot run it now (`GET /v1/projects/{id}`; reading never fails because of it). */
export type ModelIssue = { field: string; model: string; provider: string; reason: string };

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: "idle" | "running";
  folder_count: number;
  agent_count: number;
  created_at: string;
  updated_at: string;
  /** v7: an approval or a form waits for the user (a turn that waits is still `running`). */
  needs_you?: boolean;
  pending_approvals?: number;
  pending_inputs?: number;
  /** "needs_you" while an approval or a form waits; "failed" when the last turn failed and nothing waits; else "none". */
  attention?: ProjectAttentionKind;
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
  /** v7: the project's access mode (`full` for projects that predate approvals). */
  access?: AccessMode;
  /** M2: the memory setting (`context: "full"`, 5 exchanges for projects that predate it). */
  memory?: MemorySettings;
  /** Stored models whose provider cannot run them now (see {@link ModelIssue}); empty when everything can run. */
  models_unavailable?: ModelIssue[];
};

export type Agent = {
  /** The latest plan an ACP agent published (absent on a harness that predates plans). */
  plan?: PlanEntry[] | null;
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
  /** What to do about `error`, kept apart from its text; null when there is none. */
  error_hint?: string | null;
  spawn_tool_use_id: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Tokens in the agent's context and the window size; null when unknown (the bridge always sends them). */
  context_used?: number | null;
  context_size?: number | null;
  /**
   * The model that answered the agent's newest main-thread request, as reported by an Octo router, and the router
   * tier it chose (`tier` above is the tier the agent was spawned at). null: no router in the path or nothing recorded.
   * Show `served_model` rather than `model` when it is set; `agent.updated` carries a new value when it changes.
   */
  served_model?: string | null;
  routed_tier?: string | null;
  /**
   * The decision for a sub-agent spawned with tier `auto`; all null for an explicit tier. `route_choice` is the
   * candidate that was started (`fast|balanced|deep` or `acp:<id>[/<model>]`, also after a fallback), `route_reason`
   * why (the router's words, or "no router" / "router did not answer: ..." on a fallback), `route_band` the router's
   * difficulty class, `route_request_id` the router's id of the route call.
   */
  route_reason?: string | null;
  route_band?: "easy" | "medium" | "hard" | null;
  route_request_id?: string | null;
  route_choice?: string | null;
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
  /** An assistant message cut short because the turn was cancelled. */
  stopped?: boolean;
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

/** One line of an ACP agent's plan. */
export type PlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed" | (string & {});
  priority: "high" | "medium" | "low" | (string & {});
};

/** What an agent is doing now; `quiet`: nothing at all has arrived from it for a while (label is the agent's name). */
export type ActivityKind = "thinking" | "tool" | "text" | "waiting_approval" | "idle" | "quiet";
export type AgentActivity = { kind: ActivityKind; label: string; tool_use_id?: string };

export type TurnStatus = "completed" | "failed" | "cancelled";

export type AgentCreatedEvent = { type: "agent.created"; seq: number; agent: Agent };
export type AgentUpdatedEvent = { type: "agent.updated"; seq: number; agent: Agent };
export type MessageCreatedEvent = { type: "message.created"; seq: number; message: Message };
/** A stored message changed (a tool call whose input arrived after it was announced). */
export type MessageUpdatedEvent = { type: "message.updated"; seq: number; message: Message };
export type MessageDeltaEvent = { type: "message.delta"; seq: number; agent_id: string; text: string };
export type ToolStartedEvent = {
  type: "tool.started";
  seq: number;
  agent_id: string;
  tool_use_id: string;
  name: string;
};
/** An ACP agent's reasoning, streamed; never stored (not in messages, not searchable). */
export type ThinkingDeltaEvent = { type: "message.thinking_delta"; seq: number; agent_id: string; text: string };
/** An ACP agent's whole current plan (each event replaces the previous one). */
export type AgentPlanEvent = { type: "agent.plan"; seq: number; agent_id: string; entries: PlanEntry[] };
/** What an agent is doing now, on every transition (built-in loop and ACP alike). */
export type AgentActivityEvent = { type: "agent.activity"; seq: number; agent_id: string } & AgentActivity;
/** What a `tool_call_update` changed on an ACP tool row; only the fields that changed are present. */
export type ToolUpdatedEvent = {
  type: "tool.updated";
  seq: number;
  agent_id: string;
  tool_use_id: string;
  status?: string;
  title?: string;
  locations?: string[];
  summary?: string;
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
  /** What to do about `error` (for a login problem: how to log in). Never part of the error text. */
  hint?: string;
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

/**
 * Settings were changed through PUT /v1/settings: the ids that changed, never values. The harness has no global
 * stream, so it arrives on the stream of every project; refetch GET /v1/settings (and /v1/config) when it does.
 */
export type SettingsChangedEvent = { type: "settings.changed"; seq: number; ids: string[] };

/** A file change was recorded (v7): by write_file, ACP fs/write_text_file, or a bash / ACP-turn snapshot. */
export type ChangeRecordedEvent = { type: "change.recorded"; seq: number; turn_id: number; change: FileChange };
export type ApprovalRequestedEvent = { type: "approval.requested"; seq: number; approval: Approval };
export type ApprovalResolvedEvent = { type: "approval.resolved"; seq: number; id: string; decision: ApprovalDecision };
/** A form was opened by `request_input`; it carries the schema only. */
export type InputRequestedEvent = { type: "input.requested"; seq: number; input: InputRequest };
/** A form was answered. `provided` lists the secret fields' ids (never values); `values` the non-secret ones. */
export type InputResolvedEvent = {
  type: "input.resolved";
  seq: number;
  id: string;
  status: "submitted" | "skipped" | "cancelled";
  provided: string[];
  values: Record<string, string | boolean>;
};
export type QueueUpdatedEvent = { type: "queue.updated"; seq: number; paused: boolean; messages: QueuedMessage[] };
/**
 * How many approvals and forms wait for the user. `state` is present when a turn started or ended: `failed` (with the
 * `error`) after a failed turn, `none` when a retry starts; events without it leave the last state unchanged.
 */
export type ProjectAttentionEvent = {
  type: "project.attention";
  seq: number;
  needs_you: boolean;
  approvals: number;
  inputs: number;
  state?: "none" | "failed";
  error?: string;
};

/**
 * What can run a model changed (a login probe result, a key, a router, the models an agent advertised). Delivered on
 * every project stream, like `settings.changed`; refetch `listProviders` when it arrives.
 */
export type ProvidersUpdatedEvent = { type: "providers.updated"; seq: number; connected: number };
/** Names (never values) of secrets that were stored or deleted. */
export type SecretsChangedEvent = { type: "secrets.changed"; seq: number; names: string[] };

/** A task record was created or changed (M1); `deleted` says an auto-opened record was merged into another task. */
export type TaskUpdatedEvent = { type: "task.updated"; seq: number; task?: Task; task_id?: string; deleted?: boolean };
/** A memory file was written, deleted or renamed. */
export type MemoryUpdatedEvent = { type: "memory.updated"; seq: number; path: string; deleted?: boolean; renamed_from?: string };

export type BridgeEvent =
  | AgentCreatedEvent
  | AgentUpdatedEvent
  | MessageCreatedEvent
  | MessageUpdatedEvent
  | MessageDeltaEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | ThinkingDeltaEvent
  | AgentPlanEvent
  | AgentActivityEvent
  | ToolUpdatedEvent
  | NoteChangedEvent
  | ProjectUpdatedEvent
  | FileChangedEvent
  | TurnFinishedEvent
  | AgentCompactedEvent
  | SideDeltaEvent
  | SideDoneEvent
  | SideErrorEvent
  | SettingsChangedEvent
  | ChangeRecordedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | InputRequestedEvent
  | InputResolvedEvent
  | QueueUpdatedEvent
  | ProjectAttentionEvent
  | SecretsChangedEvent
  | ProvidersUpdatedEvent
  | TaskUpdatedEvent
  | MemoryUpdatedEvent;

export type BridgeEventType = BridgeEvent["type"];

/** `api`: the built-in Messages loop; `router`: a detected Octo router; `agent`: an ACP agent of a plugin. */
export type ProviderKind = "api" | "router" | "agent";
/** `error` is reserved for a provider that is set up but failing; the harness does not report it yet. */
export type ProviderState = "ready" | "not_connected" | "not_logged_in" | "not_installed" | "error";
export type ProviderModelSource = "catalogue" | "manifest" | "advertised";

export type ProviderModel = {
  id: string;
  label: string;
  source: ProviderModelSource;
  /** RFC 3339: when an agent last advertised this model. */
  seen_at?: string;
  /** The agent's latest session did not advertise it any more; it is kept, not dropped. */
  stale?: boolean;
};

export type Provider = {
  /** `api`, `router`, or the ACP agent's id (also the `<id>` of `acp:<id>[/<model>]`). */
  id: string;
  kind: ProviderKind;
  label: string;
  state: ProviderState;
  /** Why it is not ready; empty when ready. */
  reason: string;
  /** One line on how to install the agent; empty when not known. */
  install_hint: string;
  /** One line on how to log in or connect; empty when not known. */
  login_hint: string;
  models: ProviderModel[];
  /** The model used when none is named; empty when unknown. */
  default_model: string;
  /** A flat-rate subscription: no per-token charge at the margin. */
  flat_rate: boolean;
};

/** The models a new project gets when the request names none; empty strings when nothing is ready. */
export type SuggestedModels = { orchestrator: string; fast: string; balanced: string; deep: string };

/** `GET /v1/providers`: what can run a model now. API first, then the router (when detected), then agents. */
export type ProvidersResponse = {
  /** How many providers are `ready`. */
  connected: number;
  suggested: SuggestedModels;
  providers: Provider[];
};

export type BridgeConfig = {
  default_models: Models;
  default_max_depth: number;
  /** An Octo router was detected behind the harness's base URL. */
  router?: boolean;
  /** Capabilities the router announced (autoroute, route_hints, result_headers, budget_key). */
  router_capabilities?: string[];
  /** The router announced `route_api`: spawn_agent defaults to tier `auto` and the router chooses who does a task. */
  route_api?: boolean;
  /** ACP agents that can run a project's orchestrator (or a tier): the valid `acp:` settings. */
  acp_orchestrators?: AcpOrchestratorChoice[];
  /**
   * Whether the harness's own Messages-API loop can run: false while no API key and no router is configured. Anything
   * that needs it then fails with `reason`; ACP agents are unaffected.
   */
  builtin_loop?: BuiltinLoopStatus;
  /**
   * What a project without an orchestrator of its own runs on right now: `acp:<id>` of the first available, logged-in
   * agent while the built-in loop is unavailable, else the default orchestrator model.
   */
  default_orchestrator?: string;
};

export type BuiltinLoopStatus = {
  available: boolean;
  /** Present when `available` is false. */
  reason?: string;
};

export type AcpOrchestratorChoice = {
  /** The setting itself, `acp:<id>`; append `/<model>` to pick a model. */
  value: AcpModelRef;
  /** The plugin agent id. */
  id: string;
  label: string;
  /** Models the manifest lists; empty means any model id is accepted. */
  models: string[];
  default_model?: string;
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
  /** Why `available` is false (a required command is missing); absent when available. */
  unavailable_reason?: string;
  /** One-line instruction for installing the agent (manifest `install`); absent when the manifest has none. */
  install_hint?: string;
  /** The manifest says the agent runs on a flat-rate subscription (flatRate; false when absent). */
  flat_rate?: boolean;
  /** Some token counts in the bucket are the harness's estimate (an ACP agent reported none). */
  tokens_estimated?: boolean;
  /** Difficulty bands the manifest says the agent suits (strengths); absent when none. */
  strengths?: ("easy" | "medium" | "hard")[];
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
  /** True for a plugin embedded in the harness binary (absent otherwise). */
  builtin?: boolean;
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
  /**
   * Money spent: reported plus estimated cost. 0 (never null) for a bucket of flat-rate usage only; null when an API
   * request in the bucket has no known cost. Real shapes: `fixtures/usage.*.json`, written by the harness's contract test.
   */
  cost_usd: number | null;
  /** True when any part comes from the harness's price table. */
  cost_estimated: boolean;
  /**
   * What flat-rate (subscription) agents' usage would have cost by their own figures. Not spent and
   * not in `cost_usd`; show it as "≈ $x on your subscription". Null or absent when there is none.
   */
  subscription_equivalent_usd?: number | null;
  /** The bucket holds flat-rate (subscription) usage and nothing else. A bucket with both has it false and both figures. */
  flat_rate?: boolean;
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

/** How a setting is edited: `secret` is write-only (never returned), `model` is a model id or an {@link AcpModelRef}. */
export type SettingKind = "secret" | "text" | "bool" | "model" | "list";
export type SettingGroup = "keys" | "models" | "router" | "advanced";
/**
 * Where the effective value comes from. `environment` and `flag` win over the settings file, so such a setting is
 * shown with `editable: false`.
 */
export type SettingSource = "file" | "environment" | "flag" | "default";
export type SettingValue = string | boolean | string[];

export type Setting = {
  /** The variable name in `harness.env`. */
  id: string;
  kind: SettingKind;
  label: string;
  group: SettingGroup;
  /** Absent for secrets and for a text or list setting that is not set. bool: boolean, list: string[], else string. */
  value?: SettingValue;
  /** A value exists (in the file or the environment). For a secret this is all there is to know besides `hint`. */
  set?: boolean;
  /** A secret: "…" and its last four characters (only for a long secret). Otherwise a one-line help text. */
  hint?: string;
  /** Why the setting is locked, when not obvious (for example "set by the app while the bundled router is on"). */
  note?: string;
  source: SettingSource;
  /** `now`: takes effect without a restart. `restart`: the harness (and the shell's sidecars) must be restarted. */
  applies: "now" | "restart";
  editable: boolean;
};

export type SettingsView = {
  settings: Setting[];
  /** Ids written in this process's lifetime whose new value is not applied yet. */
  restart_required: string[];
};

/** Everything is validated before anything is written; `set` of a text or list setting to "" / [] removes it. */
export type SettingsUpdate = {
  set?: Record<string, SettingValue>;
  /** Removes the line: the setting returns to its default. */
  unset?: string[];
};

/** The setting ids, as written in `harness.env`. The router ones are read by the desktop shell, not by the harness. */
export const SETTING_IDS = {
  anthropicApiKey: "ANTHROPIC_API_KEY",
  routerUpstreamKey: "OCTO_ROUTER_UPSTREAM_KEY",
  modelOrchestrator: "HARNESS_MODEL_ORCHESTRATOR",
  modelFast: "HARNESS_MODEL_FAST",
  modelBalanced: "HARNESS_MODEL_BALANCED",
  modelDeep: "HARNESS_MODEL_DEEP",
  routerEnabled: "OCTO_ROUTER_ENABLED",
  routerBaseUrl: "OCTO_ROUTER_BASE_URL",
  childEnvAllow: "HARNESS_CHILD_ENV_ALLOW",
} as const;

// --- v7: changes per turn and diffs ---------------------------------------------------------------------------

export type ChangeKind = "created" | "modified" | "deleted";
/** Why a change has no diff: binary, too_large, no_preimage (the content before was not kept) or pruned (older than 30 days). */
export type ChangeNote = "binary" | "too_large" | "no_preimage" | "pruned" | "";
export type ChangeSource = "write_file" | "acp_fs" | "bash" | "acp_turn";

export type FileChange = {
  id: number;
  /** Id of the orchestrator's user message that started the turn. */
  turn_id: number;
  agent_id: string;
  folder: string;
  path: string;
  kind: ChangeKind;
  /** Line counts; null when no diff is available. */
  added: number | null;
  removed: number | null;
  created_at: string;
  note: ChangeNote;
  source: ChangeSource;
};

/** One file's net change in a turn: first before to last after. A file created and deleted again is not listed. */
export type FileChangeSummary = Omit<FileChange, "id" | "agent_id"> & { change_ids: number[]; agent_ids: string[] };
export type TurnChanges = { turn_id: number; files: FileChangeSummary[]; added: number; removed: number };
export type ChangeDetail = FileChange & { before: string | null; after: string | null; diff_available: boolean };
/** The file after a revert; `deleted` is set when the revert removed a file the change had created. */
export type RevertResult = FileStat & { deleted?: boolean };

// --- v7: message queue ----------------------------------------------------------------------------------------

export type QueuedMessage = { id: string; text: string; created_at: string };
export type QueueState = { paused: boolean; messages: QueuedMessage[] };
/** What POST .../messages answers: the started turn's message, or (a turn is running) the queued one. */
export type SendResult = { message: Message; queued?: undefined } | { queued: QueuedMessage; message?: undefined };

// --- v7: approvals --------------------------------------------------------------------------------------------

export type ApprovalKind = "write" | "command" | "acp";
export type ApprovalDecision = "allow" | "allow_for_turn" | "deny";
export type ApprovalOption = { id: string; label: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };
export type Approval = {
  id: string;
  agent_id: string;
  /** The agent's role, or the plugin id of an ACP agent. */
  agent_label: string;
  turn_id: number;
  kind: ApprovalKind;
  /** "Write src/a.ts", the command line, or the ACP tool title. */
  title: string;
  detail: {
    folder?: string;
    path?: string;
    diff?: { added: number; removed: number };
    command?: string;
    /** The options an ACP agent offered (kind `acp`). */
    options?: ApprovalOption[];
  };
  created_at: string;
};
export type ApprovalAnswer = { decision: ApprovalDecision; option_id?: string; note?: string };

// --- v7: forms and secrets (decision 43) ----------------------------------------------------------------------

export type InputFieldKind = "secret" | "text" | "select" | "confirm" | "path";
export type InputField = {
  id: string;
  label: string;
  kind: InputFieldKind;
  options?: string[];
  required?: boolean;
  help?: string;
};
export type InputRequest = {
  id: string;
  agent_id: string;
  agent_label: string;
  turn_id: number;
  title: string;
  reason: string;
  fields: InputField[];
  created_at: string;
};
/** Submit with `values` by field id (strings; booleans for confirm fields), or skip. */
export type InputAnswer = { skip?: boolean; values?: Record<string, string | boolean> };
/** A stored secret: its name only. Agents use it as `secret:<name>`. */
export type SecretInfo = { name: string; updated_at: string };

// --- R1: diagnostics ------------------------------------------------------------------------------------------

export type DiagnosticsProbe = {
  ran: boolean;
  /** Null when the probe did not run or was inconclusive. */
  logged_in: boolean | null;
  reason: string;
};
export type DiagnosticsAgent = {
  id: string;
  label: string;
  available: boolean;
  /** Resolved path of the agent's program, or "not found". */
  command: string;
  unavailable_reason?: string;
  requires: { command: string; found: string }[];
  probe: DiagnosticsProbe;
  login_hint?: string;
  install_hint?: string;
  flat_rate: boolean;
};
/** `GET /v1/diagnostics`: what a problem report needs, without secrets (names of variables, never values). */
export type Diagnostics = {
  generated_at: string;
  version: string;
  go_version: string;
  os: string;
  arch: string;
  data_dir: string;
  path_for_children: string;
  env_set: string[];
  builtin_loop: { available: boolean; reason?: string };
  router: { base_url: string; detected: boolean; capabilities: string[] };
  agents: DiagnosticsAgent[];
  acp_trace: { enabled: boolean; dir: string; files: string[] };
  log_tail: string[];
  problems: string[];
};

// --- M1: orchestrator memory ----------------------------------------------------------------------------------

export type TaskStatus = "open" | "done" | "dropped";
/** Wording of the user kept exactly, with the message it came from. */
export type TaskQuote = { text: string; message_id: number };
/** A short standalone statement with its date; `superseded_by` names the newer fact (of the same task) that replaced it. */
export type TaskFact = { id: string; text: string; date: string; message_id: number; superseded_by?: string };
/** A task record: the detail map of one piece of work. */
export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  goal: string;
  /** Who wrote the goal: the harness (fallback: the first 400 characters of the request), the orchestrator, or the digest. */
  goal_by: "harness" | "orchestrator" | "digest";
  /** True while the record is the one the harness opened for a request and nobody has edited. */
  auto: boolean;
  constraints: string[];
  acceptance: string[];
  quotes: TaskQuote[];
  decisions: string[];
  outcome: string;
  files: string[];
  facts: TaskFact[];
  message_ids: number[];
  created_at: string;
  updated_at: string;
};
export type MemoryFile = { path: string; summary: string; content?: string; size: number; created_at: string; updated_at: string };
/** `GET .../memory`: the files without content and the harness-generated INDEX.md text. */
export type MemoryList = { files: MemoryFile[]; index: string };
export type MemorySearchKind = "tasks" | "facts" | "files" | "messages";
export type MemoryHit = {
  kind: "task" | "fact" | "file" | "message";
  id: string;
  title: string;
  /** At most 300 characters around the match. */
  snippet: string;
  date: string;
  /** Set on a fact a newer one replaced; such hits come after current ones. */
  superseded?: boolean;
  /** The message a fact came from (the exact words are one recall away). */
  message_id?: number;
  task_id?: string;
};
/** Up to 10 hits; with none, `message` is "nothing in memory matches". */
export type MemorySearchResult = { hits: MemoryHit[]; message?: string };
export type MemorySearchParams = { q: string; in?: MemorySearchKind[]; after?: string; before?: string; limit?: number };

// --- M2: context receipts -------------------------------------------------------------------------------------

/** One block of what the orchestrator's first request of a turn carried. */
export type ReceiptBlock = {
  /** memory_index, open_tasks, recent_window, facts, current_turn (window mode); history (full mode); changed_tasks (a live ACP session). */
  name: string;
  /** The harness's estimate (four characters a token). */
  tokens: number;
  /** The block's cap in tokens; 0 for none. */
  cap: number;
  count: number;
  /** What was included: file paths, task ids, the first message id of each recent exchange, fact ids ("task/fact"), message ids. */
  ids: string[];
};
/** `GET .../turns/{id}/context`: what the orchestrator had in front of it in a turn (id = its user message). */
export type ContextReceipt = {
  turn_id: number;
  mode: "full" | "window";
  recent_exchanges: number;
  blocks: ReceiptBlock[];
  total_tokens: number;
  caps_total: number;
  message_count: number;
  /** Tool results replaced by stubs in this turn's requests. */
  cleared_calls: number;
  created_at: string;
};

/** Body of `POST .../complete`: the text around the cursor (prefix at most 6 000 chars, suffix 2 000; cut on lines). */
export type CompletionRequest = {
  path: string;
  /** Folder label; absent means the first folder. Only used to look at the file's size. */
  folder?: string;
  language?: string;
  prefix: string;
  suffix?: string;
  /** 1 to 20; the harness defaults to 8. */
  max_lines?: number;
  /** Up to three snippets (1 500 chars each) from other open files. */
  snippets?: { path: string; text: string }[];
};

/** The 200 body of `POST .../complete`. A 204 (nothing to suggest, or a file that is never sent) is `null`. */
export type CompletionResult = { text: string; model: string; ms: number };

/** A directory in the folder picker. `git` is read from `.git/HEAD` (no git process): the branch, or a short commit id when detached. */
export type FolderEntry = { name: string; path: string; git: { branch: string } | null };

/** `GET /v1/fs/dirs`: child directories (never files) of `base` that match the typed prefix, at most 50. */
export type DirListing = {
  /** The directory that was listed (absolute). */
  base: string;
  entries: FolderEntry[];
  /** Present, with empty `entries`, when the base is missing or cannot be read. */
  error?: "not_found" | "not_readable";
};
