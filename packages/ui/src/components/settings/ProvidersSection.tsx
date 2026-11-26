import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useHistoryLayer } from "../../lib/historyLayer";
import { usePhone } from "../../lib/phone";
import { defaultProviderId, providerGroups, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { ArrowLeft } from "lucide-react";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { SkeletonList } from "../primitives/Skeleton";
import { ProviderRows } from "../shared/providers/ProviderRows";
import { ProviderDetail } from "./ProviderDetail";
import { RouterSettings } from "./RouterSettings";
import { SettingsGroup } from "./parts";

/**
 * Decision 89: Providers is a list and a detail, as one group of the page (polish step 6a, S1): the caption says how many
 * are connected; the surface is split by a hairline into the fixed list column (groups, rows of one height) and the
 * detail of the selected provider, equal in height. Below the container's floor (`@2xl`) the page is the list alone and a row opens the detail with a back
 * control. Settings → Agents is gone: everything it showed is in the detail (89 f).
 */
export function ProvidersSection() {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const list = providers.status === "loading" ? null : providers.list;
  const [picked, setPicked] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [routerOpen, setRouterOpen] = useState(false);
  // A1.5: on the phone the detail is a history layer over the list, so the system Back (and the header's "←") closes it
  // and lands on the list, not on the list of sections; the header's "←" is its only back control there.
  const phone = usePhone();
  useHistoryLayer(phone && detailOpen, () => setDetailOpen(false));
  const openRouter = () => {
    setRouterOpen(true);
    window.setTimeout(() => document.getElementById("row-router-group")?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
  };
  const all = useMemo(() => list?.providers ?? [], [list]);
  const selected = all.find((p) => p.id === picked) ?? all.find((p) => p.id === defaultProviderId(all));
  const groups = providerGroups(all, { expanded, selectedId: selected?.id });
  const connected = list ? caption(list.connected) : "Providers";
  return (
    <>
      <SettingsGroup label={connected}>
        {providers.status === "loading" && <SkeletonList count={3} size="lg" twoLine />}
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
            {providers.message.replace(/\.$/, "")}. Check that Octo&apos;s local service is running, then retry.
          </Notice>
        )}
        {list && (
          // S1: one surface split by a hairline, list | detail, equal heights (the grid stretches both). Below the
          // container's floor (`@2xl`) it is the list alone, and a row opens the detail with a back control (89 e).
          <div className="@container/providers">
            <div className="grid min-w-0 @2xl/providers:grid-cols-[var(--spacing-settings-list)_minmax(0,1fr)]">
              <ProviderRows
                groups={groups}
                selectedId={selected?.id}
                framed={false}
                onSelect={(id) => {
                  setPicked(id);
                  setDetailOpen(true);
                }}
                onExpand={setExpanded}
                unpicked={!detailOpen}
                className={cn("min-w-0 @2xl/providers:border-r @2xl/providers:border-line", detailOpen ? "@max-2xl/providers:hidden" : "")}
              />
              {selected && (
                <div className={cn("flex min-w-0 flex-col", !detailOpen && "@max-2xl/providers:hidden")}>
                  <div className={cn("px-2 pt-2 @2xl/providers:hidden", phone && "hidden")}>
                    <Button variant="quiet" size="sm" icon={ArrowLeft} onClick={() => setDetailOpen(false)}>
                      Providers
                    </Button>
                  </div>
                  <ProviderDetail
                    key={selected.id}
                    provider={selected}
                    onRouter={openRouter}
                    onSelect={(id) => {
                      setPicked(id);
                      setDetailOpen(true);
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsGroup>
      <RouterSettings open={routerOpen} onOpen={setRouterOpen} />
    </>
  );
}

/** S1: the line that stood under the page is the group's caption (meta). */
const caption = (connected: number): string =>
  connected === 0 ? "Nothing connected yet" : `${connected === 1 ? "One provider" : `${connected} providers`} connected`;
