import type { UsageBucket } from "@octo/agent-client";
import { formatTokens } from "../format";
import { bucketTokens } from "../usage";

/**
 * Decision 86 d: the status bar budget item's tooltip lines, the project's top models by tokens
 * ("opus · 1.2M tokens"). `name` turns a model id into the name shown elsewhere; a bucket without tokens is skipped.
 */
export function topModelLines(buckets: readonly UsageBucket[], name: (id: string) => string = (id) => id, count = 3): string[] {
  return buckets
    .map((b) => ({ label: name(b.label || b.key), tokens: bucketTokens(b) }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label))
    .slice(0, count)
    .map((r) => `${r.label} · ${formatTokens(r.tokens)} tokens`);
}
