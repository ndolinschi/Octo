import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useEscape } from "../../lib/hooks";
import { settingsHref } from "../../lib/route";
import { Button } from "../primitives/Button";
import { CommandsSection } from "./CommandsSection";
import { AppearanceSection, GeneralSection } from "./GeneralSection";
import { HarnessSettingsProvider } from "./harnessSettings";
import { ModelsSection } from "./ModelsSection";
import { SettingsActionsProvider, type SettingsActions } from "./pageContext";
import { Select } from "./parts";
import { AboutSection, PrivacySection } from "./PrivacySection";
import { EditorSection, MemorySection, UsageSection } from "./ProjectSections";
import { ProvidersSection } from "./ProvidersSection";
import { SearchField, SettingsNav } from "./SettingsNav";
import { isWideSection, searchSettings, SECTIONS, sectionLabel, sectionOf, type IndexedRow, type SectionId } from "./settingsIndex";

const CONTENT: Record<SectionId, () => ReactNode> = {
  general: () => <GeneralSection />,
  appearance: () => <AppearanceSection />,
  providers: () => <ProvidersSection />,
  models: () => <ModelsSection />,
  editor: () => <EditorSection />,
  usage: () => <UsageSection />,
  memory: () => <MemorySection />,
  commands: () => <CommandsSection />,
  privacy: () => <PrivacySection />,
  about: () => <AboutSection />,
};

/**
 * Decision 59: Settings is a page (`#/settings/<section>`), not a dialog. The settings navigation takes the sidebar's
 * place; the content is one centred column (780px) of group cards. Below 760px the navigation is a select on top and
 * rows stack their control under the text. Escape (outside a field with text) goes back.
 */
export function SettingsPage(props: { section: string; onBack(): void; connect(target: string): void; restart: (() => void) | undefined }) {
  const section = sectionOf(props.section);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const results = useMemo(() => searchSettings(query), [query]);
  const searchId = useId();
  const narrowSearchId = useId();
  const scroller = useRef<HTMLElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const { connect, restart, onBack } = props;
  const actions = useMemo<SettingsActions>(
    () => ({
      // "providers" from another section is a jump to the Providers section, not a sheet.
      connect: (t) => (t === "providers" ? void (window.location.hash = settingsHref("providers")) : connect(t)),
      restart,
    }),
    [connect, restart],
  );
  // Not while a dialog (the connect sheet) is open over the page, and not from a field: Esc there is the field's.
  useEscape(true, () => {
    const t = document.activeElement;
    if (document.querySelector('[aria-modal="true"]') || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
    onBack();
  });

  // A new section starts at the top; a search result scrolls its row into view and focuses its control.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [section]);
  useEffect(() => {
    if (!target) return;
    const id = window.setTimeout(() => {
      const row = document.getElementById(`row-${target}`);
      row?.scrollIntoView({ block: "center" });
      row?.querySelector<HTMLElement>("button, input, select, a[href]")?.focus({ preventScroll: true });
      setTarget(null);
    }, 120);
    return () => window.clearTimeout(id);
  }, [target, section]);

  const open = (r: IndexedRow) => {
    setQuery("");
    window.location.hash = settingsHref(r.section);
    setTarget(r.id);
  };

  return (
    <HarnessSettingsProvider>
      <SettingsActionsProvider value={actions}>
        <div data-settings className="flex h-full overflow-hidden bg-window text-fg">
          <SettingsNav section={section} searching={searching} query={query} onQuery={setQuery} onBack={onBack} searchId={searchId} />
          <main ref={scroller} aria-labelledby="settings-title" className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            <div
              className={cn(
                "mx-auto flex w-full flex-col gap-6 px-6 pt-8 pb-10 max-sm:px-4 max-sm:pt-4",
                isWideSection(section) && !searching ? "max-w-none" : "max-w-settings",
              )}
            >
              <div className="flex flex-col gap-3 settings:hidden">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="md" icon={ArrowLeft} onClick={onBack} className="-ml-2">
                    Back
                  </Button>
                  <span className="flex-1" />
                  <Select
                    aria-label="Section"
                    value={section}
                    onChange={(e) => (window.location.hash = settingsHref(sectionOf(e.target.value)))}
                    className="w-auto max-settings:w-auto"
                  >
                    {SECTIONS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <SearchField id={narrowSearchId} value={query} onChange={setQuery} />
              </div>
              <h1 id="settings-title" className="px-1 text-display font-medium text-fg">
                {searching ? "Search" : sectionLabel(section)}
              </h1>
              {searching ? <Results query={query} results={results} onOpen={open} /> : <div className="flex flex-col gap-6">{CONTENT[section]()}</div>}
            </div>
          </main>
        </div>
      </SettingsActionsProvider>
    </HarnessSettingsProvider>
  );
}

function Results({ query, results, onOpen }: { query: string; results: IndexedRow[]; onOpen(r: IndexedRow): void }) {
  if (results.length === 0)
    return (
      <p role="status" className="px-1 text-sm text-fg-3">
        No setting matches “{query.trim()}”. Try a shorter word, or pick a section.
      </p>
    );
  const sections = SECTIONS.filter((s) => results.some((r) => r.section === s.id));
  return (
    <div role="status" className="flex flex-col gap-6">
      {sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-2" aria-label={s.label}>
          <h2 className="px-1 text-xs text-fg-3">{s.label}</h2>
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel">
            {results
              .filter((r) => r.section === s.id)
              .map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    className="flex min-h-14 w-full flex-col items-start justify-center px-4 py-3 text-left press-row focus-inset hover:bg-hover"
                  >
                    <span className="text-base text-fg">{r.title}</span>
                    <span className="text-sm text-fg-3">{r.description}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
