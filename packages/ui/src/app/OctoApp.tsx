import { lazy, Suspense } from "react";
import type { Bridge, ShellKind } from "@octo/agent-client";
import { HostProvider, type HostCapabilities } from "../state/host";
import { AppProvider } from "../state/app";
import { ChromeProvider, NO_CHROME, type WindowChrome } from "../state/chrome";
import { AppShell } from "./AppShell";
import { useInputModality } from "../lib/modality";

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
};

export function OctoApp({ bridge, bridgeUrl, shell, demo = false, host, chrome = NO_CHROME }: OctoAppProps) {
  useInputModality();
  return (
    <HostProvider value={host ?? {}}>
      <ChromeProvider value={chrome}>
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
      </ChromeProvider>
    </HostProvider>
  );
}
