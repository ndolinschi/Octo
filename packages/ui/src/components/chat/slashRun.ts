import type { Bridge, ProjectMode } from "@octo/agent-client";
import { compactedLine } from "../../lib/compactNow";
import { saveConversation } from "../../lib/download";
import { errorCode, errorMessage, structuredError } from "../../lib/format";
import { MODES } from "../../lib/modes";
import type { ComposerMode } from "./composerMode";
import type { NoteInput } from "./notesContext";

/** What a slash command needs from the host; the runner is its own chunk, loaded when the first command runs. */
export type SlashDeps = {
  bridge: Bridge;
  projectId: string;
  mode: ComposerMode | null | undefined;
  openModel(query: string): void;
  openTool(tool: "review" | "memory"): void;
  openSettings(): void;
  push: ((note: NoteInput) => void) | undefined;
  rewindLast: (() => void) | undefined;
  /** Parallel sessions: `/clear` made session `next` (the bridge is addressed to the session it cleared). */
  onCleared?: ((next: string) => void) | undefined;
  /** True when the project's auto-memory mode is blocked. */
  memoryBlocked?: boolean | undefined;
};

/** Runs an Octo slash command: false when the name is not one it knows (the text is then sent as typed). */
export async function runSlash(d: SlashDeps, name: string, args: string): Promise<boolean> {
  const { bridge, projectId, mode, openModel, push, rewindLast } = d;
  const fail = (e: unknown) => push?.({ kind: "error", raw: errorMessage(e), code: errorCode(e), fields: structuredError(e) });
  try {
    switch (name) {
      case "compact": {
        if (!bridge.compactNow) return false;
        push?.({ kind: "info", text: compactedLine(await bridge.compactNow(projectId)) });
        return true;
      }
      case "clear":
        if (!bridge.clearConversation) return false;
        {
          const cleared = await bridge.clearConversation(projectId);
          if (cleared.session_id && cleared.previous_session_id && cleared.session_id !== cleared.previous_session_id) d.onCleared?.(cleared.session_id);
        }
        return true;
      case "mode": {
        const wanted = MODES.find((m: ProjectMode) => m === args.toLowerCase());
        if (!mode) return false;
        if (!wanted) push?.({ kind: "info", text: "Use /mode ask, /mode plan or /mode agent." });
        else mode.choose(wanted);
        return true;
      }
      case "model":
        openModel(args);
        return true;
      case "rewind":
        if (rewindLast) rewindLast();
        else push?.({ kind: "info", text: "There is nothing to restore to yet." });
        return true;
      case "export": {
        if (!(await saveConversation(bridge, projectId))) return false;
        push?.({ kind: "info", text: "Downloading the conversation as Markdown." });
        return true;
      }
      case "review":
        d.openTool("review");
        return true;
      case "context":
        push?.({ kind: "context" });
        return true;
      case "memory":
        if (d.memoryBlocked) push?.({ kind: "info", text: "Memory is disabled for this project. Enable it in Settings -> Memory." });
        else d.openTool("memory");
        return true;
      case "settings":
        d.openSettings();
        return true;
      case "remember": {
        if (!bridge.rememberFact) return false;
        if (!args) push?.({ kind: "info", text: "Write what to keep after the command: /remember we deploy from the release branch." });
        else {
          // The note comes from the answer, not only from `fact.remembered`: a bridge may store the fact without the event
          // (the desktop demo's memory layer does, B10). The provider keeps one note per fact when the event comes too.
          const { task_id, fact } = await bridge.rememberFact(projectId, { text: args });
          push?.({ kind: "remembered", taskId: task_id, factId: fact.id, text: fact.text, undone: false });
        }
        return true;
      }
      case "help":
        push?.({ kind: "help" });
        return true;
      default:
        return false;
    }
  } catch (e) {
    fail(e);
    return true;
  }
}
