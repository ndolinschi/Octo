import type { Project } from "@octo/agent-client";
import { useEffect, useRef, useState } from "react";
import { useRowKeys } from "../../lib/hooksMore";
import { useRovingRows } from "../../lib/rovingRows";
import { MAX_STARTERS, prompts, type FolderSignals } from "../../lib/starters";
import { useApp } from "../../state/app";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";

/**
 * C4: the folder's scripts (the local service's command suggestions) and its top-level names, read once per project and
 * folder after the first frame; null until both have answered. A failed read is not shown: that signal is simply unknown
 * and the general suggestions stand in for it.
 */
function useFolderSignals(project: Project): FolderSignals | null {
  const { bridge } = useApp();
  const folder = project.folders[0]?.label;
  const key = `${project.id}/${folder ?? ""}`;
  const [got, setGot] = useState<{ key: string; signals: FolderSignals } | null>(null);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void Promise.allSettled([bridge.listCommandSuggestions?.(project.id) ?? Promise.resolve(null), bridge.listFiles(project.id, folder, "")]).then(
      ([scripts, files]) => {
        if (!live) return;
        setGot({
          key,
          signals: {
            scripts: scripts.status === "fulfilled" ? scripts.value : null,
            top: files.status === "fulfilled" ? files.value.map((e) => e.name) : null,
          },
        });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, project.id, folder, key]);
  return got?.key === key ? got.signals : null;
}

/**
 * Suggestions under the empty project's composer (decisions 52, 91f): a quiet caption and `ListRow`s (hover, focus, arrow
 * keys; Enter or a click puts the prompt in the composer, where it can be read and edited before sending). The full
 * prompt is the row's tooltip.
 */
export function StarterPrompts({ project, onPick }: { project: Project; onPick(text: string): void }) {
  const signals = useFolderSignals(project);
  const list = signals ? prompts(project, signals) : [];
  const box = useRef<HTMLUListElement>(null);
  useRowKeys(box);
  // 7h: the suggestions are one Tab stop; ↑/↓ move between them.
  useRovingRows(box);
  if (!project.folders.length) return null;
  return (
    <div className="flex flex-col px-1">
      <SectionHeader inset as="h2">
        Suggestions
      </SectionHeader>
      <ul ref={box} aria-label="Suggestions" aria-busy={signals === null} className="flex flex-col">
        {list.map((p) => (
          <li key={p.title} className="octo-fade">
            <ListRow tone="quiet" size="md" title={p.title} tip={p.text} onClick={() => onPick(p.text)} />
          </li>
        ))}
      </ul>
      {/* C4: three rows' room from the first frame (the same rows, unseen and inert), so the answer moves nothing. */}
      {list.length < MAX_STARTERS && (
        <div aria-hidden inert className="invisible flex flex-col">
          {Array.from({ length: MAX_STARTERS - list.length }, (_, i) => (
            <ListRow key={i} tone="quiet" size="md" title="Suggestion" />
          ))}
        </div>
      )}
    </div>
  );
}
