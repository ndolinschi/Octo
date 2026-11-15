import { BridgeError, type Bridge, type SlashCommands, type TaskFact } from "@octo/agent-client";
import { emit, newId, type ProjectRecord } from "./store";

/**
 * B11 for the demo bridge: the Octo commands (one unavailable, with its reason), the agent's own commands, `/clear`
 * (a `conversation.cleared` event) and `/remember` / undo (`fact.remembered`, `fact.forgotten`). Images (B12): stored in
 * memory so a thumbnail can be fetched back.
 */
const OCTO: SlashCommands["octo"] = [
  { name: "compact", description: "Summarise the conversation to free context", available: true, endpoint: "POST /v1/projects/{id}/compact" },
  {
    name: "clear",
    description: "Start a new session; keeps a summary of this one, nothing is deleted",
    available: true,
    endpoint: "POST /v1/projects/{id}/clear",
  },
  { name: "mode", description: "Choose Agent, Ask or Plan for the next message", args: "ask|plan|agent", available: true, endpoint: "ui:mode" },
  { name: "model", description: "Choose the model", available: true, endpoint: "ui:model" },
  { name: "rewind", description: "Restore the session to an earlier request", available: true, endpoint: "POST /v1/projects/{id}/rewind" },
  { name: "export", description: "Download the conversation as Markdown", available: true, endpoint: "GET /v1/projects/{id}/export" },
  {
    name: "review",
    description: "Review a pull request or local changes",
    available: false,
    reason: "Connect a GitHub repository first",
    endpoint: "ui:review",
  },
  { name: "context", description: "Show what fills the context window", available: true, endpoint: "GET /v1/projects/{id}/context" },
  { name: "memory", description: "Open what the project remembers", available: true, endpoint: "ui:memory" },
  { name: "settings", description: "Open the project's settings", available: true, endpoint: "ui:settings" },
  { name: "remember", description: "Keep a note as a dated fact", args: "<text>", available: true, endpoint: "POST /v1/projects/{id}/facts" },
  { name: "help", description: "What these commands do", available: true, endpoint: "ui:help" },
];

const AGENT_COMMANDS = [
  { name: "init", description: "Create a CLAUDE.md for this project" },
  { name: "review", description: "Review the pending changes" },
  { name: "cost", description: "Show token use for this session", input_hint: "" },
];

const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) =>
  c.charCodeAt(0),
);

export function withDemoSlash(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const rec = (id: string) => {
    const r = records.get(id);
    if (!r) throw new BridgeError(404, "not_found", "project not found");
    return r;
  };
  const facts = new Map<string, TaskFact>();
  const attachments = new Map<string, { data: Uint8Array; type: string }>();
  const noImages = typeof location !== "undefined" && /[?&]images=no\b/.test(location.search);
  return {
    ...base,
    getProject: async (id) => {
      const project = await base.getProject(id);
      return { ...project, accepts_images: !noImages };
    },
    sendOrQueueMessage: async (id, text, opts) => {
      if (opts?.attachments?.length && noImages) throw new BridgeError(422, "images_unsupported", "The model does not accept images");
      const sent = await base.sendOrQueueMessage?.(id, text, opts);
      if (!sent) throw new BridgeError(501, "not_implemented", "no sendOrQueueMessage");
      const ids = opts?.attachments ?? [];
      if (ids.length && sent.message) {
        const blocks = ids.map((attId) => ({
          type: "image" as const,
          attachment_id: attId,
          media_type: "image/png",
          width: 640,
          height: 400,
          name: "image.png",
        }));
        const stored = rec(id).messages.find((m) => m.id === sent.message?.id);
        if (stored) stored.content = [...stored.content, ...blocks];
        return { message: { ...sent.message, content: [...sent.message.content, ...blocks] } };
      }
      return sent;
    },
    getSlashCommands: async (id) => {
      const r = rec(id);
      const acp = r.project.models.orchestrator.startsWith("acp:");
      return {
        octo: OCTO,
        agent: acp ? { id: "claude-code", label: "Claude Code", commands: AGENT_COMMANDS } : null,
      };
    },
    clearConversation: async (id) => {
      const r = rec(id);
      const at = new Date().toISOString();
      const upto = r.nextMessageId - 1;
      const result = {
        conversation_id: newId("conv"),
        upto_message_id: upto,
        at,
        title: "Earlier session",
        summary: "Worked on retries and webhook delivery.",
        summary_source: "stored" as const,
      };
      emit(r, { type: "conversation.cleared", project_id: id, ...result });
      return result;
    },
    rememberFact: async (id, input) => {
      const r = rec(id);
      const fact: TaskFact = {
        id: newId("fact"),
        text: input.text,
        date: new Date().toISOString(),
        message_id: r.nextMessageId - 1,
        kind: input.kind ?? "fact",
        remembered_by: "user",
      };
      facts.set(fact.id, fact);
      const task_id = "tsk_demo";
      emit(r, { type: "fact.remembered", task_id, fact, turn_id: r.nextMessageId - 1, agent_id: r.project.orchestrator_agent_id });
      return { task_id, fact };
    },
    forgetFact: async (id, taskId, factId) => {
      const r = rec(id);
      facts.delete(factId);
      emit(r, { type: "fact.forgotten", task_id: taskId, fact_id: factId });
    },
    uploadAttachment: async (_id, data, opts) => {
      const att = {
        id: newId("att"),
        media_type: "image/png" as const,
        bytes: data.byteLength,
        width: 640,
        height: 400,
        ...(opts?.name ? { name: opts.name } : {}),
      };
      attachments.set(att.id, { data, type: "image/png" });
      return att;
    },
    fetchAttachment: async (_id, attachmentId) => {
      const hit = attachments.get(attachmentId);
      const bytes = hit && hit.data.byteLength > 100 ? hit.data : PNG_1PX;
      return { data: bytes.slice().buffer, type: hit?.type ?? "image/png" };
    },
  };
}
