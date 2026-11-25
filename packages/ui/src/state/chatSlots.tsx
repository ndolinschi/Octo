import type { ReactNode } from "react";
import { createRequiredContext } from "../lib/context";

/**
 * What the shell puts into the conversation and the composer without the chat feature importing it (features may not
 * import each other): the approval cards and forms at the end of the orchestrator's transcript, the harness's queue
 * above the composer's text and its count on the send button. Absent slots render nothing.
 */
export type ChatSlots = {
  approvals?(props: { onOpenAgent(agentId: string): void }): ReactNode;
  queue?(props: { onCount(count: number): void }): ReactNode;
  badge?(count: number): ReactNode;
};

export const { Provider: ChatSlotsProvider, useOptional: useChatSlots } = createRequiredContext<ChatSlots>("useChatSlots");
