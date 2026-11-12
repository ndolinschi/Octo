import type { CommandFinishedEvent, CommandOutputEvent, CommandStartedEvent, ProjectCommand, ReviewConfig, ReviewConfigInput } from "./commands";
import type { ReviewListUpdatedEvent, ReviewUpdatedEvent, ReviewWorkspace, ReviewWorkspaceEvent } from "./review";

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

/** Parity B3: `agent` acts, `ask` answers read-only, `plan` answers with a plan to approve. */
export type ProjectMode = "agent" | "ask" | "plan";

export type ProjectInput = {
  name: string;
  /** Parity B3: the project's default mode (a message may override it for one turn). */
  mode?: ProjectMode;
  description?: string;
  instructions?: string;
  folders?: { path: string; label?: string }[];
  models?: Partial<Models>;
  /**
   * Accept a model of an agent the login probe says is logged out (answer to a 422 `model_unavailable` whose
   * `BridgeError.can_force` is true). The agent then starts normally and, if it really is logged out, the turn fails
   * with its own message. A missing command is never forced.
   */
  force_unverified?: boolean;
  max_depth?: number;
  /** Spend cap in USD (> 0); null removes it (PATCH only). */
  budget_usd?: number | null;
  /** v7: `supervised` asks before writes, commands and ACP permission requests; `full` never asks. */
  access?: AccessMode;
  /** M2: how the orchestrator's context is built; fields left out keep their value (PATCH merges). */
  memory?: Partial<MemorySettings>;
  /** Decision 68: the project's named commands; a PATCH replaces the whole list (validated: 400 `invalid_request`). */
  commands?: ProjectCommand[];
  /** Review configuration; a PATCH replaces it as a whole (400 `invalid_request` when invalid). */
  review?: ReviewConfigInput;
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
  /** Parity B3: the project's default mode (absent on a harness that predates modes). */
  mode?: ProjectMode;
  /** Parity B2: `"off"` (default) or `"on"`: agents get web_fetch only when on. */
  network?: "off" | "on";
  /** Parity B2: web_fetch may reach private and loopback addresses. */
  network_private?: boolean;
  /** M2: the memory setting (`context: "full"`, 5 exchanges for projects that predate it). */
  memory?: MemorySettings;
  /** Decision 68: the project's named commands (empty when none; absent on a harness that predates them). */
  commands?: ProjectCommand[];
  /** The review configuration (defaults when none was set; absent on a harness that predates it). */
  review?: ReviewConfig;
  /** RV1.5: the review whose worktree the file tree, editor, search and language server are pointed at; null/absent: the project's folders. */
  review_workspace?: ReviewWorkspace | null;
  /** Stored models whose provider cannot run them now (see {@link ModelIssue}); empty when everything can run. */
  models_unavailable?: ModelIssue[];
  /** Parity B12: whether the orchestrator takes images: true for the built-in loop, what the ACP agent advertised once it ran, null before that. */
  accepts_images?: boolean | null;
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

/** Parity B12: an uploaded image (`POST …/attachments`); `id` is content-addressed (`att_` + 24 hex digits). */
export type Attachment = {
  id: string;
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  width: number;
  height: number;
  name?: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  /** Parity B12: an image the user attached; fetch its bytes with `fetchAttachment(projectId, attachment_id)`. */
  | { type: "image"; attachment_id: string; media_type: string; width: number; height: number; name?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

export type Message = {
  id: number;
  agent_id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  created_at: string;
  /** The turn was stopped while this reply was being written (its text is cut). */
  stopped?: boolean;
  /** B11: on a user message that ran an ACP agent's slash command, the command's name (without the slash). */
  command?: string;
};

/** A transcript marker: the history up to and including message `upto_message_id` was replaced by a summary at `at`. */
export type CompactionMarker = {
  upto_message_id: number;
  at: string;
  /** Estimated size of the summary (characters / 4); absent from older harnesses. */
  summary_tokens?: number;
  /** Parity B7: the marker's text ("history compacted"). */
  label?: string;
  /** The user asked for it (`compactNow`); `message_count` is how many messages the summary replaced (manual only). */
  manual?: boolean;
  message_count?: number;
};

/**
 * B11: a transcript marker for `/clear`: a new session starts after message `upto_message_id` (the messages before it stay
 * in the transcript, search and export). Show the transcript from the last marker on, under `label`
 * ("New session · earlier: <title>"). `summary` is what the new session starts from; `summary_source` says who wrote its
 * summary: the fast-tier `model` (built-in loop), the ACP `agent`, or the harness from what is `stored`.
 */
export type ConversationMarker = {
  conversation_id: string;
  upto_message_id: number;
  at: string;
  label: string;
  title: string;
  summary: string;
  summary_source: SummarySource;
};
export type SummarySource = "model" | "agent" | "stored";

/** What `GET .../agents/{aid}/messages` returns: the raw messages plus the compaction and new-session markers. */
export type Transcript = { messages: Message[]; compactions: CompactionMarker[]; conversations?: ConversationMarker[] };

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
  /** Parity B7 (all absent on a harness that predates it). `harness`: measured from the request the built-in loop builds; `agent`: an ACP agent's own report, no categories. */
  source?: "harness" | "agent";
  /** The size `free_tokens` is computed from: the configured window, else the 200,000 default tool-result clearing assumes; null when unknown (an ACP agent that reported none). */
  window?: number | null;
  window_source?: "configured" | "default" | "agent" | "unknown";
  /** Room kept for the answer (built-in loop only). */
  reserved_tokens?: number;
  /** `window - used_tokens - reserved_tokens`, never below 0; null without a window. */
  free_tokens?: number | null;
  /** When the history was last compacted (absent: never). */
  compacted_at?: string;
  /** The same request split for the context button; the tokens sum to `used_tokens`. Empty for `source: "agent"`. */
  categories?: ContextCategory[];
  /** The newest orchestrator request's usage as the model reported it (null before any). */
  last_request?: ContextLastRequest | null;
  /** Parity B12: images in the messages of the next request and their estimated tokens (inside the messages part). */
  images?: number;
  image_tokens?: number;
  /** Decision 88 (all absent on a harness that predates it): rows that could be in the window and are not (memory files; `loaded: false`, `tokens` = what loading would add). */
  not_loaded?: ContextItem[];
  /** Decision 88: the compaction buffer in tokens; 0 when the harness knows none (the router decides when to compact), then show no row. */
  buffer_tokens?: number;
  /** Decision 88: the five largest messages of the conversation (raw estimates of the whole message, overlapping `messages` and `tool_results`; not part of any sum). Largest first. */
  largest_messages?: ContextLargeMessage[];
};

/** One slice of the context window (`GET …/context`, decision 65; parity B7 ids listed in {@link ContextCategoryId}, others possible). */
export type ContextCategoryId =
  | "system"
  | "instructions"
  | "tools"
  | "mcp_tools"
  | "notes"
  | "memory"
  | "agents"
  | "messages"
  | "tool_results"
  | "summary"
  | "current_request"
  /** ACP orchestrators only: what is inside the agent's own window, not itemised. */
  | "agent";
export type ContextCategory = {
  id: ContextCategoryId | (string & {});
  label: string;
  tokens: number;
  /** Decision 88: the rows inside the category, largest first; their tokens add up to `tokens`. Absent on a harness that predates it. */
  items?: ContextItem[];
  /** Decision 88: what the whole category may offer ("compact" on `messages`). */
  actions?: string[];
};
/** Decision 88: one row inside a category (a tool, a file, a block of memory, a kind of message). Tokens are always estimates (`estimated` true). */
export type ContextItem = {
  id: string;
  label: string;
  tokens: number;
  /** Heading to nest the row under: "Harness tools", a tool server's name, a folder label, "Memory", "Memory files". */
  group?: string;
  /** The file the row is (instruction files `<folder label>:<path>`, memory files `/memories/...`). */
  path?: string;
  /** The tool server of an MCP tool (an ACP orchestrator sees the harness's tools as server `octo-harness`). */
  server?: string;
  loaded: boolean;
  /** `"open"` for files. */
  actions?: string[];
  estimated: boolean;
};
/** Decision 88: one of the largest messages; `preview` is at most 80 characters on one line. */
export type ContextLargeMessage = { message_id: number; role: "user" | "assistant"; tokens: number; preview: string };
/** `input` is everything the request read (uncached + cache reads + cache writes), `cached` the cache-read part. */
export type ContextLastRequest = { input: number; cached: number; output: number };

/**
 * Decision 65: the context window as the indicator's popover shows it. `source: "agent"`: the agent manages its own
 * context (only `window` / `used` when it reports them, no categories). Numbers are estimates unless `estimated` is false.
 */
export type ContextOverview = {
  window: number | null;
  used: number;
  free?: number;
  /** Tokens the model keeps for its answer, when it reserves them. */
  reserved?: number;
  /** RFC 3339 of the last compaction; `compacted_turns_ago` says how many turns back when the harness knows. */
  compacted_at?: string;
  compacted_turns_ago?: number;
  source: "harness" | "agent";
  estimated?: boolean;
  categories: ContextCategory[];
  /** Tokens of the latest request: what was read, how much of it from the cache, what came out. */
  last_request?: ContextLastRequest;
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

/**
 * A project note (M5): a Markdown document with front matter. A list (`listNotes`, `note.changed`) carries the
 * front-matter fields and no body; `getNote` returns the body as `content` and the Markdown source as `markdown`.
 * Agents see an index of `title — description` only and open a note when its description says it is relevant.
 */
export type Note = {
  id: string;
  title: string;
  /** One line, at most 200 characters: what agents see of the note until they open it. */
  description: string;
  /** The description was taken from the first line of the body (nobody wrote one). */
  description_auto: boolean;
  tags: string[];
  /** Included whole in every request (at most 3 notes and 2 000 characters together). */
  pinned: boolean;
  /** The body (Markdown). Only in a `getNote` result and in a create/update response; lists leave it out. */
  content?: string;
  /** Characters of the body. */
  size: number;
  author: "user" | "orchestrator";
  created_at: string;
  updated_at: string;
  /** When an agent last opened the note with read_note ("" if never). */
  last_read_at: string;
  read_count: number;
};

/** A note with its body and its Markdown source (front matter and body): the `getNote`, create and update result. */
export type NoteDocument = Note & { content: string; markdown: string };

/** Fields of a new note; `markdown` (front matter and body) replaces them, `title` then only names a source without front matter. */
export type NoteInput = {
  title?: string;
  description?: string;
  tags?: string[];
  pinned?: boolean;
  content?: string;
  markdown?: string;
};

/** Fields of a note to change; `markdown` replaces all of them. An empty `description` asks for the one derived from the body. */
export type NotePatch = NoteInput;

/** The limits the harness enforces on notes (docs/memory.md, M5). */
export const NOTE_LIMITS = { description: 200, pinned: 3, pinnedChars: 2000, indexTokens: 1500 } as const;

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
  /** What the user can do about `error`, sent apart from it (older harnesses put it inside the text). */
  hint?: string;
};

export type AgentCompactedEvent = {
  type: "agent.compacted";
  seq: number;
  agent_id: string;
  upto_message_id: number;
  summary_tokens?: number;
  at: string;
  /** Parity B7. */
  manual?: boolean;
  message_count?: number;
};

/** Parity B3/B5/B6/B7 events. */
export type PlanCreatedEvent = { type: "plan.created"; seq: number; plan: Plan };
export type PlanApprovedEvent = { type: "plan.approved"; seq: number; plan: Plan };
export type ConversationRewoundEvent = { type: "conversation.rewound"; seq: number; message_id: number; request_text: string };
/** A queued message was injected into the running turn at a tool boundary. */
export type MessageSteeredEvent = { type: "message.steered"; seq: number; queue_id: string; text: string };
/** B11: the ACP agent's slash commands (or their pending state) changed: refetch `getSlashCommands`. */
export type SlashCommandsUpdatedEvent = { type: "slash_commands.updated"; seq: number; project_id: string };
/** B11: `/clear` started a new session; the fields are those of `ClearResult`. */
export type ConversationClearedEvent = {
  type: "conversation.cleared";
  seq: number;
  project_id: string;
  conversation_id: string;
  upto_message_id: number;
  at: string;
  title: string;
  summary: string;
  summary_source: SummarySource;
  /** Memory M4: the memory session the next request joins and the one that ended (absent when none). */
  session_id?: string;
  previous_session_id?: string;
};
/** An agent (or the user) kept an item: show "Remembered: ..." with an undo (`forgetFact(project, task_id, fact.id)`). */
export type FactRememberedEvent = { type: "fact.remembered"; seq: number; task_id: string; fact: TaskFact; turn_id: number; agent_id: string };
export type FactForgottenEvent = { type: "fact.forgotten"; seq: number; task_id: string; fact_id: string };
/** The context report changed (a turn, a compaction, a rewind, a note or an instruction file): refetch `getContext`. */
export type ContextUpdatedEvent = { type: "context.updated"; seq: number; project_id: string };

/** Streamed text of a side answer (only when the harness streams); the final text is in side.done. */
export type SideDeltaEvent = { type: "side.delta"; seq: number; side_id: string; text: string };
export type SideDoneEvent = { type: "side.done"; seq: number; side_id: string; message: SideMessage };
/** The question failed or was cancelled (`error` is "cancelled" when the conversation was cleared); its stored question is gone. */
export type SideErrorEvent = {
  type: "side.error";
  seq: number;
  side_id: string;
  error: string;
  /** Parity B13: `no_provider` when nothing could answer; `hint` is what to do (an agent that is not logged in). */
  code?: string;
  hint?: string;
};
/** Parity B13: the live activity of a side answer, like thinking.delta, agent.activity and tool.* of a turn. */
export type SideThinkingEvent = { type: "side.thinking"; seq: number; side_id: string; text: string };
export type SideActivityEvent = { type: "side.activity"; seq: number; side_id: string; kind: string; label: string; tool_use_id?: string };
export type SideToolEvent = { type: "side.tool"; seq: number; side_id: string; tool_use_id: string; title?: string; kind?: string; status?: string };

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
export type MemoryUpdatedEvent = {
  type: "memory.updated";
  seq: number;
  /** A memory file (files events only). */
  path?: string;
  deleted?: boolean;
  renamed_from?: string;
  /** M4: an exchange was recorded or forgotten in this session. */
  session_id?: string;
  exchange_id?: string;
  /** M4: the session ended (`clear`, `rewind`). */
  session_boundary?: string;
};

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
  | PlanCreatedEvent
  | PlanApprovedEvent
  | ConversationRewoundEvent
  | MessageSteeredEvent
  | ContextUpdatedEvent
  | SlashCommandsUpdatedEvent
  | ConversationClearedEvent
  | FactRememberedEvent
  | FactForgottenEvent
  | SideDeltaEvent
  | SideDoneEvent
  | SideErrorEvent
  | SideThinkingEvent
  | SideActivityEvent
  | SideToolEvent
  | SettingsChangedEvent
  | ChangeRecordedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalRuleCreatedEvent
  | ApprovalRuleDeletedEvent
  | InputRequestedEvent
  | InputResolvedEvent
  | QueueUpdatedEvent
  | ProjectAttentionEvent
  | SecretsChangedEvent
  | ProvidersUpdatedEvent
  | TaskUpdatedEvent
  | MemoryUpdatedEvent
  | ReviewUpdatedEvent
  | ReviewListUpdatedEvent
  | ReviewWorkspaceEvent
  | CommandStartedEvent
  | CommandOutputEvent
  | CommandFinishedEvent;

export type BridgeEventType = BridgeEvent["type"];

/** `api`: the built-in Messages loop; `router`: a detected Octo router; `agent`: an ACP agent of a plugin. */
export type ProviderKind = "api" | "router" | "agent";
/** `error` is reserved for a provider that is set up but failing; the harness does not report it yet. */
/** `not_supported`: the agent's CLI cannot work with Octo (manifest `unsupported`); `reason` says why, there is nothing to connect. */
export type ProviderState = "ready" | "not_connected" | "not_logged_in" | "not_installed" | "not_supported" | "error";
/**
 * Where a model came from: `catalogue` (the built-in loop's tiers), `manifest` (the plugin lists it), `advertised`
 * (the agent said so in a session), `command` (the manifest's models command printed it), `custom` (a name the user
 * typed for the agent).
 */
export type ProviderModelSource = "catalogue" | "manifest" | "advertised" | "command" | "custom";

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
  /** Agents: when the harness last looked for the agent's models (RFC 3339), found or not. */
  models_refreshed_at?: string;
  /** Agents: why the last look failed (short text); absent when it worked. Not an error of the provider. */
  models_error?: string;
  /** Agents: the manifest's remark on its model list (where it comes from, how far to trust it). */
  models_note?: string;
  /** Agents: any model name may be chosen, listed or not (`acp:<id>/<anything>`). */
  accepts_custom_model?: boolean;
  /**
   * Agents: `ok` the login probe succeeded; `not_logged_in` it positively said so (state `not_logged_in`);
   * `unchecked` there is no probe, or it failed to run, timed out or printed something unexpected (state `ready`:
   * the agent can be chosen).
   */
  login?: "ok" | "not_logged_in" | "unchecked";
  /** Agents: the model used when `acp:<id>` names none ("" or absent: the agent's own default). */
  preferred_model?: string;
  /** Agents: the launch command is not verified (the plugin says so); the UI shows a dim "Experimental" after the name. */
  experimental?: boolean;
  /** Agents: the model per delegation tier ("" = the agent's default); prefilled from the manifest's hints. */
  roles?: ProviderRoles;
  /** Agents: with `experimental`, what is known: the launch command comes from the agent's documentation and has not been run with Octo. */
  experimental_note?: string;
};

/** The model an agent uses for a delegation decided fast / balanced / deep; "" means the agent's own default. */
export type ProviderRoles = { fast: string; balanced: string; deep: string };

/** `PUT /v1/providers/{id}/prefs`: every field optional; roles are merged key by key, "" resets one to the default. */
export type ProviderPrefs = { preferred_model?: string; roles?: Partial<ProviderRoles> };

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
  /** `POST /v1/fs/pick-folder` can open the operating system's folder chooser on this machine (show "Browse..."). */
  pick_folder?: boolean;
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
  acpTrace: "HARNESS_ACP_TRACE",
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

export type QueuedMessage = {
  id: string;
  text: string;
  created_at: string;
  /** Parity B3: the mode chosen for this message. */
  mode?: ProjectMode;
  /** Parity B12: ids of the attached images. */
  attachments?: string[];
};

// --- parity B3, B5, B6, B7 -------------------------------------------------------------------------------------

/** The result of a plan-mode turn. */
export type Plan = { id: string; turn_id: number; text: string; status: "pending" | "approved"; created_at: string; approved_at: string | null };

export type RewindFile = { folder: string; path: string; action: "restore" | "delete"; change_ids: number[] };
/** `modified_outside`: changed outside the harness since its last recorded change; `unavailable`: the earlier or later content was not kept. */
export type RewindConflict = { folder: string; path: string; reason: "modified_outside" | "unavailable" | "folder_missing" };
/** What `rewind` did, or with `dry_run` would do. A real rewind with conflicts is `409 rewind_conflict` whose `error.details` is this report. */
export type RewindReport = {
  dry_run: boolean;
  message_id: number;
  /** The request's text, to put back in the composer. */
  request_text: string;
  files: RewindFile[];
  conflicts: RewindConflict[];
  messages_cut: number;
  agents_cut: number;
  /** An ACP orchestrator's session cannot be rewound in place: the next turn starts a new session with a recap. */
  acp_session_reset: boolean;
};

export type CompactResult = { upto_message_id: number; at: string; summary_tokens: number; message_count: number; manual: true };
/** B11: what `compactNow` answers (202) for an ACP orchestrator whose agent advertises `compact`: `/compact` was sent to it as a turn. */
export type CompactSentToAgent = { sent_to_agent: true; message: Message };

/** B11: an Octo slash command (run by the host or by calling `endpoint`, never sent as text). */
export type OctoSlashCommand = {
  name: string;
  description: string;
  /** Argument hint, e.g. `ask|plan|agent`. */
  args?: string;
  available: boolean;
  /** Why it is unavailable (show it on the disabled row). */
  reason?: string;
  /** What to call, e.g. `POST /v1/projects/{id}/clear`. */
  endpoint: string;
};
/** B11: a command an ACP agent advertises (`available_commands_update`); choosing one sends `/<name> <args>` as the message. */
export type AgentSlashCommand = { name: string; description: string; input_hint?: string };
/** B11: `GET /v1/projects/{id}/slash-commands`. `agent` is null for the built-in loop; `pending` while the agent has not advertised a list yet. */
export type SlashCommands = {
  octo: OctoSlashCommand[];
  agent: { id: string; label: string; commands: AgentSlashCommand[]; pending?: boolean } | null;
};
/** B11: `POST /v1/projects/{id}/clear`. */
export type ClearResult = {
  conversation_id: string;
  upto_message_id: number;
  at: string;
  /** The session that ended. */
  title: string;
  summary: string;
  summary_source: SummarySource;
  /** Memory M4: the memory session the next request joins (empty until its first request) and the one that ended; `getMemorySession(previous_session_id).session.summary` is this summary. */
  session_id?: string;
  previous_session_id?: string;
};
/** B11: `POST /v1/projects/{id}/facts` (the user's `/remember`) and what `fact.remembered` carries. */
export type RememberedFact = { task_id: string; fact: TaskFact };
export type RememberKind = "fact" | "decision" | "preference" | "todo";

/** A past request found by `searchRequests`. */
export type RequestHit = { project_id: string; project_name: string; message_id: number; snippet: string; date: string };
export type QueueState = { paused: boolean; messages: QueuedMessage[] };
/** What POST .../messages answers: the started turn's message, or (a turn is running) the queued one. */
export type SendResult = { message: Message; queued?: undefined } | { queued: QueuedMessage; message?: undefined };

// --- v7: approvals --------------------------------------------------------------------------------------------

/** The wire also carries "network" (a web_fetch in a supervised project); it is not in this union yet so the UI exhaustive switches keep compiling until it handles the card. */
export type ApprovalKind = "write" | "command" | "acp" | "network";
export type ApprovalDecision = "allow" | "allow_for_turn" | "allow_always" | "deny";
/** A rule an `allow_always` answer saves: `match` is a command prefix (the whole command when `exact`), a path glob or a host glob. */
export type ApprovalRuleSpec = { tool: string; match: string; exact: boolean };
/** A saved "always allow" rule of a project. */
export type ApprovalRule = ApprovalRuleSpec & { id: string; created_at: string };
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
    /** The change as a unified diff (write_file and edit; cut at 20 kB). */
    patch?: string;
    /** What a web_fetch would fetch (kind `network`). */
    url?: string;
  };
  created_at: string;
  /** The tool behind the request: bash, write_file, edit, web_fetch or `acp:<kind>`. */
  tool?: string;
  /** The rule `allow_always` saves by default; absent when no rule can be saved (a compound shell command, ...). */
  suggested_rule?: ApprovalRuleSpec;
};
/** `match` (with `allow_always`) overrides the suggested rule; it must cover the request (400 `invalid_request` otherwise; 422 `no_rule` when none can be saved). */
export type ApprovalAnswer = { decision: ApprovalDecision; option_id?: string; note?: string; match?: string };
/** A rule was saved by an `allow_always` answer / deleted. */
export type ApprovalRuleCreatedEvent = { type: "approval_rule.created"; seq: number; rule: ApprovalRule };
export type ApprovalRuleDeletedEvent = { type: "approval_rule.deleted"; seq: number; id: string };

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

/** Older name of `ProvidersResponse`, kept for the UI's imports. */
export type ProviderList = ProvidersResponse;

// --- M1: orchestrator memory ----------------------------------------------------------------------------------

export type TaskStatus = "open" | "done" | "dropped";
/** Wording of the user kept exactly, with the message it came from. */
export type TaskQuote = { text: string; message_id: number };
/** A short standalone statement with its date; `superseded_by` names the newer fact (of the same task) that replaced it. */
export type TaskFact = {
  id: string;
  text: string;
  date: string;
  message_id: number;
  superseded_by?: string;
  /** Set on items stored by `remember`: its kind, subject, and who kept it (an agent id, or "user"). */
  kind?: RememberKind;
  about?: string;
  remembered_by?: string;
};
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
export type MemorySearchKind = "tasks" | "facts" | "files" | "messages" | "exchanges";
export type MemoryHit = {
  kind: "task" | "fact" | "file" | "message" | "exchange";
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
  /** M4: on an `exchange` hit, the session it belongs to (`id` is the exchange id). */
  session_id?: string;
};
/** Up to 10 hits; with none, `message` is "nothing in memory matches". */
export type MemorySearchResult = { hits: MemoryHit[]; message?: string };
export type MemorySearchParams = { q: string; in?: MemorySearchKind[]; after?: string; before?: string; limit?: number };

// --- M4: sessions ---------------------------------------------------------------------------------------------
/** A run of exchanges in one conversation. `reason` says why it ended (`clear`, `rewind`); absent while open or when it just went quiet. */
export type MemorySession = {
  id: string;
  title: string;
  started_at: string;
  ended_at: string;
  /** Exchanges that were not forgotten. */
  exchanges: number;
  open: boolean;
  reason?: string;
  /** The summary a `/clear` wrote when it ended this session (`summary_source`: who wrote it); absent for a session that ended otherwise. */
  summary?: string;
  summary_source?: SummarySource;
};
export type ExchangeStatus = "completed" | "failed" | "stopped";
/** One request and its answer. A forgotten one stays as a marker: `removed: true`, empty texts. */
export type MemoryExchange = {
  id: string;
  session_id?: string;
  /** The user message that started the turn (what "Open in conversation" goes to). */
  turn_id: number;
  /** The assistant message that answered; 0 when none did. */
  message_id: number;
  request: string;
  /** Markdown, the last assistant text of the turn, at most 64 KiB (then `answer_truncated`). */
  answer: string;
  answer_truncated: boolean;
  status: ExchangeStatus;
  started_at: string;
  duration_ms: number;
  model: string;
  files: string[];
  agents: string[];
  tokens: { input: number; output: number };
  /** null when no cost was reported (subscription agents). */
  cost_usd: number | null;
  task_id?: string;
  removed?: boolean;
};
export type MemorySessionDetail = { session: MemorySession; exchanges: MemoryExchange[] };
export type MemorySessionsParams = { limit?: number; before?: string };

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

/**
 * `POST /v1/fs/pick-folder`: `path` is the folder the user chose (absolute, an existing directory); `cancelled` the
 * user closed the dialog; `error: "unavailable"` there is no chooser here (headless, tool missing), `"failed"` it
 * crashed or timed out, `"invalid"` it returned something that is not a folder. `message` explains an error.
 */
export type PickFolderResult = {
  path?: string;
  cancelled?: boolean;
  error?: "unavailable" | "failed" | "invalid";
  message?: string;
};

/** `GET /v1/fs/dirs`: child directories (never files) of `base` that match the typed prefix, at most 50. */
export type DirListing = {
  /** The directory that was listed (absolute). */
  base: string;
  entries: FolderEntry[];
  /** Present, with empty `entries`, when the base is missing or cannot be read. */
  error?: "not_found" | "not_readable";
};
