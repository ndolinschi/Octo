import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval } from "@octo/agent-client";
import { ApprovalGroup, askingAgents } from "./ApprovalGroup";

const at = new Date().toISOString();
const approval = (id: string, agent: string, over: Partial<Approval> = {}): Approval => ({
  id,
  agent_id: `agent-${agent.toLowerCase()}-1f3a`,
  agent_label: agent,
  turn_id: 1,
  kind: "command",
  title: `pnpm test ${id}`,
  detail: { command: `pnpm test ${id}` },
  created_at: at,
  ...over,
});

const render = (approvals: Approval[]) =>
  renderToStaticMarkup(
    createElement(ApprovalGroup, {
      approvals,
      onResolve: () => Promise.resolve(),
      onResolved: () => undefined,
    }),
  );

const rowAgents = (html: string) => [...html.matchAll(/<span class="ml-auto shrink-0 text-xs text-fg-3">([^<]*)<\/span>/g)].map((m) => m[1]);

test("askingAgents: each label once, in the order they first asked", () => {
  assert.deepEqual(askingAgents([approval("a", "Researcher"), approval("b", "Tester"), approval("c", "Researcher")]), ["Researcher", "Tester"]);
});

test("a group is titled by its count and says who asks by label, never by the project or an id", () => {
  const html = render([approval("a", "Researcher"), approval("b", "Tester"), approval("c", "Researcher")]);
  assert.match(html, /<h3[^>]*>3 approvals<\/h3>/);
  assert.doesNotMatch(html, /approvals from/);
  assert.match(html, />Researcher, Tester</);
  assert.doesNotMatch(html, /agent-researcher-1f3a/);
});

test("rows name their agent only when more than one agent asks", () => {
  assert.deepEqual(rowAgents(render([approval("a", "Researcher"), approval("b", "Tester")])), ["Researcher", "Tester"]);
  assert.deepEqual(rowAgents(render([approval("a", "Researcher"), approval("b", "Researcher")])), []);
});

test("a row's caption line is its Details disclosure, and the actions run allow, scope, always, deny", () => {
  const html = render([approval("a", "Researcher", { suggested_rule: { tool: "bash", match: "pnpm test *", exact: false } }), approval("b", "Researcher")]);
  const row = html.slice(html.indexOf('data-v7-approval="a"'), html.indexOf('data-v7-approval="b"'));
  const disclosure = /<button[^>]*data-approval-details=""[^>]*>/.exec(row)?.[0] ?? "";
  assert.match(disclosure, /aria-expanded="false"/);
  assert.ok(row.indexOf("data-approval-details") < row.indexOf("Allow once"));
  assert.doesNotMatch(row, />Details<|Hide details</);
  const order = ["Allow once", "for this request", "Always allow", "Deny"].map((s) => row.indexOf(s));
  assert.ok(
    order.every((i) => i >= 0),
    `all actions present: ${String(order)}`,
  );
  assert.deepEqual(
    [...order].sort((x, y) => x - y),
    order,
  );
});
