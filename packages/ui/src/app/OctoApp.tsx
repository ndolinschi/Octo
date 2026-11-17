import { lazy, Suspense, useLayoutEffect, useMemo } from "react";
import type { Bridge, ShellKind } from "@octo/agent-client";
import { HostProvider, type HostCapabilities } from "../state/host";
import { AppProvider } from "../state/app";
import { ChromeProvider, NO_CHROME, type WindowChrome } from "../state/chrome";
import { TabFlagsProvider, type TabFeatureOverrides } from "../state/tabFlags";
import { resolveTabFlags } from "../lib/tabFlags";
import { AppShell } from "./AppShell";
import { useInputModality } from "../lib/modality";
import { useMediaQuery } from "../lib/hooks";
import { PHONE_QUERY, PhoneContext } from "../lib/phone";

// Demo-only review page for the v7 components (`?demo=1#/__v7`); a separate chunk, never loaded otherwise.
const V7Gallery = lazy(() => import("../components/v7/Gallery").then((m) => ({ default: m.Gallery })));
// Demo-only component library gallery (`?demo=1&gallery=1`, decision 90); a separate chunk, never loaded otherwise.
const Gallery = lazy(() => import("../components/primitives/Gallery").then((m) => ({ default: m.Gallery })));
// The tooltip layer needs a hover first: its own chunk, fetched right after the first paint.
const Tooltips = lazy(() => import("../components/primitives/Tooltips").then((m) => ({ default: m.Tooltips })));
const loadDiffMonaco = () => import("../components/files/monaco");

export type OctoAppProps = {
  bridge: Bridge;
  bridgeUrl: string;
  shell: ShellKind;
  demo?: boolean;
  host?: HostCapabilities;
  /** The window frame the shell draws (decision 54); omitted: a browser, no overlay and no insets. */
  chrome?: WindowChrome;
  /** UI-only tool-tab feature flag overrides (merged over `DEFAULT_TAB_FLAGS`, before `?tabs=`). */
  tabs?: TabFeatureOverrides;
};

export function OctoApp({ bridge, bridgeUrl, shell, demo = false, host, chrome = NO_CHROME, tabs }: OctoAppProps) {
  useInputModality();
  // Direction 7: the one phone switch; `data-phone` drives the `phone:` CSS variant.
  const query = useMediaQuery(PHONE_QUERY);
  const phone = host?.layout ? host.layout === "phone" : query;
  const tabFlags = useMemo(() => resolveTabFlags(tabs, window.location.search), [tabs]);
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-phone", phone);
  }, [phone]);
  return (
    <PhoneContext.Provider value={phone}>
      <HostProvider value={host ?? {}}>
        <ChromeProvider value={chrome}>
          <TabFlagsProvider value={tabFlags}>
            <AppProvider bridge={bridge} bridgeUrl={bridgeUrl} shell={shell} demo={demo}>
              {demo && window.location.hash === "#/__v7" ? (
                <Suspense fallback={null}>
                  <V7Gallery loadMonaco={loadDiffMonaco} />
                </Suspense>
              ) : demo && new URLSearchParams(window.location.search).has("gallery") ? (
                <Suspense fallback={null}>
                  <Gallery />
                </Suspense>
              ) : (
                <AppShell />
              )}
              <Suspense fallback={null}>
                <Tooltips />
              </Suspense>
            </AppProvider>
          </TabFlagsProvider>
        </ChromeProvider>
      </HostProvider>
    </PhoneContext.Provider>
  );
}
