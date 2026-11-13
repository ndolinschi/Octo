import { Panel } from "../components/shell/Panel";
import { MemoryPanel } from "../components/memory/MemoryPanel";

/** Demo only (`?demo=1#/p/<id>/memory`): the Memory view on its own, for screenshots until it has a dock tab. */
export function MemoryRoute() {
  return (
    <Panel className="flex-1">
      <div className="min-h-0 flex-1">
        <MemoryPanel />
      </div>
    </Panel>
  );
}
