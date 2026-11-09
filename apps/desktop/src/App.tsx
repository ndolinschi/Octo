import { resolveBridgeUrl } from "@octo/agent-client";
import { OctoApp } from "@octo/ui";

export default function App() {
  return <OctoApp bridgeUrl={resolveBridgeUrl()} shell="desktop" />;
}
