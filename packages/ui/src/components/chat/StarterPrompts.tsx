import type { Project } from "@octo/agent-client";
import { ArrowUpRight } from "lucide-react";
import { OctoMark } from "../shell/OctoMark";

function prompts(project: Project): { title: string; text: string }[] {
  const where = project.folders.length ? `the attached folder${project.folders.length > 1 ? "s" : ""}` : "this project";
  return [
    {
      title: "Map the codebase",
      text: `Get oriented in ${where}: map the structure, entry points and how the main pieces fit together. Save the key facts as notes.`,
    },
    {
      title: "Find what's risky",
      text: `Review ${where} for the riskiest areas — fragile code, missing tests, unclear ownership — and rank them with evidence.`,
    },
    {
      title: "Plan a change",
      text: "I want to make a change. Ask me what it is, then break it into tasks you can delegate, and propose a plan before anyone edits files.",
    },
  ];
}

export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  return (
    <section aria-labelledby="starter-title" className="pt-[12vh]">
      <OctoMark size={28} />
      <h1 id="starter-title" className="mt-5 text-xl font-semibold tracking-[-0.015em]">
        {project.name}
      </h1>
      <p className="mt-1.5 max-w-[560px] text-[14px] leading-6 text-fg-2">
        You're talking to this project's orchestrator. It keeps the big picture, delegates focused work to sub-agents — in
        parallel when it can — and records what it learns in Notes. You can watch any sub-agent from the Agents panel.
      </p>
      <ul className="mt-7 grid gap-2 sm:grid-cols-3">
        {prompts(project).map((p) => (
          <li key={p.title}>
            <button
              type="button"
              onClick={() => onPick(p.text)}
              className="group flex h-full w-full flex-col gap-1.5 rounded-lg border border-line bg-raised p-3.5 text-left transition-colors hover:border-line-strong hover:bg-hover"
            >
              <span className="flex w-full items-center text-sm font-medium text-fg">
                {p.title}
                <ArrowUpRight size={14} aria-hidden className="ml-auto text-fg-3 transition-colors group-hover:text-fg-2" />
              </span>
              <span className="line-clamp-3 text-xs leading-[18px] text-fg-3">{p.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
