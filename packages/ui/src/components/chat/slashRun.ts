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
        await bridge.clearConversation(projectId);
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
        else push?.({ kind: "info", text: "There is nothing to rewind to yet." });
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
        d.openTool("memory");
        return true;
      case "settings":
        d.openSettings();
        return true;
      case "remember": {
        if (!bridge.rememberFact) return false;
        if (!args) push?.({ kind: "info", text: "Write what to keep after the command: /remember we deploy from the release branch." });
        else await bridge.rememberFact(projectId, { text: args });
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
