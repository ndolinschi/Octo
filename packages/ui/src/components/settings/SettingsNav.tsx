import { ArrowLeft, Brain, Cpu, Gauge, Info, Palette, Plug, Settings, Shield, SquareCode, Terminal, type LucideIcon } from "lucide-react";
import { settingsHref } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ScrollArea } from "../primitives/ScrollArea";
import { SearchField } from "../primitives/SearchField";
import { SECTIONS, type SectionId } from "./settingsIndex";

const GLYPHS: Record<SectionId, LucideIcon> = {
  general: Settings,
  appearance: Palette,
  providers: Plug,
  models: Cpu,
  editor: SquareCode,
  usage: Gauge,
  memory: Brain,
  commands: Terminal,
  privacy: Shield,
  about: Info,
};

/** Decision 59: the settings navigation in the sidebar's place — "← Back", the search field, then the sections. */
export function SettingsNav(props: { section: SectionId; searching: boolean; query: string; onQuery(v: string): void; onBack(): void }) {
  return (
    <nav aria-label="Settings" className="flex h-full w-sidebar shrink-0 flex-col bg-window py-gutter pl-gutter max-settings:hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-pane">
        <ListRow size="md" tone="quiet" title="Back" leading={<Glyph icon={ArrowLeft} size={16} />} onClick={props.onBack} />
        <SearchField label="Search settings" value={props.query} onChange={props.onQuery} />
        <ScrollArea className="flex min-h-0 flex-1 flex-col">
          {SECTIONS.map((s) => (
            <ListRow
              key={s.id}
              size="md"
              title={s.label}
              leading={<Glyph icon={GLYPHS[s.id]} size={16} />}
              href={settingsHref(s.id)}
              selected={!props.searching && s.id === props.section}
              onClick={() => props.onQuery("")}
            />
          ))}
        </ScrollArea>
      </div>
    </nav>
  );
}
