import type { Bridge, ShellKind } from "@octo/agent-client";
import { AppProvider } from "../state/app";
import { AppShell } from "./AppShell";

export type OctoAppProps = {
  bridge: Bridge;
  bridgeUrl: string;
  shell: ShellKind;
  demo?: boolean;
};

export function OctoApp({ bridge, bridgeUrl, shell, demo = false }: OctoAppProps) {
  return (
    <AppProvider bridge={bridge} bridgeUrl={bridgeUrl} shell={shell} demo={demo}>
      <AppShell />
    </AppProvider>
  );
}
