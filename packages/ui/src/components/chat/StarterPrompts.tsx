import type { Project } from "@octo/agent-client";
import { useRef } from "react";
import { useRowKeys } from "../../lib/hooksMore";
import { prompts } from "../../lib/starters";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";

/** Decision 91f: at most this many suggestions. */
const MAX = 3;

/**
 * Suggestions under the empty project's composer (decisions 52, 91f): a quiet caption and `ListRow`s (hover, focus, arrow
 * keys; Enter or a click puts the prompt in the composer, where it can be read and edited before sending). The full
 * prompt is the row's tooltip.
 */
export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  const list = prompts(project).slice(0, MAX);
  const box = useRef<HTMLUListElement>(null);
  useRowKeys(box);
  if (!list.length) return null;
  return (
    <div className="flex flex-col px-1">
      <SectionHeader inset as="h2">
        Suggestions
      </SectionHeader>
      <ul ref={box} aria-label="Suggestions" className="flex flex-col">
        {list.map((p) => (
          <li key={p.title}>
            <ListRow tone="quiet" size="md" title={p.title} tip={p.text} onClick={() => onPick(p.text)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
