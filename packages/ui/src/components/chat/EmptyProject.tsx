import type { Project } from "@octo/agent-client";
import { useApp } from "../../state/app";
import { StarterPrompts } from "./StarterPrompts";

/**
 * Decision 52: the empty project is the streak, one line, the composer (its chips are the settings) and at most three
 * starter prompts specific to this project. No summary of folders, tiers or agents — configuration lives in controls.
 */
export function EmptyTitle({ project }: { project: Project }) {
  const { config } = useApp();
  // ACP in the UI: without an API key the built-in loop cannot run; say so once, with the way forward (no dead end).
  const noKey = config?.builtin_loop?.available === false && !project.models.orchestrator.startsWith("acp:");
  return (
    <div className="relative mx-auto w-full max-w-float text-center">
      {/* Decision 28: one sentence in two tones — the lead-in muted, the statement in fg. */}
      <h1 className="relative text-display text-fg">
        <span className="octo-lead">{project.name}.</span> What should we work on?
      </h1>
      {noKey && (
        <p data-nokey className="relative mt-2 text-sm text-fg-2" title={config.builtin_loop?.reason}>
          No API key set. Choose an agent on a subscription in the model menu below, or give the harness a key.
        </p>
      )}
    </div>
  );
}

/** Under the empty project's composer: the project-specific starters only (decision 52). */
export function EmptyFacts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  return (
    <div className="relative mx-auto flex w-full max-w-float flex-col">
      <StarterPrompts project={project} onPick={onPick} />
    </div>
  );
}
