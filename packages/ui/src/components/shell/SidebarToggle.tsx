import { PanelLeft } from "lucide-react";
import { useShell } from "../../state/shell";
import { IconButton } from "../primitives/Button";

/** "Show sidebar" at the start of the first panel's strip, at the same spot as "Hide sidebar" in the sidebar header. */
export function SidebarToggle() {
  const { sidebarOpen, toggleSidebar } = useShell();
  if (sidebarOpen) return null;
  return <IconButton icon={PanelLeft} label="Show sidebar" aria-expanded={false} onClick={toggleSidebar} />;
}

/** The strip of a panel that has no tabs (offline, no projects, load error): only the sidebar toggle. */
export function PanelBar() {
  const { sidebarOpen } = useShell();
  if (sidebarOpen) return null;
  return (
    <div data-strip className="flex shrink-0 items-center px-pane pt-pane">
      <SidebarToggle />
    </div>
  );
}
