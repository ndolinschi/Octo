import { runsReducer } from "../../lib/commands/runs";
import { errorMessage } from "../../lib/format";
import type { CommandsApi } from "../../lib/commands/api";
import type { RunsStore } from "../../state/projectRuns";

/** Starts the project command `name` in the project folder and puts the run in the store; the new run's id, or the sentence of what went wrong. */
export async function startProjectRun(api: CommandsApi, store: RunsStore, name: string): Promise<{ runId: string } | { problem: string }> {
  try {
    const r = await api.run(name);
    store.update((s) => runsReducer(s, { type: "event", event: { type: "command.started", seq: 0, run: r.run } }));
    return { runId: r.run.id };
  } catch (e) {
    return { problem: `${name} did not start: ${errorMessage(e).replace(/\.$/, "")}. Check the command in Settings, then run it again.` };
  }
}
