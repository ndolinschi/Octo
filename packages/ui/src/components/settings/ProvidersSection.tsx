import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { defaultProviderId, providerGroups, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { SkeletonRow } from "./parts";
import { ProviderDetail } from "./ProviderDetail";
import { ProviderList } from "./ProviderList";
import { RouterSettings } from "./RouterSettings";

/**
 * Decision 89: Providers is a list and a detail at the full width of the settings page. Left, the fixed list column
 * (groups, rows of one height); right, the detail of the selected provider, top-aligned with the list in the same
 * hairline frame. Below the container's floor (`@3xl`) the page is the list alone and a row opens the detail with a back
 * control. Settings → Agents is gone: everything it showed is in the detail (89 f).
 */
export function ProvidersSection() {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const list = providers.status === "loading" ? null : providers.list;
  const [picked, setPicked] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const all = useMemo(() => list?.providers ?? [], [list]);
  const selected = all.find((p) => p.id === picked) ?? all.find((p) => p.id === defaultProviderId(all));
  const groups = providerGroups(all, { expanded, selectedId: selected?.id });
  return (
    <>
      <div className="@container flex flex-col gap-2">
        {providers.status === "loading" && (
          <div className="overflow-hidden rounded-lg border border-panel-edge bg-panel">
            {[0, 1, 2].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}
        {providers.status === "error" && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-panel-edge bg-panel p-4 text-sm text-fg-2">
            <span className="min-w-0 flex-1">
              <span className="text-err">Couldn&apos;t load providers.</span> {providers.message.replace(/\.$/, "")}. Check that the harness is running, then
              retry.
            </span>
            <Button size="sm" onClick={() => void providers.refresh()}>
              Retry
            </Button>
          </div>
        )}
        {list && (
          <div className="flex items-start gap-4">
            <ProviderList
              groups={groups}
              selectedId={selected?.id}
              onSelect={(id) => {
                setPicked(id);
                setDetailOpen(true);
              }}
              onExpand={setExpanded}
              className={cn("w-full shrink-0 @3xl:w-72", detailOpen ? "max-@3xl:hidden" : "")}
            />
            {selected && (
              <div className={cn("flex min-w-0 flex-1 flex-col gap-3", !detailOpen && "max-@3xl:hidden")}>
                <button type="button" onClick={() => setDetailOpen(false)} className="h-7 w-fit rounded-sm px-1 text-sm text-fg-3 hover:text-fg @3xl:hidden">
                  ← Providers
                </button>
                <ProviderDetail key={selected.id} provider={selected} />
              </div>
            )}
          </div>
        )}
        {list && <p className="px-1 text-xs text-fg-3">{footer(list.connected)}</p>}
      </div>
      <RouterSettings />
    </>
  );
}

const footer = (connected: number): string =>
  connected === 0
    ? "Nothing is connected: connect one provider to create projects."
    : `${connected === 1 ? "One provider" : `${connected} providers`} connected. Model pickers list only what these can run.`;
