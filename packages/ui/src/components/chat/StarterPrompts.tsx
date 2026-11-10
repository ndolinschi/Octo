import type { Project } from "@octo/agent-client";

function prompts(project: Project): { title: string; text: string }[] {
  const where = project.folders.length ? `the attached folder${project.folders.length > 1 ? "s" : ""}` : "this project";
  return [
    {
      title: "Map the codebase",
      text: `Get oriented in ${where}: map the structure, entry points and how the main pieces fit together. Save the key facts as notes.`,
    },
    {
      title: "Find what's risky",
      text: `Review ${where} for the riskiest areas (fragile code, missing tests, unclear ownership) and rank them with evidence.`,
    },
    {
      title: "Plan a change",
      text: "I want to make a change. Ask me what it is, then break it into tasks you can delegate, and propose a plan before anyone edits files.",
    },
  ];
}

export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  return (
    <section aria-labelledby="starter-title" className="pt-3">
      <h1 id="starter-title" className="text-[15px] leading-5 font-semibold">
        {project.name}
      </h1>
      <p className="mt-1 text-sm text-fg-2">Ask the orchestrator. It plans, delegates to sub-agents and keeps notes.</p>
      <ul className="mt-3 -mx-2">
        {prompts(project).map((p) => (
          <li key={p.title}>
            <button
              type="button"
              onClick={() => onPick(p.text)}
              title={p.text}
              className="flex h-8 w-full items-center rounded-sm px-2 text-left text-sm text-fg transition-[background-color] duration-100 hover:bg-hover"
            >
              {p.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
