import type { Bridge, CommandRun, CommandSuggestion, StartedCommandRun } from "@octo/agent-client";

/** The command methods of a bridge bound to one project, all present (the bridge's are optional: HTTP bridge and demo only). */
export type CommandsApi = {
  suggestions(): Promise<CommandSuggestion[]>;
  run(name: string, reviewId?: string): Promise<StartedCommandRun>;
  list(reviewId?: string): Promise<CommandRun[]>;
  get(runId: string): Promise<CommandRun>;
  stop(runId: string): Promise<CommandRun>;
};

export function commandsApi(b: Bridge, p: string): CommandsApi | null {
  if (!b.listCommandSuggestions || !b.runCommand || !b.listCommandRuns || !b.getCommandRun || !b.stopCommandRun) return null;
  const suggestions = b.listCommandSuggestions.bind(b);
  const run = b.runCommand.bind(b);
  const list = b.listCommandRuns.bind(b);
  const get = b.getCommandRun.bind(b);
  const stop = b.stopCommandRun.bind(b);
  return {
    suggestions: () => suggestions(p),
    run: (name, reviewId) => run(p, name, reviewId ? { reviewId } : undefined),
    list: (reviewId) => list(p, reviewId ? { reviewId } : undefined),
    get: (id) => get(p, id),
    stop: (id) => stop(p, id),
  };
}
