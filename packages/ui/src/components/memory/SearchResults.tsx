import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { moveInList } from "../../lib/focus";
import { useNow } from "../../lib/hooks";
import { formatWhen } from "../../lib/memory/dates";
import { emptyText, HIT_LIMIT, type HitTarget, type UiHit } from "../../lib/memory/search";
import { ListChecks } from "lucide-react";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { Highlight } from "../primitives/Highlight";
import { ListRow } from "../primitives/ListRow";
import { PanelEmpty } from "../primitives/Panel";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonList } from "../primitives/Skeleton";
import { FloatRoom } from "../primitives/floatRoom";
import { MemoryError, ROW_TAIL, RowLine } from "./parts";
import type { SearchState } from "./useMemorySearch";

/**
 * The results that replace the views while the search field has text (decision 93 b): grouped Exchanges, Knowledge, Files,
 * Notes; each hit a two-line row, the matched word marked, the date at the right. A current item comes before a replaced one.
 */
export function SearchResults(props: { state: SearchState; query: string; canOpenMessage: boolean; onOpen(target: HitTarget): void }) {
  const now = useNow(false, CLOCK_MINUTE_MS);
  const { state, query } = props;
  if (state.status === "idle")
    return (
      <div className="h-full px-pane pt-2">
        <PanelEmpty>Type two letters or more to search requests, knowledge, files and notes.</PanelEmpty>
      </div>
    );
  if (state.status === "loading")
    return (
      <div className="px-pane pt-2">
        <SkeletonList count={5} size="md" twoLine shimmer />
      </div>
    );
  if (state.status === "error") return <MemoryError message={state.message} />;
  if (state.count === 0) {
    return (
      <div className="h-full px-pane pt-2">
        <PanelEmpty>{emptyText(query, state.message)}. Try one word.</PanelEmpty>
      </div>
    );
  }
  return (
    <ScrollArea className="h-full min-h-0 px-pane pt-2 pb-6">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ↑/↓/Home/End between the result rows */}
      <div role="region" aria-label="Results" onKeyDown={moveInList}>
        {state.groups.map((g) => (
          <section key={g.id} aria-label={g.label} className="pt-1">
            <SectionHeader inset className="pr-8" aside={<span className="tabular-nums">{g.hits.length}</span>}>
              {g.label}
            </SectionHeader>
            {g.hits.map((h) => (
              <HitRow key={h.key} hit={h} now={now} openable={h.target !== null && (h.target.to !== "message" || props.canOpenMessage)} onOpen={props.onOpen} />
            ))}
          </section>
        ))}
        {state.capped && (
          <p className="px-2 pt-3 text-xs text-fg-3">The memory search shows its best {HIT_LIMIT} matches. A more specific search finds the rest.</p>
        )}
      </div>
      <FloatRoom />
    </ScrollArea>
  );
}

/** The glyph column of a hit (every Memory list has one): what the hit is. */
function hitIcon(hit: UiHit) {
  switch (hit.kind) {
    case "exchange":
    case "message":
      return GLYPH.sessions;
    case "fact":
      return GLYPH.memory;
    case "task":
      return ListChecks;
    case "note":
      return GLYPH.notes;
    case "file":
      return fileIcon(hit.target?.to === "file" ? hit.target.path : hit.name);
  }
}

function HitRow(props: { hit: UiHit; now: number; openable: boolean; onOpen(target: HitTarget): void }) {
  const { hit } = props;
  const target = hit.target;
  const when = formatWhen(hit.date, props.now);
  const second = hit.passage ?? (hit.context || null);
  const line2 = second === null ? null : hit.passage === null ? second : <Highlight text={second} query={hit.passageWord} />;
  const earlier = hit.superseded ? "earlier version" : null;
  const name = <Highlight text={hit.name} query={hit.nameWord} />;
  // Nothing for line 2: a one-line row, its date at the end of line 1.
  const single = line2 === null && earlier === null;
  return (
    <ListRow
      size="md"
      leading={<Glyph icon={hitIcon(hit)} size={14} />}
      title={name}
      {...(single ? { meta: when } : {})}
      {...(single
        ? {}
        : {
            description: (
              <RowLine end={when}>
                {line2}
                {line2 !== null && earlier ? " · " : null}
                {earlier}
              </RowLine>
            ),
          })}
      tip={hit.name}
      tone={hit.superseded ? "quiet" : "default"}
      trailing={ROW_TAIL}
      {...(props.openable && target ? { onClick: () => props.onOpen(target) } : {})}
    />
  );
}
