import { ArrowLeft, Blocks, Brain, Cpu, Gauge, Info, Palette, Plug, Settings, Shield, Smartphone, SquareCode, Terminal, type LucideIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { useRowKeys } from "../../lib/hooksMore";
import { settingsHref } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ScrollArea } from "../primitives/ScrollArea";
import { SearchField } from "../primitives/SearchField";
import { cn } from "../../lib/cn";
import { useSidebarWidth } from "../../lib/sidebarWidth";
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
  // The sidebar's width (the person's drag of its edge): Settings' column stands where the sidebar did.
  const nav = useRef<HTMLElement>(null);
  useSidebarWidth(nav);
  return (
    <nav ref={nav} aria-label="Settings" className="flex h-full w-sidebar shrink-0 flex-col bg-window pl-gutter max-settings:hidden">
      {/* The sidebar's frame (8 gutter, 8 inset): "Back" on the sidebar's first row, every glyph on x=24, every label on x=48. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-pane">
        <ListRow
          size="md"
          tone="quiet"
          title="Back"
          tip="Back to the app"
          leading={<Glyph icon={ArrowLeft} size={16} className="text-fg-2" />}
          onClick={props.onBack}
        />
        <SearchField label="Search settings" align="rows" value={props.query} onChange={props.onQuery} onKeyDown={props.onSearchKey} />
        <ScrollArea ref={sections} className="flex min-h-0 flex-1 flex-col">
          {/* G14: three quiet groups, captioned by the sidebar's one rule for both side columns (SessionTree's "Projects"): the
              caption on the rows' glyph column (8 inset), a 20px line 16px under the block above (the search field, the last row)
              and 4px over its first row. Not headings: the page's h1 is the first heading (the groups are named by aria-labelledby). */}
          {GROUPS.map((g, i) => (
            <div key={g.title} role="group" aria-labelledby={`settings-nav-${i}`} className={cn("flex flex-col", i === 0 ? "mt-2" : "mt-4")}>
              <div id={`settings-nav-${i}`} data-side-caption className="mb-1 flex h-5 shrink-0 items-center pl-2 text-xs text-fg-3">
                {g.title}
              </div>
              {g.sections.map((s) => (
                <ListRow
                  key={s.id}
                  size="md"
                  title={s.label}
                  leading={<Glyph icon={GLYPHS[s.id]} size={16} className="text-fg-2" />}
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
