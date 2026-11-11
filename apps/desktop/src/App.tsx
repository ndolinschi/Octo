import { OctoApp } from "@octo/ui";
import { useMemo } from "react";
import { bridgeLabel, chooseBridge } from "./bridgeChoice";
import { useBridge } from "./useBridge";

export default function App() {
  const search = window.location.search;
  const choice = useMemo(() => chooseBridge(search, import.meta.env), [search]);
  const bridge = useBridge(choice);
  if (!bridge) return null;
  return <OctoApp bridge={bridge} bridgeUrl={bridgeLabel(choice)} shell="desktop" demo={choice.kind === "demo"} />;
}
