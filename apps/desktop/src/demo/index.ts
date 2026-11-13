import type { Bridge } from "@octo/agent-client";
import { completionMode, withDemoCompletion } from "./completion";
import { memoryMode, withDemoMemory } from "./memory";

/**
 * The demo bridge plus inline completion and orchestrator memory (`?completion=off|budget|fail`,
 * `?memory=none|empty|fail`). Loaded with `import()` together with `@octo/ui/demo`, only for `?demo=`.
 */
export function withDemoExtras(bridge: Bridge, search: string): Bridge {
  return withDemoMemory(withDemoCompletion(bridge, completionMode(search)), memoryMode(search));
}
