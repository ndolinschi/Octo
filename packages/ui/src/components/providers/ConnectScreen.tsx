import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { defaultProviderId, providerGroups, useProviders } from "../../lib/providers";
import { STREAK_BAND } from "../../lib/streakPresets";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { SkeletonList } from "../primitives/Skeleton";
import { StreakLayer } from "../primitives/StreakLayer";
import { ConnectDetail } from "../shared/providers/ConnectDetail";
import { ProviderRows } from "../shared/providers/ProviderRows";

/**
 * Decisions 53 b and 91b: with no provider connected, Home and "New project" show this instead of a project form. It is
 * the Providers list of Settings (same rows and groups): a row selects, the detail beside it (below it under the container
 * floor) carries the steps and the one action. The streak is a band at the top with nothing on it (decision 91a).
 */
export function ConnectScreen() {
  const { bridge, theme, backdrop } = useApp();
  const providers = useProviders(bridge);
  const list = providers.status === "loading" ? null : providers.list;
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const all = useMemo(() => list?.providers ?? [], [list]);
  const selected = all.find((p) => p.id === picked) ?? all.find((p) => p.id === defaultProviderId(all));
  const groups = providerGroups(all, { expanded, selectedId: selected?.id });
  return (
    <section aria-labelledby="connect-title" data-connect className="relative flex h-full flex-col overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_BAND} theme={theme} mono={backdrop === "mono"} />}
      <div aria-hidden className={cn("shrink-0", backdrop === "off" ? "h-6" : "h-(--octo-band-h)")} />
      <div data-start-scroll className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="@container mx-auto flex w-full max-w-connect flex-col gap-5 px-6 pt-2 pb-8 max-sm:px-4">
          <div className="flex flex-col gap-2 text-center">
            <h1 id="connect-title" className="text-display text-fg">
              <span className="octo-lead">Connect a provider</span> to start.
            </h1>
            <p className="text-sm text-fg-2">Octo runs models through an agent on this machine, an API key, or the Octo router. One is enough.</p>
          </div>
          {providers.status === "loading" && <SkeletonList count={4} size="lg" twoLine />}
          {providers.status === "error" && !list && (
            <Notice
              form="block"
              tone="error"
              title="Couldn't check this machine."
              actions={
                <Button size="sm" onClick={() => void providers.refresh()}>
                  Retry
                </Button>
              }
            >
              {providers.message.replace(/\.$/, "")}. Check that the harness is running.
            </Notice>
          )}
          {list && (
            // Decision 91b: list and detail side by side in one frame from 880px of content; below it the list is a page and a row
            // opens the detail as another page with a back control (as Settings → Providers on a phone).
            <div className="flex flex-col overflow-hidden rounded-xl border border-panel-edge bg-panel shadow-panel @min-[880px]:flex-row @min-[880px]:items-start">
              <ProviderRows
                framed={false}
                groups={groups}
                selectedId={selected?.id}
                onSelect={(id) => {
                  setPicked(id);
                  setDetailOpen(true);
                }}
                onExpand={setExpanded}
                className={cn("w-full shrink-0 @min-[880px]:w-72 @min-[880px]:border-r @min-[880px]:border-line", detailOpen && "@max-[879px]:hidden")}
              />
              {selected && (
                <div className={cn("flex min-w-0 flex-1 flex-col", !detailOpen && "@max-[879px]:hidden")}>
                  <div className="px-2 pt-2 @min-[880px]:hidden">
                    <Button variant="quiet" size="sm" icon={ChevronLeft} onClick={() => setDetailOpen(false)}>
                      Providers
                    </Button>
                  </div>
                  <ConnectDetail key={selected.id} provider={selected} framed={false} />
                </div>
              )}
            </div>
          )}
          <p className="text-center text-xs text-fg-3">The first provider you connect runs new projects. Change it later in Settings → Models.</p>
        </div>
      </div>
    </section>
  );
}
