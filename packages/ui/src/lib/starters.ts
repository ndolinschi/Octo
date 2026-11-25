import type { Project } from "@octo/agent-client";

export type Starter = { title: string; text: string };

/**
 * C4: what the app knows about the project's folder before the first request — the scripts the local service found
 * (`GET …/commands/suggestions`) and the names at the folder's top level (`listFiles(…, "")`). `null`: not known (no answer, or
 * the bridge cannot say), which falls back to the general suggestions.
 */
export type FolderSignals = {
  scripts: readonly { name: string; command: string }[] | null;
  top: readonly string[] | null;
};

const TEST = /^(test|tests|check:test|test:unit|unit)$/i;
const LINT = /^(lint|eslint|check:lint|lint:check)$/i;

/** Decision 91f: at most this many suggestions. */
export const MAX_STARTERS = 3;

/**
 * Decision 52: starters only when they are specific to this project — they name its folder; a project without a folder gets
 * none (the composer alone is the way in). C4: chosen from what is in the folder, first match first, at most three: an empty
 * folder gets its own pair; then the test and lint scripts the local service found (with their command lines); then the
 * README; then the structure, and "what changed" only where the folder has a `.git`. Nothing promises uncommitted changes:
 * the local service has no git status yet.
 */
export function prompts(project: Pick<Project, "folders">, signals: FolderSignals = { scripts: null, top: null }): Starter[] {
  const folder = project.folders[0]?.label;
  if (!folder) return [];
  const top = signals.top;
  const shown = top?.filter((n) => !n.startsWith(".")) ?? null;
  if (shown?.length === 0)
    return [
      { title: "Set up a new project here", text: `${folder} is an empty folder. Ask me what it should become, then set it up: files, scripts, a README.` },
      {
        title: "Plan the first version with me",
        text: `${folder} is empty. Ask me what I want to build, then propose a first version and the steps to get there.`,
      },
    ];
  const out: Starter[] = [];
  const test = signals.scripts?.find((s) => TEST.test(s.name));
  if (test)
    out.push({ title: "Run the tests and fix what fails", text: `Run \`${test.command}\` in ${folder} and fix what fails. Tell me before changing a test.` });
  const lint = signals.scripts?.find((s) => LINT.test(s.name));
  if (lint) out.push({ title: "Run lint and fix the warnings", text: `Run \`${lint.command}\` in ${folder} and fix the warnings it reports.` });
  const readme = shown?.find((n) => /^readme(\.|$)/i.test(n));
  if (readme)
    out.push({
      title: "What is this project?",
      text: `Read ${readme} in ${folder} and tell me what the project does, how to run it and what the README leaves out.`,
    });
  out.push({ title: `Explain the structure of ${folder}`, text: `Explain the structure of ${folder}: the entry points and how the main pieces fit together.` });
  if (top?.includes(".git")) out.push({ title: "What changed recently?", text: `Summarise what changed in ${folder} over the last week, from its history.` });
  return out.slice(0, MAX_STARTERS);
}
