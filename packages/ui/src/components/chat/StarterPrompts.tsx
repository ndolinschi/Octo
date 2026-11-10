import type { Project } from "@octo/agent-client";
import { ListChecks, Map as MapIcon, ShieldAlert, type LucideIcon } from "lucide-react";
import { Glyph } from "../primitives/Glyph";

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

/**
 * Starter prompts under the empty project's composer: quiet 32px rows (no box), [16px icon] 8 [title]
 * 8 [the prompt, muted, truncated]; picking one fills the composer. The list's 4px inset plus the rows'
 * 8px padding puts the icons on the line of the composer's "+" glyph (box inset 6 + 6 inside its button).
 */
export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  return (
    <ul aria-label="Starter prompts" className="flex flex-col px-1">
      {prompts(project).map((p) => (
        <li key={p.title}>
          <button
            type="button"
            data-row
            onClick={() => onPick(p.text)}
            title={p.text}
            className="press-row flex h-row-nav w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-hover"
          >
            <Glyph icon={p.icon} size={16} className="shrink-0 text-fg-3" />
            <span className="shrink-0 text-fg">{p.title}</span>
            <span className="min-w-0 flex-1 truncate text-fg-3">{p.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
