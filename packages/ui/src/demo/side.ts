import { BridgeError, type Bridge, type SideMessage } from "@octo/agent-client";
import { emit, type ProjectRecord } from "./store";

const delay = () => new Promise((r) => setTimeout(r, 60));

/** `?side=none|hold` on the page: the side question with nothing connected, or an answer that stays in flight (for screenshots). */
export function sideModeFromUrl(): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("side");
}

/** The side question with its live activity (parity B13); `none` refuses with the typed 409, `hold` never ends until Stop. */
export function withDemoSide(bridge: Bridge, records: Map<string, ProjectRecord>, mode: string | null): Bridge {
  // The question being held, per project: the harness stores it, so a reload of the list (the panel re-reads it) still has it.
  const held = new Map<string, SideMessage>();
  return {
    ...bridge,
    askSide: async (id, text) => {
      if (mode === "none")
        throw new BridgeError(409, "no_provider", "Nothing can answer a side question. Connect a provider in Settings, or choose a side model.");
      const rec = records.get(id);
      if (rec && mode === "hold") {
        // The answer never ends by itself: the question, the agent's reasoning and its activity, until Stop.
        await delay();
        const sideId = `side_hold_${Date.now()}`;
        const message: SideMessage = { id: Date.now(), side_id: sideId, role: "user", text, created_at: new Date().toISOString() };
        held.set(id, message);
        setTimeout(() => {
          emit(rec, { type: "side.thinking", side_id: sideId, text: "Looking at what the agents are doing." });
          emit(rec, { type: "side.activity", side_id: sideId, kind: "tool", label: "Reading src/billing/retry.ts" });
        }, 150);
        return { side_id: sideId, message };
      }
      return bridge.askSide(id, text);
    },
    listSide: async (id) => {
      const stored = await bridge.listSide(id);
      const question = held.get(id);
      return question ? [...stored, question] : stored;
    },
    stopSide: async (id) => {
      await delay();
      const rec = records.get(id);
      const question = held.get(id);
      if (rec && question) emit(rec, { type: "side.error", side_id: question.side_id, error: "cancelled" });
      held.delete(id);
    },
    clearSide: async (id) => {
      held.delete(id);
      await bridge.clearSide(id);
    },
  };
}
