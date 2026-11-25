import { Check, ChevronRight, File, GitPullRequest, Search, Settings2 } from "lucide-react";
import { ProviderMark } from "../ProviderMark";
import { StateGlyph } from "../StateGlyph";
import { Section, Variants } from "./parts";

const ICONS = [Check, ChevronRight, File, GitPullRequest, Search, Settings2];
const SIZES = [12, 14, 16, 20] as const;
const RADII = [
  ["2xs 2", "rounded-2xs", "kbd hints, marks"],
  ["xs 4", "rounded-xs", "inline code, focus"],
  ["sm 6", "rounded-sm", "chips, segments"],
  ["md 8", "rounded-md", "fields, rows, buttons, cards"],
  ["xl 12", "rounded-xl", "surfaces, overlays"],
  ["pill", "rounded-full", "badges, dots"],
] as const;
const TYPE = [
  ["text-xs", "12 / 16", "meta, captions"],
  ["text-sm", "13 / 20", "UI text, rows"],
  ["text-base", "14 / 22", "prose body"],
  ["text-heading", "14 / 20", "card and section titles"],
  ["text-title", "16 / 20", "page titles"],
] as const;

/** The evenness scales on one sheet: one icon stroke at every size, the radius scale, whole-pixel type and mono. */
export function ScalesSection() {
  return (
    <Section
      id="scales"
      title="Icon stroke, radius and type scales"
      note="Every icon is drawn with --icon-stroke (1.5px rendered) at 12, 14, 16 and 20, lucide and the custom state glyph alike; vendor marks are filled. Radii are 6, 8, 12 and pill (2 and 4 for tiny marks). Type sizes are whole pixels."
    >
      {SIZES.map((s) => (
        <Variants key={s} label={`Icons at ${s}px (lucide, state glyph ring family, vendor mark)`}>
          {ICONS.map((I, i) => (
            <I key={i} size={s} className="text-fg-2" />
          ))}
          {s <= 14 && <StateGlyph state="working" size={s as 12 | 14} />}
          {s <= 14 && <StateGlyph state="needs" size={s as 12 | 14} />}
          <ProviderMark id="claude-code" label="Claude Code" size={s} className="text-fg-2" />
          <ProviderMark id="openai" label="OpenAI" size={s} className="text-fg-2" />
        </Variants>
      ))}
      <Variants label="Radius scale">
        {RADII.map(([name, cls, use]) => (
          <div key={name} className="flex flex-col gap-1.5">
            <div className={`h-10 w-20 border border-line-strong bg-raised ${cls}`} />
            <span className="text-xs text-fg-2">{name}</span>
            <span className="text-xs text-fg-3">{use}</span>
          </div>
        ))}
      </Variants>
      <Variants label="Concentric: 12 card, 8 rows at a 4px inset; 8 track, 6 segments at 2px">
        <div className="flex w-48 flex-col gap-1 rounded-xl border border-line-strong bg-raised p-1">
          <div className="h-7 rounded-md bg-hover" />
          <div className="h-7 rounded-md bg-hover" />
        </div>
        <div className="flex gap-0 rounded-md bg-seg-track p-0.5">
          <div className="h-6 w-16 rounded-sm bg-seg-on" />
          <div className="h-6 w-16 rounded-sm" />
        </div>
      </Variants>
      <Variants label="Type: whole pixels, one line height per size">
        <div className="flex flex-col gap-1">
          {TYPE.map(([cls, size, use]) => (
            <div key={cls} className="flex items-baseline gap-3">
              <span className={`${cls} w-56 text-fg`}>The quick brown fox</span>
              <span className="w-16 text-xs text-fg-3">{size}</span>
              <span className="text-xs text-fg-3">{use}</span>
            </div>
          ))}
          <div className="flex items-baseline gap-3">
            <span className="w-56 font-mono text-xs text-fg">const a = 1;</span>
            <span className="w-16 text-xs text-fg-3">12 / 20</span>
            <span className="text-xs text-fg-3">code blocks (a deliberate role); inline code 13 in 14px prose, 12 in 13px</span>
          </div>
        </div>
      </Variants>
    </Section>
  );
}
