import type { Project } from "@octo/agent-client";
import { prompts } from "../../lib/starters";

/**
 * Starter prompts under the empty project's composer: quiet 32px rows (no box, no icons — three different
 * pictures for three sentences only added noise), [title] 8 [the prompt, muted, truncated]; the full prompt
 * is the row's tooltip (pointer and keyboard focus) and its accessible description, and picking one puts it
 * in the composer, where it can be read and edited before sending.
 */
export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  const list = prompts(project);
  if (!list.length) return null;
  return (
    <ul aria-label="Starter prompts" className="flex flex-col px-1">
      {list.map((p) => (
        <li key={p.title}>
          <button
            type="button"
            data-row
            onClick={() => onPick(p.text)}
            title={p.text}
            aria-description={p.text}
            className="flex h-row-nav w-full items-center gap-2 rounded-sm px-2 text-left text-sm press-row hover:bg-hover"
          >
            <span className="min-w-0 truncate text-fg-2">{p.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
