import type { Approval, ApprovalAnswer, ApprovalRuleSpec } from "@octo/agent-client";

/**
 * "Always allow" (parity B4): the rule an approval would save, said in words before it is saved. `match` is a command
 * prefix (the whole command when `exact`), a path glob for edits, a host glob for web fetches.
 */

export type RuleView = { subject: string; code: string; sentence: string };

/** The rule's kind, its code (shown in mono) and the sentence that says what it covers. */
export function describeRule(rule: ApprovalRuleSpec): RuleView {
  const tool = rule.tool;
  if (tool === "bash" || tool.startsWith("acp:")) {
    return { subject: "Command", code: rule.match, sentence: rule.exact ? "this exact command" : "this command and anything that starts with it" };
  }
  if (tool === "web_fetch") return { subject: "Host", code: rule.match, sentence: "fetching from this host" };
  if (tool === "write_file" || tool === "edit") return { subject: "Path", code: rule.match, sentence: "edits to this path" };
  return { subject: "Request", code: rule.match, sentence: rule.exact ? "this exact request" : "requests that start with this" };
}

/** The button's label names the kind; the rule itself is shown once the button is pressed. */
export function alwaysLabel(rule: ApprovalRuleSpec): string {
  if (rule.tool === "web_fetch") return "Always allow this host";
  if (rule.tool === "write_file" || rule.tool === "edit") return "Always allow this path";
  return "Always allow this command";
}

export function canAlwaysAllow(a: Pick<Approval, "suggested_rule">): boolean {
  return a.suggested_rule !== undefined && a.suggested_rule.match.trim() !== "";
}

/** The answer that saves the suggested rule (no `match`: the harness uses its own suggestion). */
export function alwaysAnswer(): ApprovalAnswer {
  return { decision: "allow_always" };
}

/** One list row in settings, as text. */
export function ruleLine(rule: ApprovalRuleSpec): string {
  const v = describeRule(rule);
  return `${v.subject}: ${rule.match} (${v.sentence})`;
}

/** Why saving the rule failed, with a next step (422 `no_rule`, 400 `invalid_request`). */
export function ruleError(code: string | null): string | null {
  if (code === "no_rule") return "No rule can be saved for this request. Allow it once instead.";
  if (code === "invalid_request") return "Octo's local service did not accept that rule. Allow it once instead.";
  return null;
}
