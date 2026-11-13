import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "../Button";
import { FilterTabs } from "../FilterTabs";
import { ListRow } from "../ListRow";
import { DetailHeader, Panel, PanelBody, PanelEmpty, PanelFilters } from "../Panel";
import { SearchField } from "../SearchField";
import { ViewTabs } from "../ViewTabs";
import { Section } from "./parts";

type Filter = "all" | "open";
const VIEWS = [
  { id: "a", label: "Sessions" },
  { id: "b", label: "Knowledge" },
] as const;

/** Decision 95f: the one panel frame, in the two shapes tool tabs take (list with filters and views; empty). */
export function PanelSection() {
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"a" | "b">("a");
  const [query, setQuery] = useState("");
  return (
    <Section id="panel" title="Panel, PanelFilters, PanelBody, DetailHeader" note="Header 40, filter row 36, rows 32 or 40; edges at 8, text at 16.">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-96 overflow-hidden rounded-lg border border-line bg-panel">
          <Panel
            name="gallery-list"
            title="Sessions"
            meta="3"
            actions={
              <Button variant="secondary" size="sm" icon={Plus}>
                New session
              </Button>
            }
            filters={
              <PanelFilters>
                <FilterTabs<Filter>
                  bare
                  label="Filter"
                  options={[
                    { id: "all", label: "All" },
                    { id: "open", label: "Open", count: 2 },
                  ]}
                  value={filter}
                  onChange={setFilter}
                />
              </PanelFilters>
            }
          >
            <PanelBody>
              {[0, 1, 2].map((i) => (
                <ListRow key={i} size="md" title={`Row ${i + 1}`} description="Nov 12 · 5 exchanges" meta="Yesterday" onClick={() => undefined} />
              ))}
            </PanelBody>
          </Panel>
        </div>
        <div className="h-96 overflow-hidden rounded-lg border border-line bg-panel">
          <Panel
            name="gallery-views"
            title="Memory"
            filters={
              <PanelFilters>
                <SearchField label="Search" size="sm" value={query} onChange={setQuery} className="min-w-0 flex-1" />
              </PanelFilters>
            }
            views={<ViewTabs<"a" | "b"> label="Views" options={VIEWS} value={view} onChange={setView} />}
          >
            <PanelBody>
              <DetailHeader
                title="A detail header"
                meta="Nov 12 · 5 exchanges"
                actions={
                  <Button variant="quiet" size="sm">
                    Edit
                  </Button>
                }
              />
              <PanelEmpty>Nothing matches. Try one word.</PanelEmpty>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </Section>
  );
}
