import type { Bridge, ShellKind } from "@octo/agent-client";
import { HostProvider, type HostCapabilities } from "../state/host";
import { AppProvider } from "../state/app";
import { ChromeProvider, NO_CHROME, type WindowChrome } from "../state/chrome";
import { AppShell } from "./AppShell";
import { Tooltips } from "../components/primitives/Tooltips";
import { useInputModality } from "../lib/modality";

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
          <AppShell />
          <Tooltips />
        </AppProvider>
      </ChromeProvider>
    </HostProvider>
  );
}
