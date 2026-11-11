import type { Bridge, ShellKind } from "@octo/agent-client";
import { HostProvider, type HostCapabilities } from "../state/host";
import { AppProvider } from "../state/app";
import { AppShell } from "./AppShell";
import { Tooltips } from "../components/primitives/Tooltips";
import { useInputModality } from "../lib/modality";

export type OctoAppProps = {
  bridge: Bridge;
  bridgeUrl: string;
  shell: ShellKind;
  demo?: boolean;
  host?: HostCapabilities;
};

export function OctoApp({ bridge, bridgeUrl, shell, demo = false, host }: OctoAppProps) {
  useInputModality();
  return (
    <HostProvider value={host ?? {}}>
      <AppProvider bridge={bridge} bridgeUrl={bridgeUrl} shell={shell} demo={demo}>
        <AppShell />
        <Tooltips />
      </AppProvider>
    </HostProvider>
  );
}
