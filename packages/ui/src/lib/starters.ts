import type { Project } from "@octo/agent-client";

export type Starter = { title: string; text: string };

/**
 * Decision 52: starters only when they are specific to this project — they name its folder; a project without a folder
 * gets none (the composer alone is the way in).
 */
export function prompts(project: Pick<Project, "folders">): Starter[] {
  const folder = project.folders[0]?.label;
  if (!folder) return [];
  return [
    { title: `Explain the structure of ${folder}`, text: `Explain the structure of ${folder}: the entry points and how the main pieces fit together.` },
    { title: "Review my uncommitted changes", text: `Review my uncommitted changes in ${folder} and tell me what could break.` },
    { title: "What changed recently?", text: `Summarise what changed in ${folder} over the last week, from its history.` },
  ];
}
