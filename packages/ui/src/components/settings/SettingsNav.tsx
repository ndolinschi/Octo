import { ArrowLeft, Blocks, Brain, Cpu, Gauge, Info, Palette, Plug, Settings, Shield, Smartphone, SquareCode, Terminal, type LucideIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { useRowKeys } from "../../lib/hooksMore";
import { settingsHref } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ScrollArea } from "../primitives/ScrollArea";
import { SearchField } from "../primitives/SearchField";
import { cn } from "../../lib/cn";
import { navGroups } from "./navGroups";
import { useHost } from "../../state/host";
import { ON_YOUR_COMPUTER, sectionLocked } from "../../lib/remoteDevice";
import type { SectionId } from "./settingsIndex";

const GROUPS = navGroups();

const GLYPHS: Record<SectionId, LucideIcon> = {
  general: Settings,
  appearance: Palette,
  providers: Plug,
  models: Cpu,
  editor: SquareCode,
  integrations: Blocks,
  usage: Gauge,
  memory: Brain,
  commands: Terminal,
  privacy: Shield,
  remote: Smartphone,
  about: Info,
};

/** Decision 59: the settings navigation in the sidebar's place — "← Back", the search field, then the sections. */
export function SettingsNav(props: {
  section: SectionId;
  searching: boolean;
  query: string;
  onQuery(v: string): void;
  onBack(): void;
  /** S4: ArrowDown / Enter in the search field reach the results. */
  onSearchKey(e: KeyboardEvent<HTMLInputElement>): void;
}) {
  // S4: ↑/↓, Home and End move between the sections (the sidebar's list keys); Enter opens one.
  const sections = useRef<HTMLDivElement>(null);
  useRowKeys(sections);
  const device = useHost().remoteDevice;
  return (
    <nav aria-label="Settings" className="flex h-full w-sidebar shrink-0 flex-col bg-window py-gutter pl-gutter max-settings:hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-pane">
        <ListRow size="md" tone="quiet" title="Back" tip="Back to the app" leading={<Glyph icon={ArrowLeft} size={16} />} onClick={props.onBack} />
        <SearchField label="Search settings" value={props.query} onChange={props.onQuery} onKeyDown={props.onSearchKey} />
        <ScrollArea ref={sections} className="flex min-h-0 flex-1 flex-col">
          {/* G14: three quiet groups. A caption is a 32px row with its text on the rows' text edge (the sidebar's "Projects"). */}
          {GROUPS.map((g, i) => (
            <div key={g.title} role="group" aria-labelledby={`settings-nav-${i}`} className={cn("flex flex-col", i > 0 && "mt-2")}>
              <h2 id={`settings-nav-${i}`} className="flex h-row-nav shrink-0 items-center pl-8 text-xs text-fg-3">
                {g.title}
              </h2>
              {g.sections.map((s) => (
                <ListRow
                  key={s.id}
                  size="md"
                  title={s.label}
                  leading={<Glyph icon={GLYPHS[s.id]} size={16} />}
                  {...(sectionLocked(device, s.id)
                    ? // Remote access: a section the device may not change (the harness refuses it) stays in the list, disabled.
                      { description: ON_YOUR_COMPUTER, disabled: true }
                    : { href: settingsHref(s.id), onClick: () => props.onQuery("") })}
                  selected={!props.searching && s.id === props.section}
                />
              ))}
            </div>
          ))}
        </ScrollArea>
      </div>
    </nav>
  );
}
