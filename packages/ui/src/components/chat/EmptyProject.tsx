import type { PluginAgent, Project } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { useActivity } from "../../state/activity";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { modelLabel } from "../primitives/Status";
import { StarterPrompts } from "./StarterPrompts";

/** The empty project's title block (above the composer). */
export function EmptyTitle({ project }: { project: Project }) {
  return (
    <div className="relative mx-auto w-full max-w-float text-center">
      {/* The title sits on the band: a soft local scrim keeps it ≥ 4.5:1 (the band is not dimmed). */}
      <div aria-hidden className="octo-streak-scrim" />
      <h1 className="relative text-display text-fg">Give {project.name}&rsquo;s orchestrator its first task</h1>
      <p className="relative mt-2 text-sm text-fg-2">It plans the work, delegates to sub-agents and keeps notes, in this project's folders.</p>
    </div>
  );
}

function Fact({ icon, label, value, title }: { icon: typeof GLYPH.files; label: string; value: React.ReactNode; title: string }) {
  return (
    <li className="flex h-row min-w-0 items-center gap-2 px-2 text-sm" title={title}>
      <span className="grid size-4 shrink-0 place-items-center">
        <Glyph icon={icon} size={14} className="text-fg-3" />
      </span>
      <span className="w-20 shrink-0 text-fg-2">{label}</span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{value}</span>
    </li>
  );
}

/**
 * Under the empty project's composer (decision 23): what the orchestrator has — its folders, the models per tier,
 * the external agents it can delegate to — as three quiet facts, then the starter prompts.
 */
export function EmptyFacts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  const activity = useActivity();
  const [agents, setAgents] = useState<PluginAgent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Without the plugin list the fact says so; nothing else depends on it.
    activity.plugins().then(
      (plugins) => !cancelled && setAgents(plugins.flatMap((p) => p.agents).filter((a) => a.available)),
      () => !cancelled && setAgents([]),
    );
    return () => {
      cancelled = true;
    };
  }, [activity]);
  const m = project.models;
  const tiers = [
    ["Orchestrator", m.orchestrator],
    ["Fast", m.fast],
    ["Balanced", m.balanced],
    ["Deep", m.deep],
  ] as const;
  // Aligned pairs (tier muted, model), 12 apart — not a "·"-joined run (craft rule).
  const models = (
    <span className="flex min-w-0 items-baseline gap-3 overflow-hidden">
      {tiers.map(([tier, model]) => (
        <span key={tier} className="flex shrink-0 items-baseline gap-1">
          <span className="text-fg-3">{tier}</span>
          <span className="text-fg-2">{modelLabel(model)}</span>
        </span>
      ))}
    </span>
  );
  const modelsTitle = tiers.map(([tier, model]) => `${tier}: ${model}`).join("\n");
  const folders = project.folders.length ? project.folders.map((f) => f.label).join(", ") : "None yet: add one in project settings";
  return (
    // On a translucent card over the streak (like Home's), so every line keeps ≥ 4.5:1 at the band's brightest pixel.
    <div className="octo-card relative mx-auto flex w-full max-w-float flex-col gap-1 rounded-lg p-1">
      <ul aria-label="What the orchestrator has" className="flex flex-col px-1">
        <Fact icon={GLYPH.files} label="Folders" value={folders} title={project.folders.map((f) => f.path).join("\n") || folders} />
        <Fact icon={GLYPH.chat} label="Models" value={models} title={modelsTitle} />
        <Fact
          icon={GLYPH.agent}
          label="Agents"
          value={agents === null ? "…" : agents.length ? `Sub-agents, plus ${agents.map((a) => a.label).join(", ")}` : "Sub-agents on the tiers above"}
          title={
            agents?.length
              ? `Sub-agents on the tiers above, plus the external agents ${agents.map((a) => a.label).join(", ")}`
              : "Sub-agents on the tiers above"
          }
        />
      </ul>
      <StarterPrompts project={project} onPick={onPick} />
    </div>
  );
}
