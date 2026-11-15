import assert from "node:assert/strict";
import test from "node:test";
import { JARGON, readable } from "../lib/errors/plain";
import { INSIDE_WORDS } from "../lib/errors/words";
import { createDemoBridge } from "./bridge";
import { ACP_WARNING } from "./routed";

/** Words no person-facing string may carry (decision 94b). */
const FORBIDDEN = /\b(ACP|MCP|exit status|stderr|JSON-?RPC)\b/i;

test("no demo fixture a person can read carries protocol vocabulary", async () => {
  const bridge = createDemoBridge();
  const seen: string[] = [ACP_WARNING.replace(/^warning:\s*/i, "")];
  const providers = await bridge.listProviders?.();
  for (const p of providers?.providers ?? []) {
    seen.push(p.reason, p.problem?.message ?? "", p.problem?.hint ?? "", p.models_error ?? "", p.models_problem?.message ?? "", p.models_problem?.hint ?? "");
  }
  for (const project of await bridge.listProjects()) {
    for (const a of await bridge.listAgents(project.id)) seen.push(a.error ? readable(a.error) : "", a.error_hint ?? "");
  }
  for (const s of seen.filter(Boolean)) {
    assert.doesNotMatch(s, FORBIDDEN, s);
    assert.doesNotMatch(s, JARGON, s);
    // R2: and the product's inside words (harness, bridge, orchestrator, worktree), outside commands and paths.
    assert.doesNotMatch(s, INSIDE_WORDS, s);
  }
  assert.ok(seen.filter(Boolean).length > 2);
});
