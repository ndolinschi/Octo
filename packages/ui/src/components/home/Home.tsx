import { useEffect, useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import type { GlyphState } from "../../lib/stateGlyph";
import { STREAK_BAND } from "../../lib/streakPresets";
import { sessionTriageOf, TRIAGE_LABEL, TRIAGE_ORDER, triageOf, type Triage } from "../../lib/triage";
import { loadPref, PREFS, sidebarViewCodec } from "../../lib/storage";
import { useSessionIndex } from "../../state/sessionIndex";
import type { SessionItem } from "./HomeProjects";
import { useApp } from "../../state/app";
import { Card } from "../primitives/Card";
import { ListRow } from "../primitives/ListRow";
import { StateGlyph } from "../primitives/StateGlyph";
import { StreakLayer } from "../primitives/StreakLayer";
import { TeamCard } from "./HomeCards";
import { Projects } from "./HomeProjects";
import { STILL } from "./still";
import { useOverview } from "./useOverview";

/**
 * Home (`#/`, decisions 22, 23, 75, 91a): projects and their orchestrators, not requests. The streak is a band at the top
 * (a spacer of its height keeps the content out of it), then the title, the state tiles that filter the list, the project
 * list (needs you, working, then the rest) and "Agents at work" while an agent runs. Nothing here only reports a number
 * (decision 75); numbers live in Usage.
 */
export function Home({ onNewProject, unseen }: { onNewProject(): void; onSearch(): void; unseen: Set<string> }) {
  const { theme, backdrop } = useApp();
  // 11d: the window's title names the screen.
  useEffect(() => {
    document.title = "Home · Octo";
  }, []);
  const data = useOverview();
  const now = useNow(true, CLOCK_MINUTE_MS);
  const [filter, setFilter] = useState<Triage | null>(null);
  // Decision 96 (criterion 36): needs you, working and ready to review list sessions with their project; Idle lists the projects
  // with nothing in those groups. In the "Projects" sidebar view Home stays as it was (projects only).
  const index = useSessionIndex(data.projects);
  const [byProjects] = useState(() => loadPref(PREFS.sidebarView, sidebarViewCodec) === "projects");
  const sessions = useMemo<SessionItem[] | null>(() => {
    if (byProjects || !index.loaded || index.all.length === 0) return null;
    const newest = new Map<string, string>();
    for (const s of index.all) if (!s.archived && !newest.has(s.project_id)) newest.set(s.project_id, s.id);
    return index.all
      .filter((s) => !s.archived)
      .map((s) => ({ session: s, triage: sessionTriageOf(s, unseen.has(s.project_id), newest.get(s.project_id) === s.id) }))
      .filter((x) => x.triage !== "idle");
  }, [byProjects, index, unseen]);
  const triaged = useMemo(
    () =>
      (data.projects ?? []).flatMap((p) => {
        const s = data.orchestrators.get(p.id) ?? ({ kind: "idle", at: p.updated_at } as const);
        // With sessions, a project shows as a row only in Idle: when none of its sessions is in another group.
        if (sessions) return sessions.some((x) => x.session.project_id === p.id) ? [] : [{ project: p, state: s, triage: "idle" as const }];
        return [{ project: p, state: s, triage: triageOf(s, unseen.has(p.id)) }];
      }),
    [data.projects, data.orchestrators, unseen, sessions],
  );
  const count = data.projects?.length ?? 0;
  return (
    // Decision 50: the streak is fixed to the panel (outside the scroller); only the content scrolls, never rubber-bands.
    <section aria-labelledby="home-title" data-home className="@container/home relative flex h-full flex-col overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_BAND} theme={theme} mono={backdrop === "mono"} />}
      <div aria-hidden className={cn("shrink-0", backdrop === "off" ? "h-6" : "h-(--octo-band-h)")} />
      <div data-home-scroll data-start-scroll className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="mx-auto flex w-full max-w-home flex-col gap-4 px-6 pt-2 pb-8 max-sm:px-4">
          <div className="flex flex-col gap-3">
            {/* Decision 28: one sentence in two tones — the lead-in muted, the statement in fg. */}
            {/* Polish step 2 (F5): one left edge at 16px inside the column — the heading's text, the tiles' glyphs, the cards'
                captions and glyphs (card 8 + row 8) — instead of a centred heading over left-aligned rows. */}
            <h1 id="home-title" data-page-title tabIndex={-1} className="px-4 text-display text-fg focus-visible:shadow-none">
              {count > 0 && <span className="octo-lead block">{count === 1 ? "1 project" : `${count} projects`}</span>}
              What should we work on?
            </h1>
            <TriageRow items={[...triaged, ...(sessions ?? [])]} loading={data.projects === null} value={filter} onChange={setFilter} />
          </div>
          <Projects items={triaged} sessions={sessions} data={data} now={now} filter={filter} onNewProject={onNewProject} />
          <TeamCard projects={data.projects} agents={data.agents} />
        </div>
      </div>
    </section>
  );
}

const TRIAGE_GLYPH: Record<Triage, GlyphState> = { needs: "needs", working: "working", review: "unseen", idle: "idle" };

/**
 * Decision 26's triage row: four one-row `Card` tiles (two rows of two under 640px) — Needs you, Working, Ready to review,
 * Idle — each a toggle that filters the project list (one at a time; again to clear). A zero tile stays, quiet. The glyphs
 * are still (decision 76): a tile counts projects, it is not itself working.
 */
function TriageRow(props: { items: { triage: Triage }[]; loading: boolean; value: Triage | null; onChange(t: Triage | null): void }) {
  return (
    <div role="group" aria-label="Filter projects by state" className="grid grid-cols-4 gap-2 @max-[640px]/home:grid-cols-2">
      {TRIAGE_ORDER.map((t) => {
        const n = props.items.filter((x) => x.triage === t).length;
        const on = props.value === t;
        const quiet = props.loading || n === 0;
        return (
          <div key={t} data-triage={t} className="min-w-0">
            <Card padding="none">
              <ListRow
                size="lg"
                className="px-2"
                selected={on}
                // Polish step 2 (F5): a tile with nothing in it is wholly quiet — words, count and glyph.
                tone={quiet ? "quiet" : "default"}
                onClick={() => props.onChange(on ? null : t)}
                leading={<StateGlyph state={TRIAGE_GLYPH[t]} size={14} box={16} quiet={quiet} className={STILL} />}
                title={TRIAGE_LABEL[t]}
                meta={<span className={cn("tabular-nums", quiet ? "text-fg-3" : "text-fg")}>{props.loading ? "–" : n}</span>}
                tip={`${TRIAGE_LABEL[t]}: ${props.loading ? "loading" : n}`}
              />
            </Card>
          </div>
        );
      })}
    </div>
  );
}
