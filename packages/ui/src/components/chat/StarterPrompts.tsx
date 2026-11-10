import type { Project } from "@octo/agent-client";
import { ListChecks, Map as MapIcon, ShieldAlert, type LucideIcon } from "lucide-react";

type Starter = { title: string; text: string; icon: LucideIcon };

function prompts(project: Project): Starter[] {
  const where = project.folders.length ? `the attached folder${project.folders.length > 1 ? "s" : ""}` : "this project";
  return [
    {
      title: "Map the codebase",
      icon: MapIcon,
      text: `Get oriented in ${where}: map the structure, entry points and how the main pieces fit together. Save the key facts as notes.`,
    },
    {
      title: "Find what's risky",
      icon: ShieldAlert,
      text: `Review ${where} for the riskiest areas (fragile code, missing tests, unclear ownership) and rank them with evidence.`,
    },
    {
      title: "Plan a change",
      icon: ListChecks,
      text: "I want to make a change. Ask me what it is, then break it into tasks you can delegate, and propose a plan before anyone edits files.",
    },
  ];
}

/** Empty project: its name, one line, and three quiet bordered rows that fill the composer. */
export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  return (
    <section aria-labelledby="starter-title" className="pt-4">
      <h1 id="starter-title" className="text-title text-fg">
        {project.name}
      </h1>
      <p className="mt-1 text-sm text-fg-2">Ask the orchestrator. It plans, delegates to sub-agents and keeps notes.</p>
      <ul className="mt-4 flex flex-col gap-2">
        {prompts(project).map((p) => (
          <li key={p.title}>
            <button
              type="button"
              onClick={() => onPick(p.text)}
              title={p.text}
              className="press-row flex w-full items-start gap-3 rounded-md border border-line p-card text-left hover:border-line-strong hover:bg-hover"
            >
              <p.icon size={16} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="mt-0.5 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{p.title}</span>
                <span className="block truncate text-xs text-fg-3">{p.text}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
