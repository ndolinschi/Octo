import { agentLabelOf } from "./errors/words";
import type { AcpOrchestratorChoice } from "@octo/agent-client";

/** What the UI needs of an ACP agent to name it: its id and label (from `config.acp_orchestrators` or the plugins list). */
export type AcpName = Pick<AcpOrchestratorChoice, "id" | "label">;

/** `acp:<id>` or `acp:<id>/<model>` split into its parts; null for a Messages API model id. */
export function parseAcp(value: string): { id: string; model: string | null } | null {
  if (!value.startsWith("acp:")) return null;
  const rest = value.slice(4);
  const slash = rest.indexOf("/");
  if (slash < 0) return rest ? { id: rest, model: null } : null;
  const id = rest.slice(0, slash);
  const model = rest.slice(slash + 1);
  return id ? { id, model: model || null } : null;
}

/** "claude-sonnet-5-5-20261001" → "Sonnet 5.5"; ids that do not follow that shape are shown whole (never guessed at). */
export function claudeLabel(model: string): string {
  const id = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const [, family, major, minor] = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id) ?? [];
  if (!model.startsWith("claude-") || family === undefined || major === undefined) return model;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

/**
 * Decision 48: a model id as shown — a Claude id as its family and version, any other id without its vendor prefix
 * ("deepseek/deepseek-v4.1-flash" → "deepseek-v4.1-flash"); places with little room middle-truncate it (`middleEllipsis`).
 */
export function displayId(id: string): string {
  const label = claudeLabel(id);
  if (label !== id) return label;
  const slash = id.lastIndexOf("/");
  return slash >= 0 && slash < id.length - 1 ? id.slice(slash + 1) : id;
}

const ACRONYMS = new Set(["gpt", "glm", "llm", "xai"]);

/**
 * A model's display name for lists: the harness's own label when it has one, else the id made readable. An agent reports
 * its models by id only ("claude-sonnet-5-5", "openai/gpt-5-mini"), so the label equals the id: the vendor prefix goes, the
 * family is title-cased and the version kept ("Sonnet 5.5", "GPT 5 Mini"). The id itself is stored and shown in tooltips.
 */
export function modelLabel(m: { id: string; label: string }): string {
  if (m.label && m.label !== m.id) return m.label;
  const short = displayId(m.id);
  if (short !== m.id && m.id.startsWith("claude-")) return short;
  const tokens = short.split("-").filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(t) && prev !== undefined && /^\d+(\.\d+)*$/.test(prev) && prev.length <= 2) out[out.length - 1] = `${prev}.${t}`;
    else out.push(ACRONYMS.has(t) ? t.toUpperCase() : /^[a-z]/.test(t) ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : t);
  }
  return out.join(" ") || m.id;
}

/** The label of an agent's model: a name the user typed is kept as typed, anything else is made readable. */
export function agentModelLabel(m: { id: string; label: string; source?: string }): string {
  return m.source === "custom" ? m.id : modelLabel(m);
}

/**
 * A model setting as people read it: a Claude id as its family and version, an `acp:` value as the agent's label and
 * its model ("Claude Code · Opus 5.5", never the raw string), anything else whole.
 */
export function modelName(value: string, acp: readonly AcpName[] = []): string {
  const ref = parseAcp(value);
  if (!ref) return displayId(value);
  const label = acp.find((a) => a.id === ref.id)?.label ?? agentLabelOf(ref.id);
  return ref.model ? `${label} · ${displayId(ref.model)}` : label;
}

/** The model that answered (decision 37): `served_model` when a router reported one, and the requested one when it differs. */
export function servedModel(agent: { model: string; served_model?: string | null }, acp: readonly AcpName[] = []): { name: string; asked: string | null } {
  const asked = modelName(agent.model, acp);
  const served = agent.served_model?.trim();
  if (!served) return { name: asked, asked: null };
  const name = modelName(served, acp);
  return { name, asked: name === asked || served === agent.model ? null : asked };
}

/** Details' long form: "deepseek-v4.1-flash · asked for Sonnet 5.5", or the name alone. */
export function servedText(agent: { model: string; served_model?: string | null }, acp: readonly AcpName[] = []): string {
  const s = servedModel(agent, acp);
  return s.asked ? `${s.name} · asked for ${s.asked}` : s.name;
}
