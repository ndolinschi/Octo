import type { Agent, Project } from "@octo/agent-client";
import { startFailureOf } from "../../lib/startFailure";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { canRun, chipLabel, useProviders } from "../../lib/providers";

/**
 * The empty project shows the streak, one title line, any actionable blocking notices, and the composer.
 */
export function EmptyTitle({ project, agent }: { project: Project; agent: Agent }) {
  const { config, bridge } = useApp();
  const { state } = useProject();
  const providers = useProviders(bridge);
  // ACP in the UI: without an API key the built-in loop cannot run; say so once, with the way forward (no dead end).
  const noKey = config?.builtin_loop?.available === false && !project.models.orchestrator.startsWith("acp:");
  // B2: the reasons the first message cannot go yet, said in a sentence (the chips below only show amber).
  const model = project.models.orchestrator;
  const list = providers.status === "ready" ? providers.list : null;
  // The start failure under the title (`StartFailure`, "GitHub Copilot is not logged in") already says why: not twice.
  const failing = startFailureOf(state.lastTurn, agent) !== undefined;
  const stuck =
    list && model && !noKey && !failing && !canRun(list, model)
      ? `${chipLabel(model, list)} can't run yet: its provider is not connected. Pick another model below, or connect one in Settings.`
      : null;
  const noFolder = project.folders.length === 0 ? "No folder is chosen, so agents have nothing to work in. Choose one with the folder button below." : null;
  return (
    // Balance pass: on the composer's text edge, like Home's one left edge (F5): no centred heading over the left-aligned composer.
    // The edge is the shell's 2px (`p-0.5`) and the text's 12px (`px-3`), so heading, notices and prompt start on one line.
    <div className="relative mx-auto w-full max-w-float px-0.5 [&>*]:px-3">
      {/* Decision 28: one sentence in two tones — the lead-in muted, the statement in fg. */}
      {/* P2-10: a long name without spaces wraps anywhere and the sentence stops at two lines; the tooltip has it all. */}
      <h1 className="relative line-clamp-2 text-display wrap-anywhere text-fg" title={`${project.name}. What should we work on?`}>
        <span className="octo-lead">{project.name}.</span> What should we work on?
      </h1>
      {(stuck ?? noFolder) && (
        <p data-notice className="relative mt-2 text-sm text-fg-2">
          {[stuck, noFolder].filter(Boolean).join(" ")}
        </p>
      )}
      {noKey && (
        <p data-nokey className="relative mt-2 text-sm text-fg-2" title={config.builtin_loop?.reason}>
          No API key yet. Pick a coding agent in the model menu below, or add a key in Settings.
        </p>
      )}
    </div>
  );
}
