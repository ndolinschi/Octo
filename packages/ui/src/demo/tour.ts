import type { Message } from "@octo/agent-client";
import type { ProjectRecord } from "./store";

const TOUR_REPLY = `## QA tour

Smoke the API from the project root:

\`\`\`bash
pnpm test -- --reporter=dot
\`\`\`

The dev server should already appear under **Processes** as **running**.`;

/** `?tour=1` with demo: a short assistant turn with a runnable shell block; processes stay seeded via the commands bridge. */
export function seedTourState(records: Map<string, ProjectRecord>): void {
  const atlas = [...records.values()].find((r) => r.project.name.startsWith("Atlas"));
  if (!atlas) return;
  const orch = atlas.project.orchestrator_agent_id;
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const user: Message = {
    id: atlas.nextMessageId++,
    agent_id: orch,
    role: "user",
    content: [{ type: "text", text: "tour state" }],
    created_at: at,
  };
  const assistant: Message = {
    id: atlas.nextMessageId++,
    agent_id: orch,
    role: "assistant",
    content: [{ type: "text", text: TOUR_REPLY }],
    created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  };
  atlas.messages.push(user, assistant);
}