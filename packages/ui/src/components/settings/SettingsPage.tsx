import { ArrowLeft, ChevronRight } from "lucide-react";
import { usePhone } from "../../lib/phone";
import { ON_YOUR_COMPUTER, sectionLocked } from "../../lib/remoteDevice";
import { useHost } from "../../state/host";
import { Notice } from "../primitives/Notice";
import { Glyph } from "../primitives/Glyph";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useEscape } from "../../lib/hooks";
import { useRowKeys } from "../../lib/hooksMore";
import { cn } from "../../lib/cn";
import { settingsHref } from "../../lib/route";
import { openShortcuts } from "../../lib/openShortcuts";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Card, ListFrame } from "../primitives/Card";
import { ListRow } from "../primitives/ListRow";
import { ScrollArea } from "../primitives/ScrollArea";
import { SearchField } from "../primitives/SearchField";
import { SectionHeader } from "../primitives/SectionHeader";
import { Select } from "../primitives/Select";
import { CommandsSection } from "./CommandsSection";
import { AppearanceSection, GeneralSection } from "./GeneralSection";
import { HarnessSettingsProvider } from "./harnessSettings";
import { ModelsSection } from "./ModelsSection";
import { SettingsActionsProvider, type SettingsActions } from "./pageContext";
import { PrivacySection } from "./PrivacySection";
import { RemoteAccessSection } from "./RemoteAccessSection";
import { EditorSection, MemorySection, UsageSection } from "./ProjectSections";
import { ProvidersSection } from "./ProvidersSection";
import { SettingsGroup, SettingsRow } from "./parts";
import { SettingsNav } from "./SettingsNav";
import { searchSettings, SECTIONS, sectionLabel, sectionOf, type IndexedRow, type SectionId } from "./settingsIndex";

/** Direction 7: the phone's section screen was opened from the list in this visit (its Back is then the history's). */
let fromList = false;

const IntegrationsView = lazy(() => import("./IntegrationsView").then((m) => ({ default: m.IntegrationsView })));

/** `projectId` is the project that was open when Settings was opened (null from Home): the per-project sections start on it. */
const CONTENT: Record<SectionId, (projectId: string | null) => ReactNode> = {
  general: () => <GeneralSection />,
  appearance: () => <AppearanceSection />,
  providers: () => <ProvidersSection />,
  models: (projectId) => <ModelsSection projectId={projectId} />,
  editor: (projectId) => <EditorSection projectId={projectId} />,
  integrations: () => (
    <Suspense fallback={<p className="h-9" aria-busy />}>
      <IntegrationsView />
    </Suspense>
  ),
  usage: (projectId) => <UsageSection projectId={projectId} />,
  memory: (projectId) => <MemorySection projectId={projectId} />,
  commands: (projectId) => <CommandsSection projectId={projectId} />,
  privacy: () => <PrivacySection />,
  remote: () => <RemoteAccessSection />,
  about: () => <AboutPage />,
};

/**
 * Decision 59: Settings is a page (`#/settings/<section>`), not a dialog. The settings navigation takes the sidebar's
 * place; the content is one centred column (880px, `settings-page`) of groups; the row sections use its left 660px (`settings-rows`). Below 760px the navigation is a select on top and
 * rows stack their control under the text. Escape (outside a field with text) goes back.
 */
export function SettingsPage(props: {
  section: string;
  onBack(): void;
  connect(target: string): void;
  restart: (() => void) | undefined;
  /** The project open in the app when Settings was opened; null from Home. */
  projectId?: string | null;
}) {
  const section = sectionOf(props.section);
  // Direction 7: on the phone `#/settings/` is the list of sections and a section is a screen of its own, Back between them.
  const phone = usePhone();
  const device = useHost().remoteDevice;
  const index = phone && props.section === "";
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const results = useMemo(() => searchSettings(query), [query]);
  const scroller = useRef<HTMLDivElement>(null);
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
    if (document.querySelector('[aria-modal="true"]') || t instanceof HTMLInputElement) return;
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
      row?.querySelector<HTMLElement>("button, input, a[href]")?.focus({ preventScroll: true });
      setTarget(null);
    }, 120);
    return () => window.clearTimeout(id);
  }, [target, section]);

  const backToSections = () => {
    if (fromList) window.history.back();
    else window.location.replace(settingsHref(""));
    fromList = false;
  };
  const open = (r: IndexedRow) => {
    setQuery("");
    window.location.hash = settingsHref(r.section);
    setTarget(r.id);
  };
  // S4: from the search field, ArrowDown goes to the first result and Enter opens it; arrows then move between results.
  const resultList = useRef<HTMLDivElement>(null);
  const searchKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!searching) return;
    if (e.key === "ArrowDown") {
      const first = resultList.current?.querySelector<HTMLElement>("[data-row]");
      if (!first) return;
      e.preventDefault();
      first.focus();
    } else if (e.key === "Enter" && results[0]) {
      e.preventDefault();
      open(results[0]);
    }
  };

  // S6: the window's title names the page while it is open.
  useEffect(() => {
    const before = document.title;
    document.title = "Settings · Octo";
    return () => {
      document.title = before;
    };
  }, []);

  return (
    <HarnessSettingsProvider>
      <SettingsActionsProvider value={actions}>
        <div data-settings className="flex h-full overflow-hidden bg-window text-fg">
          <SettingsNav section={section} searching={searching} query={query} onQuery={setQuery} onBack={onBack} onSearchKey={searchKeys} />
          <ScrollArea ref={scroller} role="main" aria-labelledby="settings-title" className="min-w-0 flex-1 overflow-x-hidden">
            <div
              // S1: one column for every section (Providers included) and one left edge (`settings-inset`) for the title, the
              // group captions and the rows' labels.
              className="mx-auto flex w-full max-w-settings-page flex-col gap-6 px-6 pt-8 pb-10 max-sm:px-4 max-sm:pt-4"
            >
              {phone && !index && !searching && (
                <Button variant="quiet" icon={ArrowLeft} onClick={backToSections} className="-ml-2 self-start">
                  Settings
                </Button>
              )}
              {index && <SearchField label="Search settings" value={query} onChange={setQuery} onKeyDown={searchKeys} />}
              {/* S4: under the floor the page's Back and the section menu are one header line, the search under it. */}
              <div className={cn("flex flex-col gap-2 settings:hidden", phone && "hidden")}>
                <div className="flex h-ctl-lg items-center gap-2">
                  <Button variant="quiet" icon={ArrowLeft} onClick={onBack} title="Back to the app" className="-ml-2 shrink-0">
                    Back
                  </Button>
                  <div className="ml-auto w-48 min-w-0">
                    <Select
                      label="Section"
                      value={section}
                      options={SECTIONS.filter((x) => !sectionLocked(device, x.id) || x.id === section).map((x) => ({ value: x.id, label: x.label }))}
                      onChange={(v) => (window.location.hash = settingsHref(sectionOf(v)))}
                    />
                  </div>
                </div>
                <SearchField label="Search settings" value={query} onChange={setQuery} onKeyDown={searchKeys} />
              </div>
              <h1 id="settings-title" className={cn("px-settings-inset text-display font-medium text-fg", index && !searching && "sr-only")}>
                {searching ? "Search" : index ? "Settings" : sectionLabel(section)}
              </h1>
              {index && !searching ? (
                <Card surface="panel" padding="sm">
                  {SECTIONS.map((x) =>
                    sectionLocked(device, x.id) ? (
                      // Remote access: what this device may not change stays listed, disabled, with where to change it.
                      <ListRow key={x.id} size="lg" title={x.label} description={ON_YOUR_COMPUTER} disabled />
                    ) : (
                      <ListRow
                        key={x.id}
                        size="lg"
                        title={x.label}
                        trailing={<Glyph icon={ChevronRight} size={16} className="text-fg-3" />}
                        trailingShown
                        onClick={() => {
                          fromList = true;
                          window.location.hash = settingsHref(x.id);
                        }}
                      />
                    ),
                  )}
                </Card>
              ) : searching ? (
                <Results query={query} results={results} onOpen={open} list={resultList} />
              ) : (
                // Cross-part leftovers (a): the row sections keep a reading measure (`settings-rows`) from the same left edge, so a
                // row's control sits near its label; Providers keeps the column for its list | detail surface.
                <div className={cn("flex flex-col gap-6", section !== "providers" && section !== "usage" && "max-w-settings-rows")}>
                  {sectionLocked(device, section) ? (
                    // Reached by a link or a search result: the harness would refuse every change here.
                    <Notice tone="info">{`${sectionLabel(section)} can't be changed from this device. ${ON_YOUR_COMPUTER}.`}</Notice>
                  ) : (
                    CONTENT[section](props.projectId ?? null)
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </SettingsActionsProvider>
    </HarnessSettingsProvider>
  );
}

/**
 * About: two groups named for what is in them (the page title already says "About"): the versions, and the help a person
 * can ask for. The app shows no version of its own: the host does not provide one (`HostCapabilities` has none).
 */
function AboutPage() {
  const { version, demo, bridgeUrl, shell } = useApp();
  return (
    <>
      <SettingsGroup label="Versions">
        <SettingsRow
          rowId="version"
          title="Harness version"
          description={demo ? "Demo data, in memory: no local service runs." : "The version of Octo's local service (the harness) this window uses."}
          control={<span className="text-sm text-fg-2 tabular-nums">{version ?? "Unknown"}</span>}
        />
        {/* S6: a sentence a person would write. */}
        <SettingsRow
          title="App"
          description={demo ? `The ${shell} app, running on demo data in memory.` : `The ${shell} app, connected to Octo's local service at ${bridgeUrl}.`}
        />
      </SettingsGroup>
      <SettingsGroup label="Help">
        <SettingsRow
          rowId="shortcuts"
          title="Keyboard shortcuts"
          description="Every shortcut in one list. Press ? anywhere outside a text field."
          control={<Button onClick={openShortcuts}>Show shortcuts</Button>}
        />
      </SettingsGroup>
    </>
  );
}

function Results({
  query,
  results,
  onOpen,
  list,
}: {
  query: string;
  results: IndexedRow[];
  onOpen(r: IndexedRow): void;
  list: RefObject<HTMLDivElement | null>;
}) {
  useRowKeys(list);
  if (results.length === 0)
    return (
      <p role="status" className="px-settings-inset text-sm text-fg-3">
        No setting matches “{query.trim()}”. Try a shorter word, or pick a section.
      </p>
    );
  const sections = SECTIONS.filter((s) => results.some((r) => r.section === s.id));
  return (
    <div ref={list} role="status" className="flex flex-col gap-6">
      {sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-1" aria-label={s.label}>
          <SectionHeader className="px-settings-inset">{s.label}</SectionHeader>
          <ListFrame className="px-2">
            {results
              .filter((r) => r.section === s.id)
              .map((r) => (
                <ListRow key={r.id} size="lg" title={r.title} description={r.description} onClick={() => onOpen(r)} />
              ))}
          </ListFrame>
        </section>
      ))}
    </div>
  );
}
