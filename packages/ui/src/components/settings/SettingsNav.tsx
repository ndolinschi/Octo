import { ArrowLeft, Bot, Brain, Cpu, Gauge, Info, Palette, Plug, Search, Settings, Shield, SquareCode, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { settingsHref } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { SECTIONS, type SectionId } from "./settingsIndex";

const GLYPHS: Record<SectionId, LucideIcon> = {
  general: Settings,
  appearance: Palette,
  providers: Plug,
  models: Cpu,
  agents: Bot,
  editor: SquareCode,
  usage: Gauge,
  memory: Brain,
  privacy: Shield,
  about: Info,
};

/** Same anatomy as the sidebar's rows (32px, 16px leading glyph, radius 6). */
const ROW = "press-row flex h-row-nav w-full min-w-0 items-center gap-2 rounded-sm px-2 text-sm text-fg hover:bg-hover focus-inset";

export function SearchField(props: { value: string; onChange(v: string): void; id: string }) {
  return (
    <label
      htmlFor={props.id}
      className="flex h-row-nav min-w-0 items-center gap-2 rounded-md border border-input-border px-2 text-fg-3 transition-[border-color] duration-100 focus-within:border-fg"
    >
      <Glyph icon={Search} size={14} className="shrink-0" />
      <span className="sr-only">Search settings</span>
      <input
        id={props.id}
        type="search"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && props.value) {
            e.preventDefault();
            props.onChange("");
          }
        }}
        data-esc-clears
        placeholder="Search settings"
        spellCheck={false}
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
      />
    </label>
  );
}

/** Decision 59: the settings navigation in the sidebar's place — "← Back", the search field, then the sections. */
export function SettingsNav(props: { section: SectionId; searching: boolean; query: string; onQuery(v: string): void; onBack(): void; searchId: string }) {
  return (
    <nav aria-label="Settings" className="flex h-full w-sidebar shrink-0 flex-col bg-window py-gutter pl-gutter max-settings:hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-pane">
        <button type="button" onClick={props.onBack} className={cn(ROW, "text-fg-2")}>
          <Glyph icon={ArrowLeft} size={16} className="shrink-0" />
          <span className="truncate">Back</span>
        </button>
        <SearchField id={props.searchId} value={props.query} onChange={props.onQuery} />
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {SECTIONS.map((s) => {
            const current = !props.searching && s.id === props.section;
            return (
              <li key={s.id}>
                <a
                  href={settingsHref(s.id)}
                  aria-current={current ? "page" : undefined}
                  onClick={() => props.onQuery("")}
                  className={cn(ROW, current && "bg-active hover:bg-active")}
                >
                  <Glyph icon={GLYPHS[s.id]} size={16} className="shrink-0 text-fg-2" />
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
