import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { defaultProviderId, providerGroups, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { ArrowLeft } from "lucide-react";
import { Button } from "../primitives/Button";
import { ListFrame } from "../primitives/Card";
import { Notice } from "../primitives/Notice";
import { SkeletonList } from "../primitives/Skeleton";
import { ProviderRows } from "../shared/providers/ProviderRows";
import { ProviderDetail } from "./ProviderDetail";
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
          <ListFrame>
            <SkeletonList count={3} size="lg" twoLine />
          </ListFrame>
        )}
        {providers.status === "error" && (
          <Notice
            form="block"
            tone="error"
            title="Couldn't load providers"
            actions={
              <Button size="sm" onClick={() => void providers.refresh()}>
                Retry
              </Button>
            }
          >
            {providers.message.replace(/\.$/, "")}. Check that the harness is running, then retry.
          </Notice>
        )}
        {list && (
          <div className="flex items-start gap-4">
            <ProviderRows
              groups={groups}
              selectedId={selected?.id}
              onSelect={(id) => {
                setPicked(id);
                setDetailOpen(true);
              }}
              onExpand={setExpanded}
              className={cn("w-full shrink-0 @3xl:w-72", detailOpen ? "@max-3xl:hidden" : "")}
            />
            {selected && (
              <div className={cn("flex min-w-0 flex-1 flex-col gap-3", !detailOpen && "@max-3xl:hidden")}>
                <Button variant="quiet" size="sm" icon={ArrowLeft} onClick={() => setDetailOpen(false)} className="self-start @3xl:hidden">
                  Providers
                </Button>
                <ProviderDetail key={selected.id} provider={selected} />
              </div>
            )}
          </div>
        )}
        {list && <p className="px-2 text-xs text-fg-3">{footer(list.connected)}</p>}
      </div>
      <RouterSettings />
    </>
  );
}

const footer = (connected: number): string =>
  connected === 0
    ? "Nothing is connected: connect one provider to create projects."
    : `${connected === 1 ? "One provider" : `${connected} providers`} connected. Model pickers list only what these can run.`;
